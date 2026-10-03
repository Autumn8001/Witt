"use strict";

const fs = require("node:fs");
const readline = require("node:readline");

const base = process.env.WITT_DEVICE_MCP_API || "http://127.0.0.1:3003";
const tokenFile = process.env.DROP_VAULT_TOKEN_FILE || "/home/ubuntu/.config/drop-vault/api-token";
const tools = [
  { name: "device_list", description: "device.list: List configured customer devices and online status.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "device_get", description: "device.get: Get one customer device by device_id.",
    inputSchema: { type: "object", properties: { device_id: { type: "string" } },
      required: ["device_id"], additionalProperties: false } },
  { name: "device_hostname", description: "device.hostname: Ask one online customer device to run the allowed hostname command.",
    inputSchema: { type: "object", properties: { device_id: { type: "string" } },
      required: ["device_id"], additionalProperties: false } },
];
const validID = (id) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id);
async function api(method, path) {
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
  const response = await fetch(endpoint.origin + path, {
    redirect: "error",
    method, headers: { Authorization: "Bearer " + token },
    signal: AbortSignal.timeout(35000),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "DEVICE_ERROR");
  return body;
}
async function invoke(name, args) {
  name = ({ device_list: "device.list", device_get: "device.get", device_hostname: "device.hostname" })[name] || name;
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("INVALID_ARGUMENTS");
  if (name === "device.list" && Object.keys(args).length === 0) {
    return (await api("GET", "/internal/devices")).devices;
  }
  if ((name === "device.get" || name === "device.hostname") &&
      Object.keys(args).length === 1 && validID(args.device_id)) {
    const id = encodeURIComponent(args.device_id);
    return name === "device.get"
      ? (await api("GET", "/internal/devices/" + id)).device
      : (await api("POST", "/internal/devices/" + id + "/hostname")).result;
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
      serverInfo: { name: "witt-remote-device", version: "0.1.0" },
    };
    else if (request.method === "ping") result = {};
    else if (request.method === "tools/list") result = { tools };
    else if (request.method === "tools/call") {
      try {
        const value = await invoke(request.params?.name, request.params?.arguments || {});
        result = { content: [{ type: "text", text: JSON.stringify(value) }] };
      } catch (error) {
        result = { isError: true, content: [{ type: "text", text: String(error.message || "DEVICE_ERROR").slice(0, 100) }] };
      }
    } else throw new Error("METHOD_NOT_FOUND");
    send({ jsonrpc: "2.0", id: request.id, result });
  } catch (error) {
    send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: String(error.message).slice(0, 100) } });
  }
});
