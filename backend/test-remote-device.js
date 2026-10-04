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

async function setup(t, clock = () => Date.now(), device = null) {
  const configuredDevice = device || {
    device_id: "PC-001", label: "Customer A - Laptop", customer_name: "Customer A",
    token_sha256: crypto.createHash("sha256").update(TOKEN).digest("hex"),
  };
  const registry = new DeviceRegistry({ devices: [{
    ...configuredDevice,
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

async function connect(url, token = TOKEN, hostname = "DESKTOP-ABC", capabilities, roots) {
  const ws = new WebSocket(url, { headers: {
    Authorization: `Bearer ${token}`, "X-Witt-Device-Id": "PC-001",
  } });
  await once(ws, "open");
  const registered = nextMessage(ws);
  const registration = { v: 1, type: "register", device_id: "PC-001",
    agent_version: "0.1.0", hostname };
  if (capabilities !== undefined) registration.capabilities = capabilities;
  if (roots !== undefined) registration.roots = roots;
  ws.send(JSON.stringify(registration));
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
  assert.deepEqual(registry.describe("PC-001").capabilities, ["system.hostname"]);
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
  assert.throws(() => gateway.dispatcher.dispatch("PC-001", "system", { command: "info" }),
    { code: "CAPABILITY_NOT_ALLOWED" });
  assert.throws(() => gateway.dispatcher.dispatch("PC-001", "system",
    { command: "powershell" }), { code: "COMMAND_NOT_ALLOWED" });
  ws.close();
});

test("capabilities and root aliases are negotiated as an intersection", async (t) => {
  const device = {
    device_id: "PC-001", label: "Customer A", customer_name: "Customer A",
    token_sha256: crypto.createHash("sha256").update(TOKEN).digest("hex"),
    capabilities: ["system.hostname", "system.info", "filesystem.list", "filesystem.read", "screen.capture"],
    allowed_roots: ["desktop", "documents"],
  };
  const { gateway, registry, url } = await setup(t, () => Date.now(), device);
  const ws = await connect(url, TOKEN, "DESKTOP-ABC",
    ["system.hostname", "system.info", "filesystem.list", "filesystem.read", "screen.capture"], ["desktop", "unknown"]);
  assert.deepEqual(registry.describe("PC-001").capabilities,
    ["system.hostname", "system.info", "filesystem.list", "filesystem.read", "screen.capture"]);
  assert.deepEqual(registry.describe("PC-001").allowed_roots, ["desktop"]);
  const infoPacket = nextMessage(ws);
  const info = gateway.dispatcher.dispatch("PC-001", "system", { command: "info" });
  ws.send(JSON.stringify({ v: 1, type: "result", id: (await infoPacket).id, device_id: "PC-001",
    exit_code: 0, stdout: JSON.stringify({ os: "windows", home_dir: "C:/Users/customer", token: "secret" }), stderr: "" }));
  assert.deepEqual(JSON.parse((await info).stdout), { os: "windows" });
  const listPacket = nextMessage(ws);
  const listing = gateway.dispatcher.dispatch("PC-001", "filesystem",
    { operation: "list", root: "desktop", path: "." });
  ws.send(JSON.stringify({ v: 1, type: "result", id: (await listPacket).id, device_id: "PC-001",
    exit_code: 0, stdout: "file.txt", stderr: "" }));
  assert.equal((await listing).stdout, "file.txt");
  assert.throws(() => gateway.dispatcher.dispatch("PC-001", "filesystem",
    { operation: "read", root: "documents", path: "a.txt" }), { code: "ROOT_NOT_ALLOWED" });
  assert.throws(() => gateway.dispatcher.dispatch("PC-001", "filesystem",
    { operation: "list", root: "desktop", path: "../escape" }), { code: "INVALID_ARGUMENTS" });
  ws.close();
});

test("screen attachments enforce JPEG and decoded byte limits", async (t) => {
  const device = {
    device_id: "PC-001", label: "Customer A", customer_name: "Customer A",
    token_sha256: crypto.createHash("sha256").update(TOKEN).digest("hex"),
    capabilities: ["screen.capture"], allowed_roots: [],
  };
  const { gateway, url } = await setup(t, () => Date.now(), device);
  const ws = await connect(url, TOKEN, "DESKTOP-ABC", ["screen.capture"], []);
  const packet = nextMessage(ws);
  const pending = gateway.dispatcher.dispatch("PC-001", "screen", { operation: "capture" });
  const command = await packet;
  const image = Buffer.from("jpeg-test").toString("base64");
  ws.send(JSON.stringify({ v: 1, type: "result", id: command.id, device_id: "PC-001",
    exit_code: 0, mime: "image/jpeg", data: image }));
  const result = await pending;
  assert.equal(result.mime, "image/jpeg");
  assert.equal(Buffer.from(result.data, "base64").toString(), "jpeg-test");
  const invalidPacket = nextMessage(ws);
  const invalid = gateway.dispatcher.dispatch("PC-001", "screen", { operation: "capture" });
  const invalidCommand = await invalidPacket;
  ws.send(JSON.stringify({ v: 1, type: "result", id: invalidCommand.id, device_id: "PC-001",
    exit_code: 0, mime: "image/png", data: image }));
  await assert.rejects(invalid, { code: "INVALID_ATTACHMENT" });
  const oversizedPacket = nextMessage(ws);
  const oversized = gateway.dispatcher.dispatch("PC-001", "screen", { operation: "capture" });
  const oversizedCommand = await oversizedPacket;
  ws.send(JSON.stringify({ v: 1, type: "result", id: oversizedCommand.id, device_id: "PC-001",
    exit_code: 0, mime: "image/jpeg", data: Buffer.alloc(1.25 * 1024 * 1024 + 1).toString("base64") }));
  await assert.rejects(oversized, { code: "ATTACHMENT_TOO_LARGE" });
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
