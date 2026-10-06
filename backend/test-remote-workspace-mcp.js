"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const readline = require("node:readline");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { WorkspaceStore, WorkspaceAuditStore, ApprovalGate, WorkspaceDispatcher } = require("./remote-workspace");
const { RemoteWorkspaceService } = require("./remote-workspace-service");
const { createRemoteWorkspaceRoutes } = require("./routes/remote-workspaces");

const cases = [
  ["workspace_list", "workspace.list", {}],
  ["workspace_stat", "workspace.stat", { path: "src/app.js" }],
  ["workspace_read", "workspace.read", { path: "src/app.js" }],
  ["workspace_search", "workspace.search", { query: "hostname" }],
  ["workspace_write", "workspace.write", { path: "new.txt", content: "fixture", expected_sha256: "" }],
  ["workspace_patch", "workspace.patch", { path: "src/app.js", expected_sha256: "a".repeat(64), before: "before", after: "after" }],
  ["workspace_exec", "workspace.exec", { program: "node", argv: ["--test"] }],
  ["workspace_git_status", "workspace.git_status", {}],
  ["workspace_git_diff", "workspace.git_diff", {}],
  ["workspace_system_info", "workspace.system_info", {}],
];

test("stdio MCP tools reach the authenticated workspace route and bound dispatcher", { timeout: 20000 }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "witt-workspace-mcp-test-"));
  const store = new WorkspaceStore(directory);
  const audit = new WorkspaceAuditStore(directory);
  const approvals = new ApprovalGate();
  const sent = [];
  // Only the device transport is simulated: exercise the actual MCP process,
  // HTTP route, session authentication, policy and workspace dispatcher.
  const dispatcher = new WorkspaceDispatcher({ workspaceStore: store, audit, approvals,
    transport: { dispatch: async (...args) => {
      sent.push(args);
      return { exit_code: 0, stdout: JSON.stringify({ operation: args[2].operation }) };
    } },
  });
  const binding = store.create({
    workspace_id: "8f5393ac-a443-4f70-8f57-2810f812d8ca",
    conversation_id: "2f1cfa0f-2bc9-4e2f-9e4c-2ce0e0047d22",
    customer_id: "fixture-customer", device_id: "PC-001", root_alias: "project",
    display_path: "fixture project", harness_id: "grok-build",
    model_id: "grok-4.7-high", harness_session_id: "fixture-session",
  });
  let service, child, lines;
  const waiting = new Map();
  let nextId = 0;
  const server = http.createServer((req, res) => {
    const routes = createRemoteWorkspaceRoutes({ gateway: {}, service,
      sendJson: (response, status, body) => {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(JSON.stringify(body));
      },
      readJsonBody: (request, limit, callback) => {
        let body = "";
        request.on("data", (chunk) => { body += chunk; });
        request.on("end", () => {
          try {
            if (Buffer.byteLength(body) > limit) throw new Error("fixture_body_limit");
            callback(null, JSON.parse(body));
          } catch (error) { callback(error); }
        });
      },
    });
    if (!routes.handleInternal(req, res, new URL(req.url, "http://localhost"))) {
      res.writeHead(404); res.end();
    }
  });
  t.after(async () => {
    for (const pending of waiting.values()) { clearTimeout(pending.timer); pending.reject(new Error("fixture_closed")); }
    waiting.clear();
    lines?.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    }
    service?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    store.close(); audit.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  service = new RemoteWorkspaceService({ workspaceStore: store, audit, approvals, dispatcher,
    runtimeDir: path.join(directory, "runtime"), apiBase: `http://127.0.0.1:${server.address().port}`,
  });
  const runtime = service.runtimeFor(binding);
  child = spawn(process.execPath, [path.join(__dirname, "mcp", "remote-workspace.js")], {
    // Do not inherit provider credentials or production runtime settings.
    env: { WITT_REMOTE_WORKSPACE_MCP_ENABLED: "1", WITT_REMOTE_WORKSPACE_MCP_API: runtime.apiBase,
      WITT_REMOTE_WORKSPACE_CREDENTIAL_FILE: runtime.credentialFile },
    stdio: ["pipe", "pipe", "ignore"],
  });
  child.on("error", () => {
    for (const pending of waiting.values()) { clearTimeout(pending.timer); pending.reject(new Error("fixture_child_failed")); }
    waiting.clear();
  });
  lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const response = JSON.parse(line);
    const pending = waiting.get(response.id);
    if (pending) { clearTimeout(pending.timer); waiting.delete(response.id); pending.resolve(response); }
  });
  function rpc(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error("fixture_rpc_timeout")); }, 3000);
      waiting.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  assert.equal((await rpc("initialize")).result.serverInfo.name, "witt-remote-workspace");
  assert.deepEqual((await rpc("tools/list")).result.tools.map((tool) => tool.name), cases.map(([name]) => name));
  for (const [name, operation, args] of cases) {
    await t.test(name, async () => {
      const before = sent.length;
      const response = await rpc("tools/call", { name, arguments: args });
      assert.equal(response.result.isError, undefined);
      assert.equal(JSON.parse(response.result.content[0].text).stdout, JSON.stringify({ operation }));
      assert.equal(sent.length, before + 1);
      const packet = sent.at(-1);
      assert.equal(packet[0], "PC-001");
      assert.equal(packet[1], "workspace");
      assert.equal(packet[2].operation, operation);
      assert.equal(packet[2].root, operation === "workspace.system_info" ? undefined : "project");
      assert.equal(packet[4].workspaceSessionId, binding.workspace_id);
    });
  }
  await t.test("unknown tool cannot dispatch", async () => {
    const before = sent.length;
    const response = await rpc("tools/call", { name: "workspace_delete", arguments: {} });
    assert.equal(response.result.isError, true);
    assert.equal(response.result.content[0].text, "INVALID_ARGUMENTS");
    assert.equal(sent.length, before);
  });
  await t.test("path escape cannot dispatch", async () => {
    const before = sent.length;
    const response = await rpc("tools/call", { name: "workspace_read", arguments: { path: "../outside.txt" } });
    assert.equal(response.result.isError, true);
    assert.equal(response.result.content[0].text, "INVALID_PATH");
    assert.equal(sent.length, before);
  });
  await t.test("paused workspace invalidates the bridge credential", async () => {
    store.setState(binding.workspace_id, "paused");
    const before = sent.length;
    const response = await rpc("tools/call", { name: "workspace_git_status", arguments: {} });
    assert.equal(response.result.isError, true);
    assert.equal(response.result.content[0].text, "WORKSPACE_SESSION_INVALID");
    assert.equal(sent.length, before);
  });
});
