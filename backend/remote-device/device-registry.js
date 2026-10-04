"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const {
  validDeviceId, validateCapabilityList, validateRootList, LEGACY_CAPABILITIES,
} = require("./protocol");

class DeviceRegistry {
  constructor(options = {}) {
    this.definitions = new Map();
    this.sessions = new Map();
    this.observations = new Map();
    this.file = options.file || null;
    for (const entry of options.devices || []) this.add(entry);
    if (this.file && fs.existsSync(this.file)) {
      const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      for (const entry of data.devices || []) this.add(entry);
    }
  }

  add(entry) {
    if (!entry || typeof entry !== "object" || !validDeviceId(entry.device_id) ||
        !/^[a-f0-9]{64}$/i.test(entry.token_sha256 || "")) {
      throw new Error("invalid device configuration");
    }
    let capabilities;
    let allowedRoots;
    try {
      // Existing devices.json files predate capability negotiation. They must
      // remain hostname-compatible but must not accidentally gain file/screen
      // access after an upgrade.
      capabilities = entry.capabilities === undefined
        ? [...LEGACY_CAPABILITIES]
        : validateCapabilityList(entry.capabilities);
      allowedRoots = entry.allowed_roots === undefined
        ? []
        : validateRootList(entry.allowed_roots);
    } catch {
      throw new Error("invalid device configuration");
    }
    this.definitions.set(entry.device_id, {
      deviceId: entry.device_id,
      label: String(entry.label || entry.device_id).slice(0, 100),
      customerName: String(entry.customer_name || "").slice(0, 100),
      tokenHash: entry.token_sha256.toLowerCase(),
      capabilities,
      allowedRoots,
    });
  }

  definition(deviceId) {
    return this.definitions.get(deviceId) || null;
  }

  negotiate(deviceId, declaredCapabilities, declaredRoots) {
    const definition = this.definitions.get(deviceId);
    if (!definition) return { capabilities: [], roots: [] };
    const capabilities = new Set(declaredCapabilities || ["system.hostname"]);
    const roots = new Set(declaredRoots || []);
    return {
      capabilities: definition.capabilities.filter((capability) => capabilities.has(capability)),
      roots: definition.allowedRoots.filter((root) => roots.has(root)),
    };
  }

  authenticate(deviceId, token) {
    const definition = this.definitions.get(deviceId);
    if (!definition || typeof token !== "string" || token.length < 24 || token.length > 512) return false;
    const actual = crypto.createHash("sha256").update(token).digest();
    const expected = Buffer.from(definition.tokenHash, "hex");
    return crypto.timingSafeEqual(actual, expected);
  }

  replace(deviceId, session) {
    const previous = this.sessions.get(deviceId);
    this.sessions.set(deviceId, session);
    return previous || null;
  }

  remove(deviceId, session) {
    if (this.sessions.get(deviceId) !== session) return false;
    this.observations.set(deviceId, {
      hostname: session.hostname, agentVersion: session.agentVersion, lastSeen: session.lastSeen,
      capabilities: [...(session.capabilities || [])], roots: [...(session.roots || [])],
    });
    this.sessions.delete(deviceId);
    return true;
  }

  session(deviceId) {
    return this.sessions.get(deviceId) || null;
  }

  describe(deviceId, now = Date.now()) {
    const definition = this.definitions.get(deviceId);
    if (!definition) return null;
    const session = this.sessions.get(deviceId);
    const online = Boolean(session?.registered && session.ws.readyState === 1 &&
      now - session.lastSeen < 60000);
    const observed = session || this.observations.get(deviceId);
    return {
      device_id: deviceId,
      label: definition.label,
      customer_name: definition.customerName,
      status: online ? "online" : "offline",
      hostname: observed?.hostname || null,
      agent_version: observed?.agentVersion || null,
      last_seen: observed?.lastSeen ? new Date(observed.lastSeen).toISOString() : null,
      capabilities: session?.capabilities || observed?.capabilities || [],
      allowed_roots: session?.roots || observed?.roots || [],
    };
  }

  list(now = Date.now()) {
    return [...this.definitions.keys()].sort().map((id) => this.describe(id, now));
  }
}

module.exports = { DeviceRegistry };
