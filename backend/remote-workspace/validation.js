"use strict";

const { isDeepStrictEqual } = require("node:util");

const MAX_PATH_LENGTH = 1024;
const MAX_TEXT_BYTES = 512 * 1024;
const MAX_SEARCH_RESULTS = 200;
const MAX_TIMEOUT_MS = 30_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROOT_ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

class WorkspaceValidationError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function invalid(code = "INVALID_ARGUMENTS") { throw new WorkspaceValidationError(code); }

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isPlainObject(value) && Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function optionalKeys(value, required, optional) {
  if (!isPlainObject(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key));
}

function validUuid(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

function validRootAlias(value) {
  return typeof value === "string" && ROOT_ALIAS_RE.test(value);
}

function validateRelativePath(value, { allowRoot = false } = {}) {
  if (typeof value !== "string" || value.length > MAX_PATH_LENGTH || value.includes("\\") ||
      value.includes("\0") || /[\u0000-\u001f\u007f]/.test(value) || value.startsWith("/") ||
      /^[A-Za-z]:/.test(value) || value.startsWith("//")) invalid("INVALID_PATH");
  if (value === "." && allowRoot) return value;
  if (!value || value === ".") invalid("INVALID_PATH");
  if (value.split("/").some((part) => !part || part === "." || part === "..")) invalid("INVALID_PATH");
  return value;
}

function text(value, field, maxBytes = MAX_TEXT_BYTES) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maxBytes || value.includes("\0")) {
    invalid(`INVALID_${field.toUpperCase()}`);
  }
  return value;
}

function sha256(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) invalid("INVALID_SHA256");
  return value.toLowerCase();
}

function validateWorkspaceOperation(operation, args, { fullAccess = false, assistCommands = false } = {}) {
  const validatePath = (value, options) => {
    if (fullAccess && typeof value === "string" && /^[A-Za-z]:[\\/]/.test(value) &&
        value.length <= MAX_PATH_LENGTH && !/[\u0000-\u001f\u007f]/.test(value) &&
        !value.slice(2).includes(":")) return value.replace(/\\/g, "/");
    return validateRelativePath(value, options);
  };
  if (typeof operation !== "string") invalid("INVALID_OPERATION");
  if (operation === "workspace.list") {
    if (!optionalKeys(args, [], ["path"])) invalid();
    return { operation, args: { path: args.path === undefined || args.path === "" ? "." : validatePath(args.path, { allowRoot: true }) } };
  }
  if (operation === "workspace.stat" || operation === "workspace.read" || operation === "workspace.read_image") {
    if (!exactKeys(args, ["path"])) invalid();
    return { operation, args: { path: validatePath(args.path) } };
  }
  if (operation === "workspace.search") {
    if (!optionalKeys(args, ["query"], ["path", "max_results"])) invalid();
    const query = text(args.query, "query", 1024);
    if (!query.trim()) invalid("INVALID_QUERY");
    const result = { query, path: args.path === undefined ? "." : validatePath(args.path, { allowRoot: true }) };
    if (args.max_results !== undefined) {
      if (!Number.isInteger(args.max_results) || args.max_results < 1 || args.max_results > MAX_SEARCH_RESULTS) invalid("INVALID_MAX_RESULTS");
      result.max_results = args.max_results;
    }
    return { operation, args: result };
  }
  if (operation === "workspace.write") {
    // Every write has a compare-and-swap precondition. The empty string means
    // create only when the target does not exist; the agent verifies it.
    if (!exactKeys(args, ["path", "content", "expected_sha256"])) invalid();
    const expected = args.expected_sha256 === "" ? "" : sha256(args.expected_sha256);
    return { operation, args: { path: validatePath(args.path), content: text(args.content, "content"), expected_sha256: expected } };
  }
  if (operation === "workspace.patch") {
    // Exact before/after replacement is deliberately narrower than applying an
    // unconstrained diff. The agent rejects zero or multiple matches.
    if (!exactKeys(args, ["path", "expected_sha256", "before", "after"])) invalid();
    const before = text(args.before, "before");
    const after = text(args.after, "after");
    if (!before) invalid("INVALID_PATCH");
    return { operation, args: { path: validatePath(args.path), expected_sha256: sha256(args.expected_sha256), before, after } };
  }
  if (operation === "workspace.exec") {
    if (!optionalKeys(args, ["program", "argv"], ["cwd", "timeout_ms"])) invalid();
    const program = text(args.program, "program", 256);
    if (!program || /[\\/\s]/.test(program)) invalid("INVALID_PROGRAM");
    if (!Array.isArray(args.argv) || args.argv.length > 64 || args.argv.some((entry) => typeof entry !== "string" ||
        Buffer.byteLength(entry, "utf8") > 4096 || entry.includes("\0"))) invalid("INVALID_ARGV");
    const result = { program, argv: [...args.argv] };
    if (args.cwd !== undefined) result.cwd = validatePath(args.cwd, { allowRoot: true });
    if (args.timeout_ms !== undefined) {
      if (!Number.isInteger(args.timeout_ms) || args.timeout_ms < 1000 || args.timeout_ms > (assistCommands ? 300_000 : MAX_TIMEOUT_MS)) invalid("INVALID_TIMEOUT");
      result.timeout_ms = args.timeout_ms;
    }
    return { operation, args: result };
  }
  if (operation === "workspace.git_status" || operation === "workspace.git_diff" || operation === "workspace.system_info") {
    if (!exactKeys(args, [])) invalid();
    return { operation, args: {} };
  }
  invalid("UNKNOWN_OPERATION");
}

function stableIntentEquals(left, right) {
  return isDeepStrictEqual(left, right);
}

module.exports = {
  WorkspaceValidationError, validUuid, validRootAlias, validateRelativePath,
  validateWorkspaceOperation, isPlainObject, stableIntentEquals, MAX_TEXT_BYTES,
};
