"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { WorkspaceStore, WorkspaceAuditStore, ApprovalGate, WorkspaceDispatcher } = require("./remote-workspace");
const { RemoteWorkspaceService } = require("./remote-workspace-service");

const ids = {
  workspace: "8f5393ac-a443-4f70-8f57-2810f812d8ca",
  conversation: "2f1cfa0f-2bc9-4e2f-9e4c-2ce0e0047d22",
};

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "witt-remote-workspace-service-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new WorkspaceStore(directory);
  const audit = new WorkspaceAuditStore(directory);
  t.after(() => { store.close(); audit.close(); });
  store.create({
    workspace_id: ids.workspace, conversation_id: ids.conversation, customer_id: "customer-a",
    device_id: "PC-001", root_alias: "project", display_path: "D:/example",
    harness_id: "grok-build", model_id: "grok-4.7-high", harness_session_id: "run-1",
  });
  return { directory, store, audit };
}

test("CLI preparation deduplicates and fails closed if revoked during startup", async t => {
  const { directory, store, audit } = setup(t);
  const binding = { ...store.get(ids.workspace), harness_id: "google-antigravity" };
  let release, creates = 0, closes = 0;
  const ready = new Promise(resolve => { release = resolve; });
  const service = new RemoteWorkspaceService({ workspaceStore: store, audit, approvals: new ApprovalGate(),
    dispatcher: {}, runtimeDir: path.join(directory, "runtime"), cliRuntimeFactory: async () => {
      creates++; await ready;
      return { cwd: "/work", home: "/home/assist", geminiBin: "/isolated/agy",
        remoteCli: { isolated: true }, close: async () => { closes++; } };
    } });
  assert.throws(() => service.runtimeFor(binding), /ISOLATED_CLI_NOT_READY/);
  const first = service.prepareRuntimeFor(binding), second = service.prepareRuntimeFor(binding);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(creates, 1);
  store.setState(ids.workspace, "closed"); release();
  await assert.rejects(first, /WORKSPACE_NOT_ACTIVE/);
  await assert.rejects(second, /WORKSPACE_NOT_ACTIVE/);
  assert.equal(closes, 1); assert.equal(service.cliRuntimes.size, 0);service.close();
});

test("full-session CLI reuses live consent without weakening native harness isolation", async t => {
  const { directory, store, audit } = setup(t);
  const binding = { ...store.get(ids.workspace), harness_id: "google-antigravity" };
  let full = true, policy;
  const service = new RemoteWorkspaceService({ workspaceStore: store, audit, approvals: new ApprovalGate(),
    dispatcher: { fullAccessFor: device => device === binding.device_id && full }, runtimeDir: path.join(directory, "runtime"),
    cliRuntimeFactory: async (_binding, _execute, authorization) => {
      policy = authorization;
      return { cwd: "/work", home: "/home/assist", geminiBin: "/isolated/agy", remoteCli: { isolated: true } };
    } });
  const runtime = await service.prepareRuntimeFor(binding);
  assert.equal(runtime.remoteCli.isolated, true);assert.equal(policy.fullAccessFor(), true);
  full = false;assert.equal(policy.fullAccessFor(), false);
  assert.equal(service.fullAccessFor(null), false);service.close();
});

test("Remote Workspace MCP credential is isolated to one immutable binding and confirmation resumes the same request", async (t) => {
  const { directory, store, audit } = setup(t);
  const sent = [];
  const approvals = new ApprovalGate();
  const dispatcher = new WorkspaceDispatcher({
    workspaceStore: store, audit, approvals,
    transport: { dispatch: async (...args) => { sent.push(args); return { exit_code: 0, stdout: "ok" }; } },
  });
  let prompted;
  const service = new RemoteWorkspaceService({
    workspaceStore: store, audit, approvals, dispatcher, runtimeDir: path.join(directory, "runtime"),
    notifyApproval: (_binding, approval) => { prompted = approval; },
  });
  const runtime = service.runtimeFor(store.get(ids.workspace));
  assert.ok(fs.existsSync(path.join(runtime.cwd, ".grok", "config.toml")));
  const geminiSettings = JSON.parse(fs.readFileSync(path.join(runtime.cwd, ".gemini", "antigravity-cli", "settings.json")));
  assert.equal(geminiSettings.modelProvider, "gemini");
  assert.deepEqual(geminiSettings.permissions.allow, ["mcp(witt_remote_workspace/*)"]);
  const geminiMcp = JSON.parse(fs.readFileSync(path.join(runtime.cwd, ".gemini", "config", "mcp_config.json")));
  assert.equal(geminiMcp.mcpServers.witt_remote_workspace.env.WITT_REMOTE_WORKSPACE_CREDENTIAL_FILE, runtime.credentialFile);
  const source = path.join(directory, "sample.png");
  fs.writeFileSync(source, Buffer.from([137, 80, 78, 71]));
  const [staged] = service.stageAttachments(store.get(ids.workspace), [{ path: source, name: "sample.png" }]);
  assert.notEqual(staged.path, source);
  assert.deepEqual(fs.readFileSync(staged.path), fs.readFileSync(source));
  assert.equal(staged.name, "sample.png");
  assert.equal(service.authenticate("wrong"), null);
  const read = await service.executeMcp(runtime.secret, "workspace.read", { path: "src/app.js" });
  assert.equal(read.stdout, "ok");
  assert.equal(sent[0][2].root, "project");
  const install = service.executeMcp(runtime.secret, "workspace.exec", { program: "npm", argv: ["install"] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prompted.intent.operation, "workspace.exec");
  service.resolveApproval(ids.workspace, prompted.id, true);
  assert.equal((await install).stdout, "ok");
  assert.deepEqual(sent[1][4].approval, { id: prompted.id, confirmed: true });
  service.close();
});
