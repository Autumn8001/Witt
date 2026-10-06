"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const { once } = require("node:events");
const WebSocket = require("ws");
const { DeviceGateway } = require("./remote-device/device-gateway");
const { DeviceRegistry } = require("./remote-device/device-registry");

const TOKEN = "workspace-transport-token-0123456789";
const WORKSPACE_CAPABILITIES = [
  "workspace.list", "workspace.read", "workspace.write", "workspace.patch", "workspace.exec",
];

async function setup(t) {
  const registry = new DeviceRegistry({ devices: [{
    device_id: "PC-001",
    token_sha256: crypto.createHash("sha256").update(TOKEN).digest("hex"),
    capabilities: WORKSPACE_CAPABILITIES,
    allowed_roots: ["project"],
  }] });
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  const gateway = new DeviceGateway({ registry });
  gateway.attach(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    gateway.close();
    await new Promise((resolve) => server.close(resolve));
  });
  return { gateway, registry, url: `ws://127.0.0.1:${server.address().port}/device/ws` };
}

function nextMessage(ws) {
  return new Promise((resolve, reject) => {
    ws.once("message", (data) => {
      try { resolve(JSON.parse(data.toString("utf8"))); } catch (error) { reject(error); }
    });
    ws.once("error", reject);
  });
}

async function connect(url, capabilities = WORKSPACE_CAPABILITIES) {
  const ws = new WebSocket(url, { headers: {
    Authorization: `Bearer ${TOKEN}`, "X-Witt-Device-Id": "PC-001",
  } });
  await once(ws, "open");
  const registered = nextMessage(ws);
  ws.send(JSON.stringify({ v: 1, type: "register", id: "register-1", device_id: "PC-001",
    hostname: "CUSTOMER-PC", agent_version: "0.2.0", capabilities, roots: ["project"] }));
  await registered;
  return ws;
}

function workspaceArgs(operation, extra = {}) {
  return { operation, root: "project", ...extra };
}

test("workspace capabilities negotiate with the existing device allowlist", async (t) => {
  const { gateway, registry, url } = await setup(t);
  const ws = await connect(url, ["workspace.read", "workspace.exec", "system.hostname"]);
  assert.deepEqual(registry.describe("PC-001").capabilities, ["workspace.read", "workspace.exec"]);
  const command = nextMessage(ws);
  const pending = gateway.dispatcher.dispatch("PC-001", "workspace", workspaceArgs("workspace.read", { path: "src/app.js" }));
  const packet = await command;
  assert.equal(packet.tool, "workspace");
  assert.deepEqual(packet.args, workspaceArgs("workspace.read", { path: "src/app.js" }));
  ws.send(JSON.stringify({ v: 1, type: "result", id: packet.id, device_id: "PC-001",
    exit_code: 0, stdout: "content", stderr: "" }));
  assert.equal((await pending).stdout, "content");
  ws.close();
});

test("workspace transport rejects a root that was not negotiated with the Agent", async (t) => {
  const { gateway, url } = await setup(t);
  const ws = await connect(url, ["workspace.read"]);
  assert.throws(
    () => gateway.dispatcher.dispatch("PC-001", "workspace", { operation: "workspace.read", root: "other", path: "src/app.js" }),
    { code: "ROOT_NOT_ALLOWED" },
  );
  ws.close();
});

test("workspace packets carry the immutable session and approval transport context", async (t) => {
  const { gateway, url } = await setup(t);
  const ws = await connect(url, ["workspace.exec"]);
  const command = nextMessage(ws);
  const args = workspaceArgs("workspace.exec", { program: "npm", argv: ["install"], cwd: "." });
  const pending = gateway.dispatcher.dispatch("PC-001", "workspace", args, 1_000, {
    workspaceSessionId: "770e8400-e29b-41d4-a716-446655440000",
    approval: { id: "approved-intent-1", confirmed: true },
  });
  const packet = await command;
  assert.equal(packet.workspace_session_id, "770e8400-e29b-41d4-a716-446655440000");
  assert.deepEqual(packet.approval, { id: "approved-intent-1", confirmed: true });
  assert.deepEqual(packet.args, args);
  ws.send(JSON.stringify({ v: 1, type: "result", id: packet.id, device_id: "PC-001",
    exit_code: 0, stdout: "installed", stderr: "" }));
  assert.equal((await pending).stdout, "installed");
  assert.equal(gateway.dispatcher.result(gateway.registry.session("PC-001"), {
    id: packet.id, device_id: "PC-001", exit_code: 0,
  }), false, "a late result cannot settle an already completed request");
  ws.close();
});

test("a sent workspace write that disconnects has an unknown execution state and is never replayed", async (t) => {
  const { gateway, url } = await setup(t);
  const first = await connect(url, ["workspace.write"]);
  const command = nextMessage(first);
  const pending = gateway.dispatcher.dispatch("PC-001", "workspace", workspaceArgs("workspace.write", {
    path: "src/app.js", content: "new text", expected_sha256: "a".repeat(64),
  }));
  await command;
  first.close();
  await assert.rejects(pending, { code: "EXECUTION_STATE_UNKNOWN" });
  const second = await connect(url, ["workspace.write"]);
  let replayed = false;
  second.once("message", () => { replayed = true; });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(replayed, false);
  second.close();
});

test("a sent workspace exec timeout has an unknown execution state", async (t) => {
  const { gateway, url } = await setup(t);
  const ws = await connect(url, ["workspace.exec"]);
  const command = nextMessage(ws);
  const pending = gateway.dispatcher.dispatch("PC-001", "workspace", workspaceArgs("workspace.exec", {
    program: "npm", argv: ["test"], cwd: ".",
  }), 1_000);
  await command;
  await assert.rejects(pending, { code: "EXECUTION_STATE_UNKNOWN" });
  ws.close();
});

test("a workspace read disconnect keeps the existing deterministic error", async (t) => {
  const { gateway, url } = await setup(t);
  const ws = await connect(url, ["workspace.read"]);
  const command = nextMessage(ws);
  const pending = gateway.dispatcher.dispatch("PC-001", "workspace", workspaceArgs("workspace.read", { path: "src/app.js" }));
  await command;
  ws.close();
  await assert.rejects(pending, { code: "DEVICE_DISCONNECTED" });
});
