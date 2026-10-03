"use strict";

const { EventEmitter } = require("node:events");
const { execFile } = require("node:child_process");
const { HarnessProcess } = require("./harness-process");
const { parseGrokEvent } = require("./event-parsers");
const { GROK_BUILD_CAPABILITIES } = require("./capabilities");
const { resolveBinary } = require("./runtime-binaries");
const { RuntimeLogger } = require("./runtime-log");
const { redactHarnessText, sanitizeHarnessContent } = require("./tool-content");

const HARNESS_ID = "grok-build";

function run(bin, args, options = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: options.timeoutMs || 30000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error?.code ?? 0,
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
        });
      });
  });
}

function parseModelList(stdout) {
  const models = [];
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const match = line.match(/^\s*[*\-]\s+(\S+)(\s+\(default\))?\s*$/);
    if (!match) continue;
    models.push({ id: match[1], isDefault: Boolean(match[2]) });
  }
  return models;
}

class GrokBuildAdapter {
  /**
   * @param {object} options
   * @param {string} [options.bin]        grok executable (default: resolved official path)
   * @param {string} options.model        model id, e.g. grok-4.7-high
   * @param {string} [options.cwd]        working directory for the session
   * @param {string} [options.envKey]     env var name the CLI reads the key from
   * @param {string} [options.envValue]   secret value; never logged
   * @param {string} [options.permissionMode]
   * @param {string} [options.reasoningEffort]
   * @param {number} [options.timeoutMs]
   * @param {object} [options.logger]
   */
  constructor(options = {}) {
    this.id = HARNESS_ID;
    this.displayName = "Grok Build";
    this.bin = options.bin || resolveBinary(HARNESS_ID);
    this.model = options.model || "grok-4.7-high";
    this.cwd = options.cwd || process.cwd();
    this.envKey = options.envKey || "WITT_CPA_KEY";
    this.envValue = options.envValue || "";
    this.remoteDeviceMcpEnabled = options.remoteDeviceMcpEnabled === true;
    this.remoteDeviceTokenFile = options.remoteDeviceTokenFile || "";
    this.browserMcpEnabled = options.browserMcpEnabled === true;
    this.permissionMode = options.permissionMode || "default";
    this.reasoningEffort = options.reasoningEffort || null;
    this.timeoutMs = Number(options.timeoutMs || 15 * 60 * 1000);
    this.logger = options.logger || new RuntimeLogger({ enabled: false });
    this.children = new Set();
    this.running = false;
    this.version = null;
  }

  getCapabilities() {
    return { ...GROK_BUILD_CAPABILITIES };
  }

  childEnv() {
    const env = {};
    if (this.envKey && this.envValue) env[this.envKey] = this.envValue;
    env.WITT_REMOTE_DEVICE_MCP_ENABLED = this.remoteDeviceMcpEnabled ? "1" : "0";
    env.WITT_BROWSER_MCP_ENABLED = this.browserMcpEnabled ? "1" : "0";
    if (this.remoteDeviceMcpEnabled && this.remoteDeviceTokenFile) {
      env.DROP_VAULT_TOKEN_FILE = this.remoteDeviceTokenFile;
    }
    return env;
  }

  async startRuntime() {
    const probe = await run(this.bin, ["--version"], { timeoutMs: 20000 });
    if (!probe.ok) {
      const error = new Error(
        `Grok Build runtime is not runnable: ${probe.stderr.trim() || probe.stdout.trim() || "no output"}`);
      error.errorType = "runtime_unavailable";
      throw error;
    }
    this.version = (probe.stdout || probe.stderr).trim().split("\n")[0];
    this.running = true;
    this.logger.log({ harness: this.id, model: this.model, event: "runtime_started",
      detail: { version: this.version } });
    return { harness: this.id, version: this.version };
  }

  stopRuntime() {
    for (const child of this.children) child.terminate();
    this.children.clear();
    this.running = false;
    this.logger.log({ harness: this.id, event: "runtime_stopped" });
  }

  buildArgs(params = {}) {
    const args = [
      "-p", String(params.prompt || ""),
      "--model", String(params.model || this.model),
      "--output-format", "streaming-json",
      "--no-auto-update",
      "--cwd", String(params.cwd || this.cwd),
    ];
    // A new session pins a caller-supplied UUID; resume continues an existing one.
    // Grok rejects --session-id together with --resume unless --fork-session is set.
    if (params.resumeSessionId) {
      args.push("--resume", String(params.resumeSessionId));
    } else if (params.sessionId) {
      args.push("--session-id", String(params.sessionId));
    }
    const effort = params.reasoningEffort || this.reasoningEffort;
    if (effort) args.push("--reasoning-effort", String(effort));
    const mode = params.permissionMode || this.permissionMode;
    if (mode) args.push("--permission-mode", String(mode));
    if (Number.isFinite(params.maxTurns)) args.push("--max-turns", String(params.maxTurns));
    for (const tool of params.disallowedTools || []) args.push("--disallowed-tools", String(tool));
    return args;
  }

