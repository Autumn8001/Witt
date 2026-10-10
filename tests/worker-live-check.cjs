"use strict";

// Explicitly opted-in, isolated real-model check. Restarts only its own web
// subprocess; never touches production systemd units or production user data.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { AuthService } = require("../backend/auth-service");
const { WorkerClient } = require("../backend/worker-client");

async function until(check, timeout = 15000) {
  const end = Date.now() + timeout;
  let lastError;
  while (Date.now() < end) {
    try { const result = await check(); if (result) return result; } catch (error) {
      if (error.fatal) throw error;
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`isolated live check timed out${lastError ? `: ${lastError.message}` : ""}`);
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  await exited;
  clearTimeout(timer);
}

async function main() {
  assert.equal(process.env.WITT_RUN_WORKER_LIVE_CHECK, "1", "requires explicit live-check opt-in");
  assert.ok(process.env.WITT_AGY_BIN, "configured Antigravity wrapper is required");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "witt-worker-live-"));
  fs.chmodSync(root, 0o755);
  const workDir = path.join(root, "project");
  fs.mkdirSync(workDir, { mode: 0o777 });
  fs.chmodSync(workDir, 0o777);
  const output = path.join(workDir, "probe.txt");
  fs.writeFileSync(output, "BASE\n", { mode: 0o666 });
  fs.chmodSync(output, 0o666);
  const marker = `WITT_${crypto.randomBytes(8).toString("hex")}`;
  const tokenFile = path.join(root, "token");
  fs.writeFileSync(tokenFile, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  const auth = new AuthService({ dir: path.join(root, "auth"), sendJson() {}, readJsonBody() {} });
  const invite = auth.initialize(crypto.randomBytes(24).toString("hex"));
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  const port = listener.address().port; await new Promise((resolve) => listener.close(resolve));
  const socket = path.join(root, "worker.sock");
  const env = { ...process.env, WITT_WORKER_SOCKET: socket, WITT_WORKER_STATE_DIR: path.join(root, "worker-state"),
    DROP_VAULT_PORT: String(port), DROP_VAULT_TOKEN_FILE: tokenFile,
    DROP_VAULT_AUTH_DIR: path.join(root, "auth"), DROP_VAULT_USERS_DIR: path.join(root, "users"),
    DROP_VAULT_DATA_DIR: path.join(root, "files"), DROP_VAULT_TASK_DIR: path.join(root, "tasks"),
    DROP_VAULT_CHAT_DIR: path.join(root, "chat"), DROP_VAULT_IMAGE_DIR: path.join(root, "images"),
    DROP_VAULT_CODEX_WORKDIR: workDir, WITT_WORKDIR_ROOTS: workDir,
    WITT_RUNTIME_LOG: "0", WITT_REMOTE_DEVICE_MCP_ENABLED: "0", WITT_BROWSER_MCP_ENABLED: "0" };
  const start = (file) => spawn(process.execPath, [path.join(__dirname, "../backend", file)], {
    env, stdio: ["ignore", "ignore", "pipe"],
  });
  let worker, web, client;
  try {
    worker = start("worker-service.js");
    let stderr = ""; worker.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    client = new WorkerClient({ socketPath: socket });
    await until(() => client.isAvailable());
    const workerPid = worker.pid;
    const origin = `http://127.0.0.1:${port}`;
    const startWeb = async () => {
      web = start("server.js"); web.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      await until(async () => (await fetch(`${origin}/health`)).ok);
    };
    await startWeb();
    let response = await fetch(`${origin}/auth/activate`, { method: "POST",
      headers: { "Content-Type": "application/json", "X-Witt-Client": "browser" },
      body: JSON.stringify({ inviteCode: invite.code, deviceId: crypto.randomUUID(), deviceName: "isolated live check" }) });
    assert.equal(response.status, 201);
    const cookie = response.headers.get("set-cookie").split(";", 1)[0];
    const headers = { Cookie: cookie, Origin: origin, "Content-Type": "application/json" };
    const request = async (url, body) => {
      const res = await fetch(origin + url, { method: body ? "POST" : "GET", headers,
        ...(body ? { body: JSON.stringify(body) } : {}) });
      assert.ok(res.ok, `test request ${url} returned ${res.status}`);
      return res.json();
    };
    const { conversation } = await request("/chat/conversations", {
      model: "gemini-3.8-flash-high", accessMode: "danger-full-access", workDir,
    });
    const route = `/chat/conversations/${conversation.id}`;
    await request(`${route}/messages`, { text: `这是独立测试。读取 ${output}，然后用命令等待8秒，再只追加一行 ${marker}（只追加一次）。完成后回答 EDIT_OK。不要修改任何其他文件，不要重启服务。` });
    await until(async () => {
      const assistant = (await request(route)).conversation.messages.find((m) => m.role === "assistant");
      if (!assistant) return false;
      const state = await client.getTurnStatus(conversation.id, assistant.id);
      return state?.ok && state.status === "running";
    });
    await request(`${route}/messages`, { text: `读取 ${output}，确认包含 ${marker}。不要修改文件，只回答 FOLLOWUP_OK。` });
    await stop(web); await startWeb();
    assert.equal(worker.pid, workerPid); assert.equal(worker.exitCode, null);
    const completed = await until(async () => {
      const conv = (await request(route)).conversation;
      const answers = conv.messages.filter((m) => m.role === "assistant");
      const failed = answers.find((m) => ["failed", "interrupted"].includes(m.status));
      if (failed) {
        const error = new Error(`model turn ${failed.status}: ${failed.text.slice(0, 300)}`);
        error.fatal = true;
        throw error;
      }
      return answers.length === 2 && answers.every((m) => m.status === "completed") ? conv : null;
    }, 360000);
    assert.equal(fs.readFileSync(output, "utf8").split(marker).length - 1, 1, "edit must happen exactly once");
    const answers = completed.messages.filter((m) => m.role === "assistant");
    assert.match(answers[0].text, /EDIT_OK/); assert.match(answers[1].text, /FOLLOWUP_OK/);
    console.log("PASS: real Gemini edit survived isolated web restart; queued follow-up completed; single edit verified");
  } finally {
    // Stop only turns registered by this isolated Worker before stopping it.
    const states = path.join(root, "worker-state", "turns");
    if (client && fs.existsSync(states)) {
      for (const name of fs.readdirSync(states).filter((name) => name.endsWith(".json"))) {
        try {
          const state = JSON.parse(fs.readFileSync(path.join(states, name), "utf8"));
          if (state.status === "running") await client.interruptTurn(state.conversationId, state.assistantMessageId);
        } catch {}
      }
    }
    await stop(web); await stop(worker);
    auth.store?.db?.close?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
