"use strict";

const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");

// A harness receives only the small set of environment values needed to find
// executables, locate its home/temp directories, and render output. In
// particular, do not inherit process.env wholesale: development shells often
// contain API keys, session tokens, and other credentials.
const SAFE_SYSTEM_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "TMP",
  "TEMP",
  "TMPDIR",
  "TERM",
  "COLORTERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "TZ",
  "TZDIR",
  // Windows process and home-directory variables.
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "OS",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)",
  "COMMONPROGRAMW6432",
  "ALLUSERSPROFILE",
  "PUBLIC",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_ARCHITEW6432",
  // Standard per-user Linux config/cache locations.
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
]);

function isSafeSystemEnvKey(key) {
  const upper = String(key).toUpperCase();
  return SAFE_SYSTEM_ENV_KEYS.has(upper) || upper.startsWith("LC_");
}

function sameEnvKey(left, right) {
  // Windows environment variable names are case-insensitive. Removing a
  // differently-cased inherited key keeps an explicit override unambiguous.
  return process.platform === "win32"
    ? String(left).toUpperCase() === String(right).toUpperCase()
    : left === right;
}

function childEnvironment(overrides) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (isSafeSystemEnvKey(key)) env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides || {})) {
    for (const inheritedKey of Object.keys(env)) {
      if (inheritedKey !== key && sameEnvKey(inheritedKey, key)) delete env[inheritedKey];
    }
    env[key] = value;
  }
  return env;
}

function normalizeGraceMs(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

// Runs one harness child process and converts its stdout NDJSON into normalised
// events. Crash isolation is the point of this module: a harness that dies, hangs,
// or prints garbage must never take the Witt backend down with it.
class HarnessProcess extends EventEmitter {
  constructor(options = {}) {
    super();
    this.harness = options.harness || "unknown";
    this.bin = options.bin;
    this.args = Array.isArray(options.args) ? options.args : [];
    this.cwd = options.cwd || process.cwd();
    this.env = options.env || {};
    this.parser = options.parser;
    this.logger = options.logger || null;
    this.timeoutMs = Number(options.timeoutMs || 15 * 60 * 1000);
    this.child = null;
    this.stderr = "";
    this.buffer = "";
    this.settled = false;
    this.timedOut = false;
    this.invalidLines = [];
    this.startedAt = null;
    this.timeout = null;
    this.terminationTimer = null;
    this.terminating = false;
    this.terminateGraceMs = normalizeGraceMs(
      options.terminateGraceMs ?? options.graceMs, 2000);
    this.lastResult = null;
  }

  get alive() {
    return Boolean(this.child) && this.child.exitCode === null && !this.child.killed;
  }

  start() {
    this.startedAt = Date.now();
    let child;
    try {
      child = spawn(this.bin, this.args, {
        cwd: this.cwd,
        env: childEnvironment(this.env),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      // A missing or non-executable binary must surface as an event, not a throw.
      this.settle({ code: null, signal: null, spawnError: error });
      return this;
    }
    this.child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.consume(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-8000);
    });
    child.on("error", (error) => this.settle({ code: null, signal: null, spawnError: error }));
    child.on("close", (code, signal) => this.settle({ code, signal }));

    this.timeout = setTimeout(() => {
      this.timedOut = true;
      this.emit("timeout", { harness: this.harness, timeoutMs: this.timeoutMs });
      this.kill("SIGKILL");
    }, this.timeoutMs);
    if (typeof this.timeout.unref === "function") this.timeout.unref();
    return this;
  }

  consume(chunk) {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      this.emitLine(line);
      index = this.buffer.indexOf("\n");
    }
  }

  emitLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let payload = null;
    try {
      payload = JSON.parse(trimmed);
    } catch {
      // Keep a bounded record: a chatty non-JSON stream must not grow memory.
      if (this.invalidLines.length < 20) this.invalidLines.push(trimmed.slice(0, 300));
      this.emit("invalid", trimmed.slice(0, 300));
      return;
    }
    if (!payload || typeof payload !== "object") return;
    let event = null;
    try {
      event = this.parser(payload);
    } catch (error) {
      this.emit("invalid", `parser error: ${error.message}`);
      return;
    }
    if (event) this.emit("event", event);
  }

  kill(signal = "SIGTERM") {
    if (!this.child || this.child.exitCode !== null) return false;
    try {
      return this.child.kill(signal);
    } catch {
      return false;
    }
  }

  // Request graceful shutdown first, then force the child down if it ignores
  // SIGTERM. A bounded escalation timer prevents cancellation from hanging
  // forever while settle() clears it as soon as the child exits.
  terminate(graceMs = this.terminateGraceMs) {
    if (graceMs && typeof graceMs === "object") {
      graceMs = graceMs.graceMs ?? graceMs.terminateGraceMs;
    }
    graceMs = normalizeGraceMs(graceMs, this.terminateGraceMs);
    if (!this.child || this.child.exitCode !== null || this.settled) return false;
    if (this.terminating) return true;

    this.terminating = true;
    if (!this.kill("SIGTERM")) {
      this.terminating = false;
      return false;
    }
    if (graceMs === 0) {
      this.kill("SIGKILL");
      return true;
    }
    this.terminationTimer = setTimeout(() => {
      this.terminationTimer = null;
      if (!this.settled && this.child && this.child.exitCode === null) {
        this.kill("SIGKILL");
      }
    }, graceMs);
    if (typeof this.terminationTimer.unref === "function") this.terminationTimer.unref();
    return true;
  }

  settle({ code, signal, spawnError }) {
    if (this.settled) return;
    this.settled = true;
    if (this.timeout) clearTimeout(this.timeout);
    if (this.terminationTimer) clearTimeout(this.terminationTimer);
    this.terminationTimer = null;
    // Flush a trailing line that had no newline terminator.
    if (this.buffer.trim()) {
      this.emitLine(this.buffer);
      this.buffer = "";
    }
    const result = {
      harness: this.harness,
      code,
      signal,
      timedOut: this.timedOut,
      durationMs: this.startedAt ? Date.now() - this.startedAt : 0,
      stderr: this.stderr.slice(-1200),
      invalidLines: this.invalidLines,
      ok: !spawnError && !this.timedOut && code === 0,
      errorType: spawnError ? "spawn_error"
        : this.timedOut ? "timeout"
        : code === 0 ? null
        : signal ? "killed_by_signal"
        : "exit_nonzero",
    };
    this.lastResult = result;
    this.emit("exit", result);
    this.emit("done", result);
  }

  // Resolves with the exit summary; never rejects, so callers cannot crash on a
  // harness failure.
  whenDone() {
    if (this.settled) return Promise.resolve(this.lastResult);
    return new Promise((resolve) => this.once("done", (result) => {
      this.lastResult = result;
      resolve(result);
    }));
  }
}

module.exports = { HarnessProcess };
