"use strict";

// Keep the wire envelope large enough for a compressed JPEG screenshot while
// still bounding every message received from an untrusted agent.
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_ATTACHMENT_BYTES = Math.floor(1.25 * 1024 * 1024);
const MAX_ID_LENGTH = 100;
const MAX_PATH_LENGTH = 1024;
const MAX_ROOT_LENGTH = 64;
const MAX_CAPABILITIES = 32;
const DEVICE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ROOT_ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CAPABILITY_RE = /^(?:system\.(?:hostname|info)|filesystem\.(?:list|read)|screen\.capture)$/;

const LEGACY_CAPABILITIES = Object.freeze(["system.hostname", "system.info"]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateCapabilityList(value, { allowMissing = false } = {}) {
  if (value === undefined && allowMissing) return null;
  if (!Array.isArray(value) || value.length > MAX_CAPABILITIES) throw new Error("invalid_capabilities");
  const seen = new Set();
  for (const capability of value) {
    if (typeof capability !== "string" || capability.length > 80 || !CAPABILITY_RE.test(capability) || seen.has(capability)) {
      throw new Error("invalid_capabilities");
    }
    seen.add(capability);
  }
  return [...seen];
}

function validRootAlias(value) {
  return typeof value === "string" && value.length <= MAX_ROOT_LENGTH && ROOT_ALIAS_RE.test(value);
}

function validateRootList(value, { allowMissing = false } = {}) {
  if (value === undefined && allowMissing) return null;
  if (!Array.isArray(value) || value.length > MAX_CAPABILITIES || value.some((root) => !validRootAlias(root))) {
    throw new Error("invalid_roots");
  }
  const seen = new Set();
  for (const root of value) {
    if (seen.has(root)) throw new Error("invalid_roots");
    seen.add(root);
  }
  return [...seen];
}

function validateRelativePath(value, { allowEmpty = true } = {}) {
  if (typeof value !== "string" || value.length > MAX_PATH_LENGTH || value.includes("\0") ||
      /[\u0000-\u001f\u007f]/.test(value) || value.includes("\\") || value.startsWith("/") ||
      /^[A-Za-z]:/.test(value)) throw new Error("invalid_path");
  if (!allowEmpty && value.length === 0) throw new Error("invalid_path");
  if (value === "" || value === ".") return value;
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error("invalid_path");
  return value;
}

function validateDeviceRegistration(message) {
  if (!isPlainObject(message) || message.type !== "register" || !validDeviceId(message.device_id) ||
      typeof message.hostname !== "string" || message.hostname.length === 0 || message.hostname.length > 255 ||
      typeof message.agent_version !== "string" || message.agent_version.length === 0 || message.agent_version.length > 40) {
    throw new Error("invalid_register");
  }
  const capabilities = validateCapabilityList(message.capabilities, { allowMissing: true });
  const roots = validateRootList(message.roots, { allowMissing: true });
  return { capabilities, roots };
}

function decodeMessage(data) {
  if (data.length > MAX_MESSAGE_BYTES) throw new Error("message_too_large");
  let value;
  try { value = JSON.parse(data.toString("utf8")); }
  catch { throw new Error("invalid_json"); }
  if (!value || typeof value !== "object" || Array.isArray(value) || value.v !== 1 ||
      typeof value.type !== "string" || value.type.length > 40) {
    throw new Error("invalid_protocol");
  }
  if (value.id !== undefined && (typeof value.id !== "string" || value.id.length > MAX_ID_LENGTH)) {
    throw new Error("invalid_id");
  }
  return value;
}

function limitOutput(stdout, stderr) {
  let out = Buffer.from(String(stdout || ""), "utf8");
  let err = Buffer.from(String(stderr || ""), "utf8");
  const truncated = out.length + err.length > MAX_OUTPUT_BYTES;
  if (truncated) {
    const clip = (buffer, bytes) => {
      let value = buffer.subarray(0, bytes).toString("utf8");
      while (Buffer.byteLength(value, "utf8") > bytes) value = value.slice(0, -1);
      return Buffer.from(value, "utf8");
    };
    out = clip(out, MAX_OUTPUT_BYTES);
    err = clip(err, MAX_OUTPUT_BYTES - out.length);
  }
  return { stdout: out.toString("utf8"), stderr: err.toString("utf8"), truncated };
}

function validDeviceId(value) {
  return typeof value === "string" && DEVICE_ID_RE.test(value);
}

function decodeBase64(value, maxBytes = MAX_ATTACHMENT_BYTES) {
  if (typeof value !== "string" || value.length === 0 || value.length > Math.ceil(maxBytes * 4 / 3) + 8 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    const error = new Error("INVALID_ATTACHMENT");
    error.code = "INVALID_ATTACHMENT";
    throw error;
  }
  const data = Buffer.from(value, "base64");
  if (data.length > maxBytes) {
    const error = new Error("ATTACHMENT_TOO_LARGE");
    error.code = "ATTACHMENT_TOO_LARGE";
    throw error;
  }
  return data;
}

module.exports = {
  decodeMessage, limitOutput, validDeviceId, isPlainObject,
  validateCapabilityList, validateRootList, validateRelativePath,
  validateDeviceRegistration, validRootAlias, decodeBase64,
  LEGACY_CAPABILITIES, CAPABILITY_RE, MAX_OUTPUT_BYTES, MAX_MESSAGE_BYTES,
  MAX_ATTACHMENT_BYTES, MAX_PATH_LENGTH, MAX_ROOT_LENGTH,
};
