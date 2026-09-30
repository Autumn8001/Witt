"use strict";

const DEFAULT_IDLE_MS = 30 * 60 * 1000;

class HarnessRuntimeManager {
  constructor(options = {}) {
    this.idleMs = Number(options.idleMs || process.env.WITT_HARNESS_IDLE_MS || DEFAULT_IDLE_MS);
    this.now = options.now || Date.now;
    this.runtimes = new Map();
  }

  keyFor(harnessId, scope = "default") {
    return `${harnessId}:${scope}`;
  }

  register(harnessId, scope, adapter) {
    const key = this.keyFor(harnessId, scope);
    const current = this.runtimes.get(key);
    if (current && !current.stopped) return current;
    const record = {
      key, harnessId, scope, adapter,
      sessions: new Set(),
      healthy: false,
      startedAt: null,
      lastUsedAt: this.now(),
      stopped: false,
      crashes: 0,
    };
    this.runtimes.set(key, record);
    return record;
  }

  async start(harnessId, scope, adapter) {
    const record = this.register(harnessId, scope, adapter);
    await record.adapter.startRuntime();
    record.healthy = true;
    record.startedAt = record.startedAt || this.now();
    record.lastUsedAt = this.now();
    record.stopped = false;
    return record;
  }

  touch(harnessId, scope) {
    const record = this.runtimes.get(this.keyFor(harnessId, scope));
    if (record) record.lastUsedAt = this.now();
    return record || null;
  }

  bindSession(harnessId, scope, sessionId) {
    const record = this.runtimes.get(this.keyFor(harnessId, scope));
    if (!record) return null;
    record.sessions.add(String(sessionId));
    record.lastUsedAt = this.now();
    return record;
  }

  releaseSession(harnessId, scope, sessionId) {
    const record = this.runtimes.get(this.keyFor(harnessId, scope));
    if (!record) return null;
    record.sessions.delete(String(sessionId));
    record.lastUsedAt = this.now();
    return record;
  }

  markCrash(harnessId, scope) {
    const record = this.runtimes.get(this.keyFor(harnessId, scope));
    if (!record) return null;
    record.healthy = false;
    record.crashes += 1;
    record.lastUsedAt = this.now();
    return record;
  }

  reapIdle(at = this.now()) {
    const stopped = [];
    for (const record of this.runtimes.values()) {
      if (record.stopped || record.sessions.size) continue;
      if (at - record.lastUsedAt < this.idleMs) continue;
      record.adapter.stopRuntime();
      record.stopped = true;
      record.healthy = false;
      stopped.push(record.key);
    }
    return stopped;
  }

  status() {
    return [...this.runtimes.values()].map((record) => ({
      key: record.key,
      harnessId: record.harnessId,
      healthy: record.healthy,
      sessions: record.sessions.size,
      crashes: record.crashes,
      stopped: record.stopped,
      idleMs: Math.max(0, this.now() - record.lastUsedAt),
    }));
  }
}

module.exports = { HarnessRuntimeManager, DEFAULT_IDLE_MS };
