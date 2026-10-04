"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");

test("disabled MCP rejects calls before reading credentials or contacting Gateway", async (t) => {
  const child = spawn(process.execPath, [path.join(__dirname, "mcp/remote-device.js")], {
    env: { ...process.env, WITT_REMOTE_DEVICE_MCP_ENABLED: "0",
      DROP_VAULT_TOKEN_FILE: path.join(__dirname, "nonexistent-device-test-token"),
      WITT_DEVICE_MCP_API: "http://127.0.0.1:1" },
    stdio: ["pipe", "pipe", "ignore"],
  });
  t.after(() => child.kill("SIGTERM"));
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  lines.on("line", (line) => {
    const value = JSON.parse(line);
    pending.get(value.id)?.(value);
  });
  let nextID = 0;
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextID;
    const timer = setTimeout(() => reject(new Error("MCP_TIMEOUT")), 3000);
    pending.set(id, (value) => { clearTimeout(timer); pending.delete(id); resolve(value); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const init = await call("initialize", { protocolVersion: "2024-11-05", capabilities: {} });
  assert.equal(init.result.serverInfo.name, "witt-remote-device");
  const discovered = (await call("tools/list")).result.tools;
  assert.deepEqual(discovered.map((tool) => tool.name), ["device_list", "device_get", "device_hostname",
    "device_system_info", "device_file_list", "device_file_read", "device_screenshot"]);
  assert.ok(discovered.every((tool) => /^[A-Za-z0-9_-]+$/.test(tool.name)));
  assert.deepEqual(discovered.map((tool) => tool.description.split(":")[0]), ["device.list", "device.get", "device.hostname",
    "device.system_info", "device.file_list", "device.file_read", "device.screenshot"]);
  const disabledCalls = {
    device_list: {}, device_get: { device_id: "PC-001" }, device_hostname: { device_id: "PC-001" },
    device_system_info: { device_id: "PC-001" }, device_file_list: { device_id: "PC-001", root: "home", path: "." },
    device_file_read: { device_id: "PC-001", root: "home", path: "a.txt" }, device_screenshot: { device_id: "PC-001" },
  };
  for (const name of Object.keys(disabledCalls)) {
    const response = await call("tools/call", { name, arguments: disabledCalls[name] });
    assert.equal(response.result.isError, true);
    assert.equal(response.result.content[0].text, "MCP_NOT_AUTHORIZED");
  }
  const unknown = await call("unknown/method");
  assert.equal(unknown.error.code, -32601);
  const invalid = await call("tools/call", { name: "device.hostname", arguments: { device_id: "PC-001", command: "powershell" } });
  assert.equal(invalid.result.isError, true);
  assert.equal(invalid.result.content[0].text, "INVALID_ARGUMENTS");
});

test("enabled MCP rejects non-loopback endpoints before credential access", async (t) => {
  const child = spawn(process.execPath, [path.join(__dirname, "mcp/remote-device.js")], {
    env: { PATH: process.env.PATH, WITT_REMOTE_DEVICE_MCP_ENABLED: "1",
      DROP_VAULT_TOKEN_FILE: path.join(__dirname, "nonexistent-device-test-token"),
      WITT_DEVICE_MCP_API: "https://example.com" },
    stdio: ["pipe", "pipe", "ignore"],
  });
  t.after(() => child.kill("SIGTERM"));
  const lines = readline.createInterface({ input: child.stdout });
  const response = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("MCP_TIMEOUT")), 3000);
    lines.once("line", (line) => { clearTimeout(timer); resolve(JSON.parse(line)); });
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "device_list", arguments: {} } }) + "\n");
  const value = await response;
  assert.equal(value.result.isError, true);
  assert.equal(value.result.content[0].text, "MCP_API_MUST_BE_LOOPBACK");
});

test("enabled MCP forwards strict file arguments and returns screenshots as image content", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "witt-device-mcp-"));
  const tokenFile = path.join(dir, "token");
  fs.writeFileSync(tokenFile, "test-api-token", { mode: 0o600 });
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
      calls.push({ method: req.method, path: req.url, body });
      let payload = {};
      if (req.url === "/internal/devices" && req.method === "GET") payload = { devices: [] };
      else if (req.url.endsWith("/files/list")) payload = { result: { exit_code: 0, stdout: "[]", stderr: "" } };
      else if (req.url.endsWith("/screenshot")) payload = {
        result: { exit_code: 0, mime: "image/jpeg", data: Buffer.from("jpeg").toString("base64") },
      };
      else payload = { result: { exit_code: 0, stdout: "{}", stderr: "" } };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const child = spawn(process.execPath, [path.join(__dirname, "mcp/remote-device.js")], {
    env: { ...process.env, WITT_REMOTE_DEVICE_MCP_ENABLED: "1",
      DROP_VAULT_TOKEN_FILE: tokenFile,
      WITT_DEVICE_MCP_API: `http://127.0.0.1:${server.address().port}` },
    stdio: ["pipe", "pipe", "ignore"],
  });
  t.after(() => {
    child.kill("SIGTERM");
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  lines.on("line", (line) => {
    const value = JSON.parse(line);
    pending.get(value.id)?.(value);
  });
  let nextID = 0;
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextID;
    const timer = setTimeout(() => reject(new Error("MCP_TIMEOUT")), 3000);
    pending.set(id, (value) => { clearTimeout(timer); pending.delete(id); resolve(value); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const listed = await call("tools/list");
  assert.equal(listed.result.tools.find((tool) => tool.name === "device_file_list").inputSchema.additionalProperties, false);
  const fileList = await call("tools/call", { name: "device_file_list",
    arguments: { device_id: "PC-001", root: "desktop", path: "project" } });
  assert.equal(fileList.result.content[0].text, JSON.stringify({ exit_code: 0, stdout: "[]", stderr: "" }));
  assert.deepEqual(calls.at(-1).body, { root: "desktop", path: "project" });
  const screenshot = await call("tools/call", { name: "device.screenshot", arguments: { device_id: "PC-001" } });
  assert.equal(screenshot.result.content[0].type, "image");
  assert.equal(screenshot.result.content[0].mimeType, "image/jpeg");
  assert.equal(Buffer.from(screenshot.result.content[0].data, "base64").toString(), "jpeg");
  const before = calls.length;
  const invalid = await call("tools/call", { name: "device_file_read",
    arguments: { device_id: "PC-001", root: "desktop", path: "../escape" } });
  assert.equal(invalid.result.isError, true);
  assert.equal(invalid.result.content[0].text, "INVALID_ARGUMENTS");
  assert.equal(calls.length, before);
  lines.close();
});
