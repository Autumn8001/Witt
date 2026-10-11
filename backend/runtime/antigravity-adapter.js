"use strict";

const { EventEmitter } = require("node:events");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const { HarnessProcess } = require("./harness-process");
const { parseAntigravityEvent } = require("./event-parsers");
const { ANTIGRAVITY_CAPABILITIES } = require("./capabilities");
const { resolveBinary } = require("./runtime-binaries");
const { RuntimeLogger } = require("./runtime-log");

const HARNESS_ID = "google-antigravity";

// The published agy build (1.2.14) is compiled with pclmul enabled and aborts with
// SIGILL on CPUs without the PCLMULQDQ feature. QEMU's default vCPU has no pclmulqdq,
// so this host cannot run it at all. Detect it precisely instead of reporting a
// generic failure.
const PCLMUL_MARKER = /pclmul/i;

function run(bin, args, options = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: options.timeoutMs || 30000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error?.code ?? 0,
          signal: error?.signal ?? null,
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
        });
      });
  });
}

function hostHasPclmul() {
  try {
    const cpuinfo = fs.readFileSync("/proc/cpuinfo", "utf8");
    return /(^|\s)pclmulqdq(\s|$)/m.test(cpuinfo);
  } catch {
    // Non-Linux or unreadable: do not assert anything about the CPU.
    return null;
  }
}

class AntigravityAdapter {
  /**
   * @param {object} options
   * @param {string} [options.bin]           agy executable
   * @param {string} [options.model]         model slug (see `agy models`)
   * @param {string} [options.effort]        low | medium | high
   * @param {string} [options.cwd]
   * @param {string} [options.apiKeyEnv]     env var name for the Gemini-compatible key
   * @param {string} [options.apiKeyValue]
   * @param {string} [options.baseUrl]       Gemini-compatible API base URL
   * @param {number} [options.printTimeoutMs]
   * @param {boolean} [options.stdinSessions] use one stdin-driven process per session
   */
  constructor(options = {}) {
    this.id = HARNESS_ID;
    this.displayName = "Gemini";
    this.bin = options.bin || resolveBinary(HARNESS_ID);
    this.model = options.model || null;
    this.effort = options.effort || null;
    this.cwd = options.cwd || process.cwd();
    this.apiKeyEnv = options.apiKeyEnv || "GEMINI_API_KEY";
    this.apiKeyValue = options.apiKeyValue || "";
    this.baseUrl = options.baseUrl || "";
    this.printTimeoutMs = Number(options.printTimeoutMs || 5 * 60 * 1000);
    this.stdinSessions = options.stdinSessions === true;
    this.skipPermissions = options.skipPermissions === true;
    this.logger = options.logger || new RuntimeLogger({ enabled: false });
    this.children = new Set();
    this.sessions = new Map();
    this.running = false;
    this.version = null;
    this.unavailableReason = null;
  }

  getCapabilities() {
    return { ...ANTIGRAVITY_CAPABILITIES };
  }

  childEnv() {
    const env = {};
    if (this.apiKeyEnv && this.apiKeyValue) env[this.apiKeyEnv] = this.apiKeyValue;
    if (this.baseUrl) env.GOOGLE_GEMINI_BASE_URL = this.baseUrl;
    return env;
  }

  async startRuntime() {
    const probe = await run(this.bin, ["--version"], { timeoutMs: 20000 });
    const combined = `${probe.stdout}\n${probe.stderr}`.trim();
    if (!probe.ok) {
      const incompatible = PCLMUL_MARKER.test(combined)
        || (probe.signal === "SIGILL" && hostHasPclmul() === false);
      const error = new Error(incompatible
        ? "Antigravity runtime cannot execute on this host: the official binary requires "
          + "the PCLMULQDQ CPU feature, which this CPU does not provide"
        : `Antigravity runtime is not runnable: ${combined || "no output"}`);
      error.errorType = incompatible ? "runtime_incompatible" : "runtime_unavailable";
      error.cpuFeature = incompatible ? "pclmulqdq" : null;
      this.unavailableReason = error.message;
      throw error;
    }
    this.version = combined.split("\n")[0];
    this.running = true;
    this.logger.log({ harness: this.id, event: "runtime_started", detail: { version: this.version } });
    return { harness: this.id, version: this.version };
  }

  stopRuntime() {
    for (const child of this.children) child.terminate();
    this.children.clear();
    for (const session of this.sessions.values()) session.process?.terminate();
    this.sessions.clear();
    this.running = false;
  }

