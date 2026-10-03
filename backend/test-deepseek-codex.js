"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "witt-deepseek-codex-"));
const keyFile = path.join(temporaryDir, "key");
const codexHome = path.join(temporaryDir, "codex-home");
fs.mkdirSync(codexHome);
fs.writeFileSync(keyFile, "test-key\n", { mode: 0o600 });

let requests = 0;
let adapter = null;
const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (body.messages.some((message) => message.role === "tool")) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "适配成功" } }], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } })}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_pwd", function: { name: "exec_command", arguments: "{\"cmd\":\"pwd\"}" } }] } }] })}\n\n`);
    }
    res.end("data: [DONE]\n\n");
  });
});

process.once("exit", () => adapter?.kill("SIGTERM"));

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server.address().port);
    });
  });
}

async function freePort() {
  const probe = http.createServer();
  const port = await listen(probe);
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

function waitForLine(child, pattern) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("process start timeout")), 5000);
    child.stdout.on("data", (chunk) => {
      if (!pattern.test(chunk.toString("utf8"))) return;
      clearTimeout(timeout);
      resolve();
    });
    child.once("exit", (code) => reject(new Error(`process exited ${code}`)));
  });
}

function collect(child) {
  return new Promise((resolve) => {
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { output += chunk.toString("utf8"); });
    child.on("close", (code) => resolve({ code, output }));
  });
}

async function main() {
  const upstreamPort = await listen(upstream);
  const adapterPort = await freePort();
  fs.writeFileSync(path.join(codexHome, "config.toml"), `
model = "deepseek-v4-pro"
model_provider = "test-deepseek"
[model_providers.test-deepseek]
name = "Test DeepSeek"
base_url = "http://127.0.0.1:${adapterPort}/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
`);
  adapter = spawn(process.execPath, [path.join(__dirname, "deepseek-responses-adapter.js")], {
    env: {
      ...process.env,
      DEEPSEEK_ADAPTER_PORT: String(adapterPort),
      DEEPSEEK_API_URL: `http://127.0.0.1:${upstreamPort}/chat/completions`,
      DEEPSEEK_API_KEY_FILE: keyFile,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    await waitForLine(adapter, /listening/);
    const codex = spawn("/home/ubuntu/.local/bin/codex", [
      "exec", "--skip-git-repo-check", "--sandbox", "read-only", "调用工具后完成测试",
    ], {
      cwd: "/home/ubuntu",
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const result = await collect(codex);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /适配成功/);
    assert.ok(requests >= 2, `expected tool loop, got ${requests} request(s)`);
    console.log("codex deepseek end-to-end test passed");
  } finally {
    const child = adapter;
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 3000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill("SIGTERM");
      });
    }
    adapter = null;
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  upstream.close();
  fs.rmSync(temporaryDir, { recursive: true, force: true });
  console.error(error.stack || error);
  process.exitCode = 1;
});
