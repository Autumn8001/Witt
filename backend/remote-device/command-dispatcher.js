"use strict";

const { randomUUID } = require("node:crypto");
const { checkCommand } = require("./policy");
const {
  isPlainObject, validRootAlias, limitOutput, decodeBase64, MAX_ATTACHMENT_BYTES, MAX_MESSAGE_BYTES,
  WORKSPACE_CAPABILITIES,
} = require("./protocol");

const MUTATING_WORKSPACE_CAPABILITIES = new Set([
  "workspace.write", "workspace.patch", "workspace.exec",
]);
const MAX_WORKSPACE_ARGS_BYTES = Math.min(1024 * 1024, MAX_MESSAGE_BYTES - 16 * 1024);
const MAX_WORKSPACE_CONTEXT_BYTES = 8 * 1024;

class DeviceError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function redactSystemInfo(stdout) {
  const raw = String(stdout || "");
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return raw;
    const clean = (item) => {
      if (Array.isArray(item)) return item.map(clean);
      if (!item || typeof item !== "object") return item;
      const result = {};
      for (const [key, child] of Object.entries(item)) {
        // System info is intentionally metadata-only. Never echo a real home,
        // root, directory, path, token, or secret field through the API/MCP.
        const normalizedKey = key.replace(/[^A-Za-z0-9]+/g, "_").toLowerCase();
        if (/(?:home|root|directory|path|token|secret|password)/.test(normalizedKey)) continue;
        result[key] = clean(child);
      }
      return result;
    };
    return JSON.stringify(clean(value));
  } catch {
    return raw;
  }
}

function invalidArguments() {
  throw new DeviceError("INVALID_ARGUMENTS");
}

// The remote-workspace service owns operation-specific validation and root
// binding. The transport only admits a bounded JSON envelope so it can carry
// structured requests without becoming a second policy engine.
function cloneStructuredArgs(args) {
  if (!isPlainObject(args)) invalidArguments();
  let encoded;
  try { encoded = JSON.stringify(args); } catch { invalidArguments(); }
  if (typeof encoded !== "string" || Buffer.byteLength(encoded, "utf8") > MAX_WORKSPACE_ARGS_BYTES) {
    invalidArguments();
  }
  try { return JSON.parse(encoded); } catch { invalidArguments(); }
}

function cloneContext(value, maxBytes) {
  if (!isPlainObject(value)) invalidArguments();
  let encoded;
  try { encoded = JSON.stringify(value); } catch { invalidArguments(); }
  if (typeof encoded !== "string" || Buffer.byteLength(encoded, "utf8") > maxBytes) invalidArguments();
  try { return JSON.parse(encoded); } catch { invalidArguments(); }
}

function checkWorkspaceCommand(args, context) {
  const structuredArgs = cloneStructuredArgs(args);
  const capability = structuredArgs.operation;
  if (typeof capability !== "string" || !WORKSPACE_CAPABILITIES.includes(capability)) {
    throw new DeviceError("COMMAND_NOT_ALLOWED");
  }
  // system_info is host scoped; every other workspace action names an alias.
  // This verifies only shape, deliberately not whether the device grants that
  // alias: workspace binding is checked by the service and again by the agent.
  if (capability !== "workspace.system_info" && !validRootAlias(structuredArgs.root)) {
    invalidArguments();
  }
  if (context === undefined) context = {};
  if (!isPlainObject(context) || Object.keys(context).some((key) => key !== "workspaceSessionId" && key !== "approval")) {
    invalidArguments();
  }
  const result = { tool: "workspace", capability, args: structuredArgs, context: {} };
  if (context.workspaceSessionId !== undefined) {
    if (typeof context.workspaceSessionId !== "string" || context.workspaceSessionId.length === 0 ||
        context.workspaceSessionId.length > 100 || context.workspaceSessionId.includes("\0")) invalidArguments();
    result.context.workspaceSessionId = context.workspaceSessionId;
  }
  if (context.approval !== undefined) result.context.approval = cloneContext(context.approval, MAX_WORKSPACE_CONTEXT_BYTES);
  return result;
}

function allowedCommand(tool, args, context) {
  return tool === "workspace" ? checkWorkspaceCommand(args, context) : checkCommand(tool, args);
}

class CommandDispatcher {
  constructor(registry, options = {}) {
    this.registry = registry;
    this.pending = new Map();
    this.now = options.now || Date.now;
    this.authorizeCommand = options.authorizeCommand || (() => {});
  }