  buildArgs(params = {}) {
    const args = [];
    if (params.prompt !== undefined) args.push("-p", String(params.prompt));
    args.push("--output-format", "stream-json");
    if (this.stdinSessions) args.push("--input-format", "stream-json");
    const model = params.model || this.model;
    if (model) args.push("--model", String(model));
    const effort = params.effort || this.effort;
    if (effort) args.push("--effort", String(effort));
    if (params.continueMostRecent) {
      args.push("--continue");
    } else if (params.conversationId) {
      args.push("--conversation", String(params.conversationId));
    }
    if (params.jsonSchema) args.push("--json-schema", String(params.jsonSchema));
    if (this.skipPermissions && params.skipPermissions !== false) {
      args.push("--dangerously-skip-permissions");
    }
    if (params.printTimeoutMs || this.printTimeoutMs) {
      args.push("--print-timeout", `${Math.round((params.printTimeoutMs || this.printTimeoutMs) / 1000)}s`);
    }
    return args;
  }

  sendPrompt(params = {}) {
    const emitter = new EventEmitter();
    const child = new HarnessProcess({
      harness: this.id,
      bin: this.bin,
      args: this.buildArgs(params),
      cwd: params.cwd || this.cwd,
      env: this.childEnv(),
      parser: parseAntigravityEvent,
      logger: this.logger,
      timeoutMs: Number(params.timeoutMs || this.printTimeoutMs + 60000),
    });
    this.children.add(child);
    let conversationId = params.conversationId || null;
    const startedAt = Date.now();

    child.on("event", (event) => {
      if (event.sessionId) conversationId = event.sessionId;
      emitter.emit("event", event);
      if (event.type === "result") {
        this.logger.log({
          harness: this.id, sessionId: conversationId, model: params.model || this.model,
          event: "result", durationMs: Date.now() - startedAt,
          errorType: event.error ? "harness_error" : null,
          detail: event.usage ? { usage: event.usage, status: event.status } : { status: event.status },
        });
      }
    });
    child.on("invalid", (line) => emitter.emit("invalid", line));
    child.on("timeout", (info) => emitter.emit("timeout", info));
    child.on("exit", (result) => {
      this.children.delete(child);
      emitter.emit("exit", result);
    });

    const done = child.whenDone().then((result) => {
      if (!result.ok) {
        this.logger.log({
          harness: this.id, sessionId: conversationId, model: params.model || this.model,
          event: "process_exit", durationMs: result.durationMs, errorType: result.errorType,
          detail: { code: result.code, signal: result.signal, stderr: result.stderr },
        });
      }
      return { ...result, sessionId: conversationId };
    });

    child.start();
    return {
      harness: this.id,
      process: child,
      events: emitter,
      done,
      get sessionId() { return conversationId; },
      cancel: (signal = "SIGTERM") => signal === "SIGTERM"
        ? child.terminate() : child.kill(signal),
    };
  }

  cancel(handle, signal = "SIGTERM") {
    if (handle?.process) return signal === "SIGTERM"
      ? handle.process.terminate() : handle.process.kill(signal);
    for (const child of this.children) {
      if (signal === "SIGTERM") child.terminate();
      else child.kill(signal);
    }
    return true;
  }

  async createSession(params = {}) {
    return { sessionId: params.conversationId || null, harness: this.id, mode: "per-turn" };
  }

  async resumeSession(params = {}) {
    return this.sendPrompt({ ...params, conversationId: params.sessionId });
  }

  streamEvents(handle, listener) {
    handle.events.on("event", listener);
    return () => handle.events.off("event", listener);
  }

  // Headless Antigravity has no interactive approval channel: tools that need
  // approval are soft-denied by policy. These are explicit no-ops, not silent
  // successes, so a caller can see the reason.
  approve() {
    return { ok: false, reason: "antigravity headless soft-denies tools; use permissions.allow rules or --dangerously-skip-permissions" };
  }

  deny() {
    return { ok: true, reason: "headless default denies unapproved tools" };
  }

  async listModels() {
    const probe = await run(this.bin, ["models"], { timeoutMs: 60000 });
    const models = String(probe.stdout || "").split(/\r?\n/)
      .map((line) => line.trim()).filter(Boolean)
      .map((line) => ({ id: line.replace(/^[*\-]\s*/, "").trim() }))
      .filter((model) => model.id);
    return { data: models, ok: probe.ok, raw: String(probe.stdout || "").slice(-2000) };
  }

  async listTools() {
    return { ok: false, reason: "agy has no tool-listing subcommand in the documented flag set" };
  }

  shutdownSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.process?.terminate();
      this.sessions.delete(sessionId);
    }
    return { ok: true, harness: this.id };
  }
}

module.exports = { AntigravityAdapter, hostHasPclmul, PCLMUL_MARKER };
