"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const { once } = require("node:events");
const WebSocket = require("ws");
const { DeviceRegistry } = require("./remote-device/device-registry");
const { DeviceGateway } = require("./remote-device/device-gateway");

const TOKEN = "device-test-token-0123456789-abcdef";

async function setup(t, clock = () => Date.now()) {
  const registry = new DeviceRegistry({ devices: [{
    device_id: "PC-001", label: "Customer A - Laptop", customer_name: "Customer A",
    token_sha256: crypto.createHash("sha256").update(TOKEN).digest("hex"),
  }] });
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  const gateway = new DeviceGateway({ registry, now: clock });
  gateway.attach(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `ws://127.0.0.1:${server.address().port}/device/ws`;
  t.after(async () => {
    gateway.close();
    await new Promise((resolve) => server.close(resolve));
  });
  return { gateway, registry, url };
}

function nextMessage(ws) {
  return new Promise((resolve, reject) => {
    ws.once("message", (data) => {
      try { resolve(JSON.parse(data.toString())); } catch (error) { reject(error); }
    });
    ws.once("error", reject);
  });
}

async function connect(url, token = TOKEN, hostname = "DESKTOP-ABC") {
  const ws = new WebSocket(url, { headers: {
    Authorization: `Bearer ${token}`, "X-Witt-Device-Id": "PC-001",
  } });
  await once(ws, "open");
  const registered = nextMessage(ws);
  ws.send(JSON.stringify({ v: 1, type: "register", device_id: "PC-001",
    agent_version: "0.1.0", hostname }));
  assert.equal((await registered).type, "registered");
  return ws;
}

test("rejects wrong device token before upgrade", async (t) => {
  const { url, registry } = await setup(t);
  const ws = new WebSocket(url, { headers: {
    Authorization: "Bearer wrong-device-token-0123456789",
    "X-Witt-Device-Id": "PC-001",
  } });
  const [, response] = await once(ws, "unexpected-response");
  assert.equal(response.statusCode, 401);
  response.resume();
  assert.equal(registry.describe("PC-001").status, "offline");
});

test("register, heartbeat, command result and allowlist", async (t) => {
  const { url, gateway, registry } = await setup(t);
  const ws = await connect(url);
  assert.equal(registry.describe("PC-001").status, "online");
  assert.equal(registry.describe("PC-001").hostname, "DESKTOP-ABC");
  const ack = nextMessage(ws);
  ws.send(JSON.stringify({ v: 1, type: "heartbeat", id: "h-1" }));
  assert.equal((await ack).type, "heartbeat_ack");
  const command = nextMessage(ws);
  const pending = gateway.dispatcher.dispatch("PC-001", "system", { command: "hostname" });
  const packet = await command;
  assert.equal(packet.args.command, "hostname");
  ws.send(JSON.stringify({ v: 1, type: "result", id: packet.id,
    device_id: "PC-001", exit_code: 0, stdout: "DESKTOP-ABC\r\n",
    stderr: "", duration_ms: 80 }));
  const result = await pending;
  assert.equal(result.stdout, "DESKTOP-ABC\r\n");
  assert.equal(result.exit_code, 0);
  assert.throws(() => gateway.dispatcher.dispatch("PC-001", "system",
    { command: "powershell" }), { code: "COMMAND_NOT_ALLOWED" });
  ws.close();
});

test("duplicate device replaces old session and fails pending command", async (t) => {
  const { url, gateway, registry } = await setup(t);
  const first = await connect(url);
  const packet = nextMessage(first);
  const pending = gateway.dispatcher.dispatch("PC-001", "system", { command: "hostname" });
  const rejected = assert.rejects(pending, { code: "DEVICE_DISCONNECTED" });
  await packet;
  const second = await connect(url, TOKEN, "DESKTOP-NEW");
  await rejected;
  assert.equal(registry.describe("PC-001").hostname, "DESKTOP-NEW");
  first.terminate();
  second.close();
});

test("disconnect fails in-flight command and never replays it", async (t) => {
  const { url, gateway } = await setup(t);
  const first = await connect(url);
  const packet = nextMessage(first);
  const pending = gateway.dispatcher.dispatch("PC-001", "system", { command: "hostname" });
  await packet;
  first.close();
  await assert.rejects(pending, { code: "DEVICE_DISCONNECTED" });
  const second = await connect(url);
  let replayed = false;
  second.once("message", () => { replayed = true; });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(replayed, false);
  second.close();
});

test("command timeout and heartbeat expiry mark device offline", async (t) => {
  let now = Date.now();
  const { url, gateway, registry } = await setup(t, () => now);
  const ws = await connect(url);
  const packet = nextMessage(ws);
  const pending = gateway.dispatcher.dispatch("PC-001", "system",
    { command: "hostname" }, 1000);
  await packet;
  await assert.rejects(pending, { code: "COMMAND_TIMEOUT" });
  now += 61000;
  assert.throws(() => gateway.dispatcher.dispatch("PC-001", "system", { command: "hostname" }),
    { code: "DEVICE_OFFLINE" });
  gateway.sweep();
  assert.equal(registry.describe("PC-001", now).status, "offline");
  ws.terminate();
});

test("output limit includes UTF-8 bytes and preserves agent truncation", async (t) => {
  const { gateway, url } = await setup(t);
  const ws = await connect(url);
  const command = nextMessage(ws);
  const pending = gateway.dispatcher.dispatch("PC-001", "system", { command: "hostname" });
  const packet = await command;
  ws.send(JSON.stringify({ v: 1, type: "result", id: packet.id, device_id: "PC-001",
    exit_code: 0, stdout: "x", stderr: "", truncated: true }));
  assert.equal((await pending).truncated, true);
  const { limitOutput, MAX_OUTPUT_BYTES } = require("./remote-device/protocol");
  const result = limitOutput("界".repeat(90000), "error".repeat(1000));
  assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= MAX_OUTPUT_BYTES);
  assert.equal(result.truncated, true);
  ws.close();
});

