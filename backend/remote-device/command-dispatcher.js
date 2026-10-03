"use strict";

const { randomUUID } = require("node:crypto");
const { checkCommand } = require("./policy");
const { limitOutput } = require("./protocol");

class DeviceError extends Error {
  constructor(code) { super(code); this.code = code; }
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
    for (const pending of this.pending.values()) {
      if (pending.deviceId === deviceId) throw new DeviceError("DEVICE_BUSY");
    }
    const id = "cmd-" + randomUUID();
    const timeout = Math.min(30000, Math.max(1000, Number(timeoutMs) || 10000));
    const sentAt = this.now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DeviceError("COMMAND_TIMEOUT"));
      }, timeout);
      timer.unref?.();
      this.pending.set(id, { deviceId, session, resolve, reject, timer, sentAt });
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
    const output = limitOutput(value.stdout, value.stderr);
    pending.resolve({
      v: 1, type: "result", id: value.id, device_id: pending.deviceId,
      exit_code: Number.isInteger(value.exit_code) ? value.exit_code : 1,
      ...output, truncated: output.truncated || value.truncated === true, duration_ms: Math.max(0, Number(value.duration_ms) || this.now() - pending.sentAt),
      ...(value.error ? { error: String(value.error).slice(0, 100) } : {}),
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
