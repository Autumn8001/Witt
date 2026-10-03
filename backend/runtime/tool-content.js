"use strict";

const SENSITIVE_FIELD = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|passwd|authorization|cookie|private[_-]?key)/i;
const TOKEN_SHAPES = /\b(?:sk-[A-Za-z0-9_-]{16,}|xai-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{16,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,})\b/g;

function redactHarnessText(value, limit = 8192) {
  let text = String(value == null ? "" : value);
  text = text
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|passwd|authorization|cookie|token|private[_-]?key)\s*[=:]\s*)(?:Bearer\s+[^\s,;]+|"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1[REDACTED]")
    .replace(/(--?(?:api[-_]?key|access[-_]?token|token|secret|password|passwd|authorization|cookie)(?:\s+|=))(?:"[^"]*"|'[^']*'|[^\s]+)/gi,
      "$1[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/(\bhttps?:\/\/[^:/\s]+:)[^@/\s]+(@)/gi, "$1[REDACTED]$2")
    .replace(TOKEN_SHAPES, "[REDACTED]")
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
      "[REDACTED PRIVATE KEY]");
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function sanitizeHarnessContent(value, options = {}, depth = 0) {
  const maxDepth = options.maxDepth ?? 5;
  const maxString = options.maxString ?? 8192;
  if (depth > maxDepth) return "[truncated]";
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return redactHarnessText(value, maxString);
  if (Array.isArray(value)) return value.slice(0, 100)
    .map((item) => sanitizeHarnessContent(item, options, depth + 1));
  if (typeof value === "object") {
    const output = {};
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      output[redactHarnessText(key, 200)] = SENSITIVE_FIELD.test(key)
        ? "[REDACTED]" : sanitizeHarnessContent(item, options, depth + 1);
    }
    return output;
  }
  return redactHarnessText(value, maxString);
}

module.exports = { redactHarnessText, sanitizeHarnessContent };
