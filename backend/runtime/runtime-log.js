"use strict";

// Runtime logs must carry enough to debug a turn and nothing that leaks a credential.
// Allowed: harness, session id, provider, model, event type, duration, error type.
// Forbidden: API keys, Authorization headers, full secrets, provider tokens.

const SECRET_KEY = /(api[_-]?key|token|secret|password|authorization|cookie|bearer)/i;
const TOKEN_SHAPES = /\b(?:sk-[A-Za-z0-9_\-]{20,}|xai-[A-Za-z0-9_\-]{20,}|AIza[A-Za-z0-9_\-]{20,}|ghp_[A-Za-z0-9]{20,})\b/g;

function scrubText(value) {
  return String(value == null ? "" : value).replace(TOKEN_SHAPES, "REDACTED");
}

function scrub(value, depth = 0) {
  if (depth > 4) return "[deep]";
  if (value == null) return value;
  if (typeof value === "string") return scrubText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => scrub(item, depth + 1));
  if (typeof value === "object") {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = SECRET_KEY.test(key) ? "REDACTED" : scrub(item, depth + 1);
    }
    return output;
  }
  return String(value);
}

class RuntimeLogger {
  constructor(options = {}) {
    this.sink = options.sink || ((line) => process.stdout.write(`${line}\n`));
    this.enabled = options.enabled !== false;
  }

  log(record) {
    if (!this.enabled) return null;
    const entry = {
      at: new Date().toISOString(),
      harness: record.harness || null,
      sessionId: record.sessionId || null,
      provider: record.provider || null,
      model: record.model || null,
      event: record.event || null,
      durationMs: Number.isFinite(record.durationMs) ? Math.round(record.durationMs) : null,
      errorType: record.errorType || null,
      detail: record.detail === undefined ? undefined : scrub(record.detail),
    };
    const line = `[runtime] ${JSON.stringify(entry)}`;
    this.sink(line);
    return entry;
  }

  childStderr(harness, text, context = {}) {
    // Provider stderr can echo a URL or a token; scrub before it is stored anywhere.
    return this.log({
      ...context,
      harness,
      event: "stderr",
      detail: scrubText(text).slice(-800),
    });
  }
}

module.exports = { RuntimeLogger, scrub, scrubText };
