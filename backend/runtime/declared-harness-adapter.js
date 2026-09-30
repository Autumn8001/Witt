"use strict";

const { capabilities } = require("./capabilities");

class DeclaredHarnessAdapter {
  constructor({ id, displayName, capabilityOverrides = {}, unavailableReason }) {
    this.id = id;
    this.displayName = displayName;
    this.capabilityOverrides = capabilityOverrides;
    this.unavailableReason = unavailableReason
      || `${displayName} runtime is not configured on this host`;
  }

  getCapabilities() {
    return capabilities(this.capabilityOverrides);
  }

  async startRuntime() {
    throw new Error(this.unavailableReason);
  }

  stopRuntime() {}

  createSession() { return this.startRuntime(); }
  resumeSession() { return this.startRuntime(); }
  sendPrompt() { return this.startRuntime(); }
  cancel() { return this.startRuntime(); }
  approve() { throw new Error(this.unavailableReason); }
  deny() { throw new Error(this.unavailableReason); }
  streamEvents() { return () => {}; }
  listModels() { return Promise.resolve({ data: [] }); }
  listTools() { return Promise.resolve({ data: [] }); }
  shutdownSession() { return { ok: true, harness: this.id }; }
}

module.exports = { DeclaredHarnessAdapter };
