"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
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
  assert.deepEqual(discovered.map((tool) => tool.name), ["device_list", "device_get", "device_hostname"]);
  assert.ok(discovered.every((tool) => /^[A-Za-z0-9_-]+$/.test(tool.name)));
  assert.deepEqual(discovered.map((tool) => tool.description.split(":")[0]), ["device.list", "device.get", "device.hostname"]);
  for (const name of ["device_list", "device_get", "device_hostname", "device.list", "device.get", "device.hostname"]) {
    const response = await call("tools/call", { name, arguments: ["device.list", "device_list"].includes(name) ? {} : { device_id: "PC-001" } });
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
