"use strict";

const { AppServerClient, sharedAppServer } = require("../app-server-client");
const { CODEX_CAPABILITIES } = require("./capabilities");

class CodexHarnessAdapter {
  constructor(options = {}) {
    this.id = "codex";
    this.displayName = "Codex";
    this.codexBin = options.codexBin;
    this.cwd = options.cwd;
    this.home = options.home || "/home/ubuntu";
    this.codexHome = options.codexHome || "";
    this.configOverrides = options.configOverrides || [];
    this.clientScope = options.clientScope;
    this.client = options.client || null;
  }

  getCapabilities() {
    return { ...CODEX_CAPABILITIES };
  }

  open() {
    if (!this.client) {
      this.client = sharedAppServer({
        codexBin: this.codexBin,
        cwd: this.cwd,
        home: this.home,
        codexHome: this.codexHome,
        configOverrides: this.configOverrides,
        clientScope: this.clientScope,
      });
    }
    return this.client;
  }

  async startRuntime() {
    const client = this.open();
    await client.start();
    return client;
  }

  stopRuntime() {
    this.client?.close();
  }

  streamEvents(listener) {
    const client = this.open();
    client.on("notification", listener);
    return () => client.off("notification", listener);
  }

  createSession(params) {
    return this.open().request("thread/start", params);
  }

  resumeSession(params) {
    return this.open().request("thread/resume", params);
  }

  sendPrompt(params) {
    return this.open().request("turn/start", params);
  }

  cancel(params) {
    return this.open().request("turn/interrupt", params);
  }

  approve(id, result) {
    this.open().respond(id, result);
  }

  deny(id, result = { decision: "decline" }) {
    this.open().respond(id, result);
  }

  listModels() {
    return this.open().request("model/list", { limit: 100, includeHidden: false });
  }

  listTools() {
    return this.open().request("mcpServerStatus/list", {
      limit: 100, detail: "toolsAndAuthOnly",
    });
  }

  shutdownSession() {
    return { ok: true, harness: this.id };
  }
}

module.exports = { CodexHarnessAdapter, AppServerClient };