test("forged and late results cannot resolve another command", async (t) => {
  const { gateway, url } = await setup(t);
  const ws = await connect(url);
  const command = nextMessage(ws);
  const pending = gateway.dispatcher.dispatch("PC-001", "system", { command: "hostname" });
  const packet = await command;
  assert.equal(gateway.dispatcher.result({}, { id: packet.id, device_id: "PC-001" }), false);
  assert.equal(gateway.dispatcher.pending.size, 1);
  ws.send(JSON.stringify({ v: 1, type: "result", id: packet.id, device_id: "PC-001",
    exit_code: 0, stdout: "real", stderr: "" }));
  assert.equal((await pending).stdout, "real");
  assert.equal(gateway.dispatcher.result(gateway.registry.session("PC-001"),
    { id: packet.id, device_id: "PC-001" }), false);
  ws.close();
});

test("only one in-flight command is allowed per device", async (t) => {
  const { gateway, url } = await setup(t);
  const ws = await connect(url);
  const command = nextMessage(ws);
  const pending = gateway.dispatcher.dispatch("PC-001", "system", { command: "hostname" });
  const packet = await command;
  assert.throws(() => gateway.dispatcher.dispatch("PC-001", "system", { command: "hostname" }),
    { code: "DEVICE_BUSY" });
  ws.send(JSON.stringify({ v: 1, type: "result", id: packet.id, device_id: "PC-001",
    exit_code: 0, stdout: "first", stderr: "" }));
  assert.equal((await pending).stdout, "first");
  const again = nextMessage(ws);
  const next = gateway.dispatcher.dispatch("PC-001", "system", { command: "hostname" });
  const nextPacket = await again;
  ws.send(JSON.stringify({ v: 1, type: "result", id: nextPacket.id, device_id: "PC-001",
    exit_code: 0, stdout: "second", stderr: "" }));
  assert.equal((await next).stdout, "second");
  ws.close();
});

test("offline device retains last observed metadata without credentials", async (t) => {
  const { registry, url } = await setup(t);
  const ws = await connect(url);
  const before = registry.describe("PC-001");
  const closed = once(ws, "close");
  ws.close(); await closed;
  const after = registry.describe("PC-001");
  assert.equal(after.status, "offline");
  assert.equal(after.hostname, before.hostname);
  assert.equal(after.agent_version, before.agent_version);
  assert.equal(after.last_seen, before.last_seen);
  assert.equal(JSON.stringify(after).includes(TOKEN), false);
  assert.equal(Object.keys(after).some((key) => /token|hash/i.test(key)), false);
});
