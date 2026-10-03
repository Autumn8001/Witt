"use strict";

const MAX_MESSAGE_BYTES = 300 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const DEVICE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function decodeMessage(data) {
  if (data.length > MAX_MESSAGE_BYTES) throw new Error("message_too_large");
  let value;
  try { value = JSON.parse(data.toString("utf8")); }
  catch { throw new Error("invalid_json"); }
  if (!value || typeof value !== "object" || Array.isArray(value) || value.v !== 1 ||
      typeof value.type !== "string" || value.type.length > 40) {
    throw new Error("invalid_protocol");
  }
  if (value.id !== undefined && (typeof value.id !== "string" || value.id.length > 100)) {
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

module.exports = { decodeMessage, limitOutput, validDeviceId, MAX_OUTPUT_BYTES };
