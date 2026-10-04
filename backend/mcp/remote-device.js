"use strict";

const fs = require("node:fs");
const readline = require("node:readline");

const base = process.env.WITT_DEVICE_MCP_API || "http://127.0.0.1:3003";
const tokenFile = process.env.DROP_VAULT_TOKEN_FILE || "/home/ubuntu/.config/drop-vault/api-token";
const tools = [
  { name: "device_list", description: "device.list: List configured customer devices and online status.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "device_get", description: "device.get: Get one customer device by device_id.",
    inputSchema: { type: "object", properties: { device_id: { type: "string", minLength: 1, maxLength: 64 } },
      required: ["device_id"], additionalProperties: false } },
  { name: "device_hostname", description: "device.hostname: Ask one online customer device for its hostname.",
    inputSchema: { type: "object", properties: { device_id: { type: "string", minLength: 1, maxLength: 64 } },
      required: ["device_id"], additionalProperties: false } },
  { name: "device_system_info", description: "device.system_info: Read non-sensitive system information from one online customer device.",
    inputSchema: { type: "object", properties: { device_id: { type: "string", minLength: 1, maxLength: 64 } },
      required: ["device_id"], additionalProperties: false } },
  { name: "device_file_list", description: "device.file_list: List entries below an allowed customer-device root alias.",
    inputSchema: { type: "object", properties: {
      device_id: { type: "string", minLength: 1, maxLength: 64 },
      root: { type: "string", minLength: 1, maxLength: 64 },
      path: { type: "string", maxLength: 1024 },
    }, required: ["device_id", "root", "path"], additionalProperties: false } },
  { name: "device_file_read", description: "device.file_read: Read a file below an allowed customer-device root alias.",
    inputSchema: { type: "object", properties: {
      device_id: { type: "string", minLength: 1, maxLength: 64 },
      root: { type: "string", minLength: 1, maxLength: 64 },
      path: { type: "string", maxLength: 1024 },
    }, required: ["device_id", "root", "path"], additionalProperties: false } },
  { name: "device_screenshot", description: "device.screenshot: Capture the current customer-device screen as a JPEG image.",
    inputSchema: { type: "object", properties: { device_id: { type: "string", minLength: 1, maxLength: 64 } },
      required: ["device_id"], additionalProperties: false } },
];

const aliases = {
  device_list: "device.list", device_get: "device.get", device_hostname: "device.hostname",
  device_system_info: "device.system_info", device_file_list: "device.file_list",
  device_file_read: "device.file_read", device_screenshot: "device.screenshot",
};
const validID = (id) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id);
const validRoot = (root) => typeof root === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(root);
const validPath = (value) => typeof value === "string" && value.length <= 1024 &&
  !value.includes("\\") && !value.includes("\0") && !/[\u0000-\u001f\u007f]/.test(value) &&
  !value.startsWith("/") && !/^[A-Za-z]:/.test(value) &&
  (value === "" || value === "." || value.split("/").every((part) => part && part !== "." && part !== ".."));
const exact = (args, keys) => args && typeof args === "object" && !Array.isArray(args) &&
  Object.keys(args).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(args, key));

async function api(method, path, payload) {
  if (process.env.WITT_REMOTE_DEVICE_MCP_ENABLED !== "1") throw new Error("MCP_NOT_AUTHORIZED");
  let endpoint;
  try {
    endpoint = new URL(base);
    if (!["http:", "https:"].includes(endpoint.protocol) ||
        !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
        endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/") {
      throw new Error("invalid_endpoint");
    }
  } catch { throw new Error("MCP_API_MUST_BE_LOOPBACK"); }
  const token = fs.readFileSync(tokenFile, "utf8").trim();
  const headers = { Authorization: "Bearer " + token };
  const options = { redirect: "error", method, headers, signal: AbortSignal.timeout(35000) };
  if (payload !== undefined) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(payload);
  }
  const response = await fetch(endpoint.origin + path, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "DEVICE_ERROR");
  return body;
}

async function invoke(name, args) {
  name = aliases[name] || name;
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("INVALID_ARGUMENTS");
  if (name === "device.list" && exact(args, [])) return (await api("GET", "/internal/devices")).devices;
  if (name === "device.get" && exact(args, ["device_id"]) && validID(args.device_id)) {
    return (await api("GET", "/internal/devices/" + encodeURIComponent(args.device_id))).device;
  }
  if (name === "device.hostname" && exact(args, ["device_id"]) && validID(args.device_id)) {
    return (await api("POST", "/internal/devices/" + encodeURIComponent(args.device_id) + "/hostname")).result;
  }
  if (name === "device.system_info" && exact(args, ["device_id"]) && validID(args.device_id)) {
    return (await api("POST", "/internal/devices/" + encodeURIComponent(args.device_id) + "/system-info")).result;
  }
  if ((name === "device.file_list" || name === "device.file_read") &&
      exact(args, ["device_id", "root", "path"]) && validID(args.device_id) &&
      validRoot(args.root) && validPath(args.path)) {
    const operation = name === "device.file_list" ? "list" : "read";
    return (await api("POST", "/internal/devices/" + encodeURIComponent(args.device_id) +
      "/files/" + operation, { root: args.root, path: args.path })).result;
  }
  if (name === "device.screenshot" && exact(args, ["device_id"]) && validID(args.device_id)) {
    const result = (await api("POST", "/internal/devices/" + encodeURIComponent(args.device_id) + "/screenshot", {})).result;
    if (!result || result.mime !== "image/jpeg" || typeof result.data !== "string") throw new Error("INVALID_ATTACHMENT");
    // Emit this as MCP image content below; do not stringify a large base64
    // payload into ordinary tool text or diagnostics.
    return { __mcp_image: true, mimeType: "image/jpeg", data: result.data };
  }
  throw new Error("INVALID_ARGUMENTS");
}

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", async (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.id === undefined) return;
  try {
    let result;
    if (request.method === "initialize") result = {
      protocolVersion: "2024-11-05", capabilities: { tools: {} },
      serverInfo: { name: "witt-remote-device", version: "0.2.0" },
    };
    else if (request.method === "ping") result = {};
    else if (request.method === "tools/list") result = { tools };
    else if (request.method === "tools/call") {
      try {
        const value = await invoke(request.params?.name, request.params?.arguments || {});
        result = value?.__mcp_image
          ? { content: [{ type: "image", data: value.data, mimeType: value.mimeType }] }
          : { content: [{ type: "text", text: JSON.stringify(value) }] };
      } catch (error) {
        result = { isError: true, content: [{ type: "text", text: String(error.message || "DEVICE_ERROR").slice(0, 100) }] };
      }
    } else throw new Error("METHOD_NOT_FOUND");
    send({ jsonrpc: "2.0", id: request.id, result });
  } catch (error) {
    send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: String(error.message).slice(0, 100) } });
  }
});
