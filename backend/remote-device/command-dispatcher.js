"use strict";

const { randomUUID } = require("node:crypto");
const { checkCommand } = require("./policy");
const { limitOutput, decodeBase64, MAX_ATTACHMENT_BYTES } = require("./protocol");

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

class CommandDispatcher {
  constructor(registry, options = {}) {
    this.registry = registry;
    this.pending = new Map();
    this.now = options.now || Date.now;
  }

  dispatch(deviceId, tool, args, timeoutMs = 10000) {
    const allowed = checkCommand(tool, args);
    const session = this.registry.session(deviceId);
    if (!session?.registered || session.ws.readyState !== 1 ||
        this.registry.describe(deviceId, this.now())?.status !== "online") {
      throw new DeviceError("DEVICE_OFFLINE");
    }
    if (!session.capabilities?.includes(allowed.capability)) {
      throw new DeviceError("CAPABILITY_NOT_ALLOWED");
    }
    if (allowed.tool === "filesystem" && !session.roots?.includes(allowed.args.root)) {
      throw new DeviceError("ROOT_NOT_ALLOWED");
    }
    for (const pending of this.pending.values()) {
      if (pending.deviceId === deviceId) throw new DeviceError("DEVICE_BUSY");
    }
    const id = "cmd-" + randomUUID();
    const timeout = Number(timeoutMs);
    if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 30000) {
      throw new DeviceError("INVALID_TIMEOUT");
    }
    const sentAt = this.now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DeviceError("COMMAND_TIMEOUT"));
      }, timeout);
      timer.unref?.();
      this.pending.set(id, {
        deviceId, session, resolve, reject, timer, sentAt,
        capability: allowed.capability, tool: allowed.tool,
      });
      try {
        session.ws.send(JSON.stringify({
          v: 1, type: "command", id, tool: allowed.tool,
          args: allowed.args, timeout_ms: timeout,
        }), (error) => {
          if (error) this.fail(id, "DEVICE_DISCONNECTED");
        });
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
        if (pending.capability !== "filesystem.read" || typeof value.mime !== "string" ||
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
      ? Math.min(30000, Math.floor(suppliedDuration))
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
    pending.reject(new DeviceError(code));
  }

  disconnect(session) {
    for (const [id, pending] of this.pending) {
      if (pending.session === session) this.fail(id, "DEVICE_DISCONNECTED");
    }
  }
}

module.exports = { CommandDispatcher, DeviceError };