  // Workspace callers use:
  // dispatch(deviceId, "workspace", structuredArgs, timeoutMs,
  //   { workspaceSessionId, approval })
  // The fifth argument is transport metadata; it never changes the business
  // arguments or authorizes a root on its own.
  dispatch(deviceId, tool, args, timeoutMs = 10000, context = undefined) {
    const allowed = allowedCommand(tool, args, context);
    this.authorizeCommand(deviceId, allowed);
    const session = this.registry.session(deviceId);
    if (!session?.registered || session.ws.readyState !== 1 ||
        this.registry.describe(deviceId, this.now())?.status !== "online") {
      throw new DeviceError("DEVICE_OFFLINE");
    }
    if (!session.capabilities?.includes(allowed.capability)) {
      throw new DeviceError("CAPABILITY_NOT_ALLOWED");
    }
    if ((allowed.tool === "filesystem" ||
        (allowed.tool === "workspace" && allowed.capability !== "workspace.system_info")) &&
        !session.roots?.includes(allowed.args.root)) {
      throw new DeviceError("ROOT_NOT_ALLOWED");
    }
    for (const pending of this.pending.values()) {
      if (pending.deviceId === deviceId) throw new DeviceError("DEVICE_BUSY");
    }
    const id = "cmd-" + randomUUID();
    const timeout = Number(timeoutMs);
    const maxTimeout = deviceId.startsWith("assist-") && allowed.capability === "workspace.exec" ? 360000 : 30000;
    if (!Number.isInteger(timeout) || timeout < 1000 || timeout > maxTimeout) {
      throw new DeviceError("INVALID_TIMEOUT");
    }
    const sentAt = this.now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(id, "COMMAND_TIMEOUT"), timeout);
      timer.unref?.();
      this.pending.set(id, {
        deviceId, session, resolve, reject, timer, sentAt,
        capability: allowed.capability, tool: allowed.tool,
        sent: false,
        executionMayBeUnknown: allowed.tool === "workspace" && MUTATING_WORKSPACE_CAPABILITIES.has(allowed.capability),
      });
      try {
        const command = {
          v: 1, type: "command", id, tool: allowed.tool,
          args: allowed.args, timeout_ms: timeout,
        };
        if (allowed.tool === "workspace" && allowed.context.workspaceSessionId) {
          command.workspace_session_id = allowed.context.workspaceSessionId;
        }
        if (allowed.tool === "workspace" && allowed.context.approval) {
          command.approval = allowed.context.approval;
        }
        session.ws.send(JSON.stringify(command), (error) => {
          if (error) this.fail(id, "DEVICE_DISCONNECTED");
        });
        // ws.send returning means the command was accepted by the socket
        // implementation. A later timeout/disconnect cannot prove whether a
        // mutating operation ran on the customer device.
        const pending = this.pending.get(id);
        if (pending) pending.sent = true;
      } catch {
        this.fail(id, "DEVICE_DISCONNECTED");
      }
    });
  }

  result(session, value) {
    const pending = this.pending.get(value.id);
    if (!pending || pending.session !== session || pending.deviceId !== value.device_id) return false;
    this.pending.delete(value.id);
    clearTimeout(pending.timer);
    let attachment = null;
    try {
      const hasData = value.data !== undefined || value.mime !== undefined;
      if (value.error && !hasData) {
        // A device may report an operational failure (for example, no
        // interactive desktop) without an attachment. Preserve that bounded
        // error instead of misclassifying it as malformed image data.
      } else if (pending.capability === "screen.capture") {
        if (value.mime !== "image/jpeg" || typeof value.data !== "string") {
          throw new DeviceError("INVALID_ATTACHMENT");
        }
        const bytes = decodeBase64(value.data, MAX_ATTACHMENT_BYTES);
        attachment = { mime: "image/jpeg", data: bytes.toString("base64") };
      } else if (hasData) {
        if (!["filesystem.read", "workspace.read_image"].includes(pending.capability) || typeof value.mime !== "string" ||
            value.mime.length === 0 || value.mime.length > 100 || !/^[\w.+-]+\/[\w.+-]+$/.test(value.mime) ||
            typeof value.data !== "string") {
          throw new DeviceError("INVALID_ATTACHMENT");
        }
        const bytes = decodeBase64(value.data, MAX_ATTACHMENT_BYTES);
        attachment = { mime: value.mime, data: bytes.toString("base64") };
      }
    } catch (error) {
      this.pending.delete(value.id);
      clearTimeout(pending.timer);
      pending.reject(new DeviceError(error.code || "INVALID_ATTACHMENT"));
      return true;
    }
    const output = limitOutput(
      pending.capability === "system.info" ? redactSystemInfo(value.stdout) : value.stdout,
      value.stderr,
    );
    const suppliedDuration = Number(value.duration_ms);
    const durationMs = Number.isFinite(suppliedDuration) && suppliedDuration >= 0
      ? Math.min(pending.capability === "workspace.exec" && pending.deviceId.startsWith("assist-") ? 360000 : 30000, Math.floor(suppliedDuration))
      : Math.max(0, this.now() - pending.sentAt);
    pending.resolve({
      v: 1, type: "result", id: value.id, device_id: pending.deviceId,
      exit_code: Number.isInteger(value.exit_code) ? value.exit_code : 1,
      ...output, truncated: output.truncated || value.truncated === true, duration_ms: durationMs,
      ...(value.error ? { error: String(value.error).slice(0, 100) } : {}),
      ...(attachment || {}),
    });
    return true;
  }

  fail(id, code) {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    const uncertain = pending.executionMayBeUnknown && pending.sent &&
      (code === "DEVICE_DISCONNECTED" || code === "COMMAND_TIMEOUT");
    pending.reject(new DeviceError(uncertain ? "EXECUTION_STATE_UNKNOWN" : code));
  }

  disconnect(session) {
    for (const [id, pending] of this.pending) {
      if (pending.session === session) this.fail(id, "DEVICE_DISCONNECTED");
    }
  }
}

module.exports = { CommandDispatcher, DeviceError };