  /**
   * Runs one turn. Returns an EventEmitter of normalised events plus a `done`
   * promise. Harness failure never throws here; inspect `done`.
   */
  sendPrompt(params = {}) {
    const emitter = new EventEmitter();
    const child = new HarnessProcess({
      harness: this.id,
      bin: this.bin,
      args: this.buildArgs(params),
      cwd: params.cwd || this.cwd,
      env: this.childEnv(),
      parser: parseGrokEvent,
      logger: this.logger,
      timeoutMs: Number(params.timeoutMs || this.timeoutMs),
    });
    this.children.add(child);
    let sessionId = params.sessionId || null;
    const startedAt = Date.now();

    child.on("event", (event) => {
      if (event.type === "end" && event.sessionId) sessionId = event.sessionId;
      if (event.type === "init" && event.sessionId) sessionId = event.sessionId;
      emitter.emit("event", event);
      if (event.type === "end" || event.type === "error") {
        this.logger.log({
          harness: this.id, sessionId, model: params.model || this.model,
          event: event.type, durationMs: Date.now() - startedAt,
          errorType: event.type === "error" ? "harness_error" : null,
          detail: event.usage ? { usage: event.usage } : undefined,
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
          harness: this.id, sessionId, model: params.model || this.model,
          event: "process_exit", durationMs: result.durationMs,
          errorType: result.errorType,
          detail: { code: result.code, signal: result.signal, stderr: result.stderr },
        });
      }
      return { ...result, sessionId };
    });

    child.start();
    return {
      harness: this.id,
      process: child,
      events: emitter,
      done,
      get sessionId() { return sessionId; },
      cancel: (signal = "SIGTERM") => signal === "SIGTERM"
        ? child.terminate() : child.kill(signal),
    };
  }

  // Translate Grok tool events to the existing Witt stream shape. Keep this
  // runtime-specific mapping here, leaving ChatService to persist and publish.
  formatToolCall(event, cwd) {
    const tool = redactHarnessText(event.tool || "工具调用", 90);
    const rawInput = event.input && typeof event.input === "object" ? event.input : {};
    const command = [rawInput.command, rawInput.cmd, rawInput.shell_command, rawInput.script]
      .find((value) => typeof value === "string" && value.trim());
    const safeCommand = command ? redactHarnessText(command, 4000) : null;
    const isCommand = Boolean(command) || /terminal|shell|command|exec/i.test(tool);
    const kind = isCommand ? "command" : "tool";
    const label = isCommand
      ? `命令：${String(safeCommand || tool).replace(/\s+/g, " ").slice(0, 120)}`
      : `调用工具：${tool}`;
    const input = sanitizeHarnessContent(event.input || null);
    return {
      kind, label, status: "running",
      details: isCommand
        ? { command: safeCommand || tool, cwd, input, output: "", exitCode: null }
        : { input },
    };
  }

  formatToolUpdate(event, info = {}) {
    const output = event.output;
    const exitCodeValue = output && typeof output === "object"
      ? (output.exitCode ?? output.exit_code ?? output.code) : undefined;
    const exitCode = exitCodeValue !== undefined && exitCodeValue !== null &&
      Number.isInteger(Number(exitCodeValue)) ? Number(exitCodeValue) : null;
    const failureReason = output && typeof output === "object"
      ? (output.failureReason ?? output.failure_reason ?? output.error) : undefined;
    const safeFailureReason = failureReason === undefined ? undefined
      : redactHarnessText(failureReason, 500);
    const patch = {
      kind: info.kind || "tool",
      ...(info.kind === "command" && exitCode !== null ? { exitCode } : {}),
      ...(safeFailureReason ? {
        error: safeFailureReason, failureReason: redactHarnessText(safeFailureReason, 300),
      } : {}),
      status: ["completed", "failed", "error"].includes(event.status)
        ? (event.status === "error" ? "failed" : event.status) : "running",
    };
    if (output !== undefined) {
      const safeOutput = sanitizeHarnessContent(output);
      const outputText = typeof safeOutput === "string" ? safeOutput : JSON.stringify(safeOutput);
      patch.details = {
        output: String(outputText).slice(-8192),
        ...(info.kind === "command" && exitCodeValue !== undefined && exitCodeValue !== null
          ? { exitCode } : {}),
      };
    }
    return patch;
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
    return { sessionId: params.sessionId || null, harness: this.id };
  }

  async resumeSession(params = {}) {
    return this.sendPrompt({ ...params, resumeSessionId: params.sessionId });
  }

  streamEvents(handle, listener) {
    handle.events.on("event", listener);
    return () => handle.events.off("event", listener);
  }

  // Interactive approvals are not part of the headless protocol; the CLI gates
  // tools through permission modes instead, so these are explicit no-ops.
  approve() {
    return { ok: false, reason: "grok-build uses permission modes, not interactive approvals" };
  }

  deny() {
    return { ok: false, reason: "grok-build uses permission modes, not interactive approvals" };
  }

  async listModels() {
    const probe = await run(this.bin, ["models"], { timeoutMs: 60000 });
    return { data: parseModelList(probe.stdout), raw: probe.stdout.slice(-4000), ok: probe.ok };
  }

  async listTools() {
    const probe = await run(this.bin, ["inspect"], { timeoutMs: 60000 });
    return { ok: probe.ok, raw: probe.stdout.slice(-6000) };
  }

  shutdownSession() {
    return { ok: true, harness: this.id };
  }
}

module.exports = { GrokBuildAdapter, parseModelList };
