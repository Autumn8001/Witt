"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const crypto = require("node:crypto");
const { execFileSync, spawn } = require("node:child_process");
const { once } = require("node:events");
const readline = require("node:readline");
const { DeviceRegistry } = require("./remote-device/device-registry");
const { DeviceGateway } = require("./remote-device/device-gateway");
const { chromium } = require("playwright");
const { GrokBuildAdapter } = require("./runtime/grok-build-adapter");
const { redactHarnessText } = require("./runtime/tool-content");
const { createDeviceRoutes } = require("./routes/devices");

async function until(predicate, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("condition timed out");
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      resolve();
    };
    const forceTimer = setTimeout(() => {
      child.kill("SIGKILL");
      finish();
    }, 3000);
    forceTimer.unref?.();
    child.once("exit", finish);
    child.kill("SIGTERM");
  });
}

test("native Go agent completes a real TLS WebSocket hostname round trip", { timeout: process.env.WITT_DEVICE_LIVE_GROK === "1" ? 660000 : 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "witt-agent-wss-"));
  const token = crypto.randomBytes(32).toString("hex");
  const tokenFile = path.join(dir, "token");
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  const cert = path.join(dir, "cert.pem");
  const key = path.join(dir, "key.pem");
  const binary = path.join(dir, "remote-agent");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
  execFileSync("go", ["build", "-o", binary, "."], {
    cwd: path.join(__dirname, "../agent/windows"), stdio: "ignore",
  });
  const registry = new DeviceRegistry({ devices: [{
    device_id: "PC-001", label: "Test", token_sha256: crypto.createHash("sha256").update(token).digest("hex"),
  }] });
  const gateway = new DeviceGateway({ registry });
  const routes = createDeviceRoutes({
    gateway, authorized: (req) => req.headers.authorization === "Bearer test-api-auth",
    sendJson: (res, status, value) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); },
  });
  const internalCalls = [];
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) },
    (req, res) => {
      const url = new URL(req.url, "https://localhost");
      const assets = {
        "/vault/customer-devices.js": ["application/javascript", "customer-devices.js"],
        "/vault/customer-devices.css": ["text/css", "customer-devices.css"],
      };
      if (assets[url.pathname]) {
        const [type, name] = assets[url.pathname];
        res.writeHead(200, { "Content-Type": type });
        res.end(fs.readFileSync(path.join(__dirname, "../web", name))); return;
      }
      if (url.pathname === "/vault/device-test") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/vault/customer-devices.css"></head><body><aside id="adminSettingsSheet"><section id="customerDevices"><header><h3>Devices</h3><button data-refresh-devices>刷新</button></header><p data-customer-status></p><div data-customer-list></div></section></aside><script src="/vault/customer-devices.js"></script></body></html>'); return;
      }
      if (url.pathname.startsWith("/vault-api/")) url.pathname = url.pathname.slice("/vault-api".length);
      if (url.pathname.startsWith("/internal/devices")) internalCalls.push(req.method + " " + url.pathname);
      if (routes.handleInternal(req, res, url)) return;
      if (routes.handlePublic(req, res, url, { admin: req.headers.authorization === "Bearer test-api-auth" })) return;
      res.writeHead(404); res.end();
    });
  gateway.attach(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  let browser = null;
  let mcp = null;
  let lines = null;
  const agent = spawn(binary, ["-gateway", `wss://127.0.0.1:${server.address().port}/device/ws`,
    "-device-id", "PC-001", "-token-file", tokenFile], {
    env: { PATH: process.env.PATH, SSL_CERT_FILE: cert }, stdio: "ignore",
  });
  t.after(async () => {
    lines?.close();
    await Promise.all([stopChild(agent), stopChild(mcp)]);
    await browser?.close();
    gateway.close();
    for (const ws of gateway.wss.clients) ws.terminate();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await until(() => registry.describe("PC-001").status === "online");
  const request = (pathname, method = "GET", headers = {}) => new Promise((resolve, reject) => {
    const req = https.request({ hostname: "127.0.0.1", port: server.address().port,
      path: pathname, method, ca: fs.readFileSync(cert),
      headers: { Authorization: "Bearer test-api-auth", ...headers },
    }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on("error", reject); req.end();
  });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true,
    extraHTTPHeaders: { Authorization: "Bearer test-api-auth" },
  });
  const uiErrors = [];
  page.on("pageerror", (error) => uiErrors.push(error.message));
  await page.goto("https://127.0.0.1:" + server.address().port + "/vault/device-test");
  await page.locator("[data-refresh-devices]").click();
  await page.waitForFunction(() => document.querySelector("[data-hostname='PC-001']")?.disabled === false);
  await page.locator("[data-hostname='PC-001']").click();
  await page.waitForFunction((expected) =>
    document.querySelector(".customer-device output")?.textContent.trim().toLowerCase() === expected,
    os.hostname().toLowerCase());
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.setViewportSize({ width: 844, height: 390 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  const apiTokenFile = path.join(dir, "api-token");
  fs.writeFileSync(apiTokenFile, "test-api-auth", { mode: 0o600 });
  mcp = spawn(process.execPath, [path.join(__dirname, "mcp/remote-device.js")], {
    env: { PATH: process.env.PATH, WITT_REMOTE_DEVICE_MCP_ENABLED: "1",
      WITT_DEVICE_MCP_API: "https://127.0.0.1:" + server.address().port,
      DROP_VAULT_TOKEN_FILE: apiTokenFile, NODE_EXTRA_CA_CERTS: cert },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const responses = new Map();
  lines = readline.createInterface({ input: mcp.stdout });
  lines.on("line", (line) => {
    const value = JSON.parse(line);
    responses.get(value.id)?.(value);
  });
  let rpcID = 0;
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++rpcID;
    const timer = setTimeout(() => { responses.delete(id); reject(new Error("MCP_RESPONSE_TIMEOUT")); }, 10000);
    responses.set(id, (value) => { clearTimeout(timer); responses.delete(id); resolve(value); });
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  assert.equal((await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {} })).result.serverInfo.name, "witt-remote-device");
  const tools = (await rpc("tools/list")).result.tools;
  assert.deepEqual(tools.map((tool) => tool.name), ["device_list", "device_get", "device_hostname"]);
  const invoke = async (name, args = {}) => {
    const response = await rpc("tools/call", { name, arguments: args });
    return response.result;
  };
  const listResult = await invoke("device_list");
  assert.equal(JSON.parse(listResult.content[0].text)[0].status, "online");
  const getResult = await invoke("device_get", { device_id: "PC-001" });
  assert.equal(JSON.parse(getResult.content[0].text).device_id, "PC-001");
  const hostnameResult = await invoke("device_hostname", { device_id: "PC-001" });
  assert.equal(JSON.parse(hostnameResult.content[0].text).stdout.trim().toLowerCase(), os.hostname().toLowerCase());
  assert.equal((await invoke("device_hostname", { device_id: "PC-001", command: "powershell" })).isError, true);
  assert.equal((await invoke("device_get", { device_id: "../PC-001" })).isError, true);
  if (process.env.WITT_DEVICE_LIVE_GROK === "1") {
    assert.ok(process.env.WITT_CPA_API_KEY, "GROK_AUTH_ENV_REQUIRED");
    execFileSync("git", ["init", "--quiet", "--initial-branch=platform/personal-ai-ops", dir], { stdio: "ignore" });
    fs.mkdirSync(path.join(dir, ".grok"), { mode: 0o700 });
    const config = [
      "[mcp_servers.witt_remote_device]", 'command = "node"',
      "args = [" + JSON.stringify(path.join(__dirname, "mcp/remote-device.js")) + "]",
      "enabled = true", "[mcp_servers.witt_remote_device.env]",
      'WITT_REMOTE_DEVICE_MCP_ENABLED = "1"',
      "WITT_DEVICE_MCP_API = " + JSON.stringify("https://127.0.0.1:" + server.address().port),
      "DROP_VAULT_TOKEN_FILE = " + JSON.stringify(apiTokenFile),
      "NODE_EXTRA_CA_CERTS = " + JSON.stringify(cert), "",
    ].join("\n");
    fs.writeFileSync(path.join(dir, ".grok/config.toml"), config, { mode: 0o600 });
    let doctor;
    try {
      doctor = execFileSync("/usr/local/bin/grok", ["--trust", "--cwd", dir, "mcp", "doctor", "witt_remote_device", "--json"],
        { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000 });
    } catch (error) {
      doctor = String(error.stdout || "") + String(error.stderr || "");
    }
    const safeDoctor = redactHarnessText(doctor
      .split(process.env.WITT_CPA_API_KEY).join("[REDACTED]").split(token).join("[REDACTED]"));
    console.log("Isolated device MCP doctor:", safeDoctor.slice(0, 2000));
    let doctorReport;
    try { doctorReport = JSON.parse(doctor); } catch { assert.fail("MCP_DOCTOR_INVALID_RESPONSE"); }
    assert.equal(doctorReport.healthy_count, 1, "GROK_MCP_ADMISSION_FAILED");
    const grok = new GrokBuildAdapter({
      bin: "/usr/local/bin/grok", model: "grok-4.7-high", cwd: dir,
      envValue: process.env.WITT_CPA_API_KEY, remoteDeviceMcpEnabled: true,
      permissionMode: "bypassPermissions", reasoningEffort: "low", timeoutMs: 600000,
    });
    t.after(() => grok.stopRuntime());
    const buildArgs = grok.buildArgs.bind(grok);
    const leaderSocket = path.join(dir, "g.sock");
    grok.buildArgs = (params) => [...buildArgs(params), "--trust", "--leader-socket", leaderSocket];
    t.after(() => {
      for (const entry of fs.readdirSync("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          const argv = fs.readFileSync("/proc/" + entry + "/cmdline", "utf8").split("\0");
          if (argv.includes(leaderSocket) && path.basename(fs.readlinkSync("/proc/" + entry + "/exe")) === "grok")
            process.kill(Number(entry), "SIGTERM");
        } catch {}
      }
    });
    const beforeGrokCalls = internalCalls.length;
    const turn = grok.sendPrompt({
      prompt: "Use ONLY the witt_remote_device MCP tools: device_list (device.list), then device_get (device.get) for PC-001, then device_hostname (device.hostname) for PC-001. Do not run a local command or read any local files. Reply with only the actual hostname returned by device_hostname.",
      maxTurns: 16, disallowedTools: ["run_command,read_file,write_file,edit_file,search_replace,web_search,web_fetch"],
    });
    let text = "";
    const failures = [];
    const originalParser = turn.process.parser;
    turn.process.parser = (payload) => {
      if (payload.type === "error") failures.push(JSON.stringify(payload));
      return originalParser(payload);
    };
    const eventTypes = new Set();
    let turnLimitReached = false;
    const calls = [];
    turn.events.on("event", (event) => {
      eventTypes.add(event.type);
      if (event.type === "notice" && event.kind === "max_turns_reached") turnLimitReached = true;
      if (event.type === "notice" || event.type === "unknown") failures.push(JSON.stringify(event.raw || {}));
      if (event.type === "text_delta") text += event.text || "";
      if (event.type === "error") failures.push(String(event.error || event.text || ""));

      if (event.type === "tool_call") {
        calls.push({ name: event.tool, input: event.input });
        console.log("Live Grok tool phase:", ["search_tool", "use_tool"].includes(event.tool) ? event.tool : "other");
      }
    });
    const completed = await turn.done;
    if (!completed.ok) {
      const diagnostic = [completed.stderr, ...(completed.invalidLines || []), ...failures].join(" ");
      const categories = [
        ["auth", /unauthorized|credential|api.?key|WITT_CPA_KEY|authentication/i],
        ["model", /unknown model|model.*not found|invalid model/i],
        ["config", /config|toml|parse/i],
        ["arguments", /unexpected argument|invalid value|Usage:/i],
        ["network", /connection|timeout|connect|tls|certificate/i],
        ["leader", /leader|socket|ipc/i],
        ["permissions", /permission|denied/i],
        ["workspace", /workspace|project|repository|directory|No such file/i],
        ["session", /session|lock/i],
        ["mcp", /MCP|tool/i],
        ["provider", /provider|reasoning|model/i],
        ["http", /HTTP|request|response|status|404|400|401|403|500|429|502|503/i],
      ].filter(([, regex]) => regex.test(diagnostic)).map(([name]) => name);
      const safeDiagnostic = redactHarnessText(diagnostic
        .split(process.env.WITT_CPA_API_KEY).join("[REDACTED]")
        .split(token).join("[REDACTED]"));
      console.log("Grok sanitized failure:", safeDiagnostic.slice(0, 800));
      console.log("Grok failure metadata:", JSON.stringify({ code: completed.code, errorType: completed.errorType,
        categories, eventTypes: [...eventTypes], toolCount: calls.length,
        gatewayCalls: internalCalls.slice(beforeGrokCalls), invalidLineCount: (completed.invalidLines || []).length }));
    }
    console.log("Live Grok Gateway evidence:", JSON.stringify(internalCalls.slice(beforeGrokCalls)));
    if (completed.ok && !text.toLowerCase().includes(os.hostname().toLowerCase())) {
      const safeText = redactHarnessText(text
        .split(process.env.WITT_CPA_API_KEY).join("[REDACTED]").split(token).join("[REDACTED]"));
      console.log("Grok sanitized incomplete response:", safeText.slice(0, 600));
    }
    assert.equal(completed.ok, true, "GROK_NATIVE_TURN_FAILED");
    assert.equal(turnLimitReached, false, "GROK_NATIVE_TURN_LIMIT");
    assert.ok(text.toLowerCase().includes(os.hostname().toLowerCase()), "GROK_NATIVE_HOSTNAME_MISSING");
    for (const name of ["device_list", "device_get", "device_hostname"]) {
      assert.ok(calls.some((call) => JSON.stringify(call).includes(name)), "GROK_TOOL_NOT_CALLED:" + name);
    }
    const grokCalls = internalCalls.slice(beforeGrokCalls);
    for (const request of ["GET /internal/devices", "GET /internal/devices/PC-001", "POST /internal/devices/PC-001/hostname"]) {
      assert.ok(grokCalls.includes(request), "GROK_GATEWAY_CALL_MISSING:" + request);
    }
    console.log("Live Grok Adapter -> MCP -> native Linux WSS Agent: PASS (Windows NOT TESTED)");
  }
  const devices = await request("/customer-devices");
  assert.equal(devices.body.devices[0].status, "online");
  assert.equal((await request("/customer-devices/PC-001")).body.device.device_id, "PC-001");
  assert.equal((await request("/customer-devices", "GET", { Authorization: "Bearer invalid" })).status, 403);
  assert.equal((await request("/internal/devices", "GET", { "X-Forwarded-For": "203.0.113.1" })).status, 403);
  assert.equal((await request("/internal/devices")).status, 200);
  const response = await request("/customer-devices/PC-001/hostname", "POST");
  assert.equal(response.status, 200);
  const result = response.body.result;
  assert.equal(result.exit_code, 0, JSON.stringify(result));
  assert.equal(result.stdout.trim().toLowerCase(), os.hostname().toLowerCase());
  assert.equal(result.stderr, "");
  assert.throws(() => gateway.dispatcher.dispatch("PC-001", "system", { command: "powershell" }),
    { code: "COMMAND_NOT_ALLOWED" });
  registry.session("PC-001").ws.terminate();
  await until(() => registry.describe("PC-001").status === "offline");
  await until(() => registry.describe("PC-001").status === "online");
  const reconnected = await request("/customer-devices/PC-001/hostname", "POST");
  assert.equal(reconnected.body.result.stdout.trim().toLowerCase(), os.hostname().toLowerCase());
  agent.kill("SIGTERM");
  await until(() => registry.describe("PC-001").status === "offline");
  assert.throws(() => gateway.dispatcher.dispatch("PC-001", "system", { command: "hostname" }),
    { code: "DEVICE_OFFLINE" });
  await page.locator("[data-refresh-devices]").click();
  await page.waitForFunction(() => document.querySelector("[data-hostname='PC-001']")?.disabled === true);
  assert.match(await page.locator(".customer-device").innerText(), /离线/);
  assert.equal((await request("/customer-devices/PC-001/hostname", "POST")).status, 503);
  const offlineMcp = await invoke("device_hostname", { device_id: "PC-001" });
  assert.equal(offlineMcp.isError, true);
  assert.equal(offlineMcp.content[0].text, "DEVICE_OFFLINE");
  const offlineGet = await invoke("device_get", { device_id: "PC-001" });
  assert.equal(JSON.parse(offlineGet.content[0].text).status, "offline");
  lines.close();
  lines = null;
  await stopChild(mcp);
  mcp = null;
  assert.deepEqual(uiErrors, []);
  await browser.close();
  browser = null;
});
