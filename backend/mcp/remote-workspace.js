"use strict";

// Session-scoped MCP bridge.  It intentionally exposes neither device_id nor
// a customer filesystem path: the one-time credential selects one immutable
// Remote Workspace binding on the server.

const fs = require("node:fs");
const readline = require("node:readline");

const base = process.env.WITT_REMOTE_WORKSPACE_MCP_API || "";
const credentialFile = process.env.WITT_REMOTE_WORKSPACE_CREDENTIAL_FILE || "";
const enabled = process.env.WITT_REMOTE_WORKSPACE_MCP_ENABLED === "1";

const tools = [
  ["workspace_list", "List files below this session's fixed workspace root.", { path: { type: "string", maxLength: 1024 } }, []],
  ["workspace_stat", "Read metadata for a workspace path.", { path: { type: "string", minLength: 1, maxLength: 1024 } }, ["path"]],
  ["workspace_read", "Read a UTF-8 text file and its SHA-256 precondition.", { path: { type: "string", minLength: 1, maxLength: 1024 } }, ["path"]],
  ["workspace_search", "Search UTF-8 text files below the workspace root.", { query: { type: "string", minLength: 1, maxLength: 1024 }, path: { type: "string", maxLength: 1024 }, max_results: { type: "integer", minimum: 1, maximum: 200 } }, ["query"]],
  ["workspace_write", "Write one text file with a required SHA-256 precondition. Use an empty hash only to create a missing file.", { path: { type: "string", minLength: 1, maxLength: 1024 }, content: { type: "string", maxLength: 524288 }, expected_sha256: { type: "string", maxLength: 64 } }, ["path", "content", "expected_sha256"]],
  ["workspace_patch", "Replace exactly one known text fragment after checking SHA-256.", { path: { type: "string", minLength: 1, maxLength: 1024 }, expected_sha256: { type: "string", minLength: 64, maxLength: 64 }, before: { type: "string", minLength: 1, maxLength: 524288 }, after: { type: "string", maxLength: 524288 } }, ["path", "expected_sha256", "before", "after"]],
  ["workspace_exec", "Run an approved development program using program plus argv; never pass a shell command line.", { program: { type: "string", minLength: 1, maxLength: 256 }, argv: { type: "array", items: { type: "string", maxLength: 4096 }, maxItems: 64 }, cwd: { type: "string", maxLength: 1024 }, timeout_ms: { type: "integer", minimum: 1000, maximum: 30000 } }, ["program", "argv"]],
  ["workspace_git_status", "Return git status for this workspace.", {}, []],
  ["workspace_git_diff", "Return git diff for this workspace.", {}, []],
  ["workspace_system_info", "Return non-sensitive system information for the connected customer device.", {}, []],
].map(([name, description, properties, required]) => ({ name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } }));

// Only the namespace separator changes; git_status/git_diff/system_info
// remain single operation names in the backend and Agent protocol.
const operationFor = Object.fromEntries(tools.map((tool) => [tool.name, tool.name.replace(/^workspace_/, "workspace.")]));

function endpoint() {
  let parsed;
  try { parsed = new URL(base); } catch { throw new Error("MCP_API_INVALID"); }
  if (!enabled || !credentialFile || !["http:", "https:"].includes(parsed.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) || parsed.username || parsed.password ||
      parsed.search || parsed.hash || parsed.pathname !== "/") throw new Error("MCP_NOT_AUTHORIZED");
  return parsed.origin;
}

async function invoke(name, args) {
  const operation = operationFor[name];
  if (!operation || !args || typeof args !== "object" || Array.isArray(args)) throw new Error("INVALID_ARGUMENTS");
  const credential = fs.readFileSync(credentialFile, "utf8").trim();
  if (!credential || credential.length > 200) throw new Error("MCP_NOT_AUTHORIZED");
  const response = await fetch(endpoint() + "/internal/remote-workspaces/mcp", {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(6 * 60_000),
    headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
    body: JSON.stringify({ operation, args }),
  });
  let body;
  try { body = await response.json(); } catch { throw new Error("WORKSPACE_GATEWAY_ERROR"); }
  if (!response.ok) throw new Error(String(body?.error || "WORKSPACE_GATEWAY_ERROR").slice(0, 100));
  return body.result;
}

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", async (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.id === undefined) return;
  try {
    let result;
    if (request.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "witt-remote-workspace", version: "1.0.0" } };
    else if (request.method === "ping") result = {};
    else if (request.method === "tools/list") result = { tools };
    else if (request.method === "tools/call") {
      try { result = { content: [{ type: "text", text: JSON.stringify(await invoke(request.params?.name, request.params?.arguments || {})) }] }; }
      catch (error) { result = { isError: true, content: [{ type: "text", text: String(error.message || "WORKSPACE_ERROR").slice(0, 100) }] }; }
    } else throw new Error("METHOD_NOT_FOUND");
    send({ jsonrpc: "2.0", id: request.id, result });
  } catch (error) {
    send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: String(error.message || "METHOD_NOT_FOUND").slice(0, 100) } });
  }
});
