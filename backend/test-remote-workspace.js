"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  WorkspaceStore, WorkspaceStoreError, validateWorkspaceOperation, WorkspaceValidationError,
  classifyWorkspaceOperation, SAFE, CONFIRM, DENY, ApprovalGate, ApprovalError,
  WorkspaceAuditStore, WorkspaceDispatcher, WorkspaceDispatchError,
} = require("./remote-workspace");

const IDS = Object.freeze({
  workspace: "8f5393ac-a443-4f70-8f57-2810f812d8ca",
  conversation: "2f1cfa0f-2bc9-4e2f-9e4c-2ce0e0047d22",
  other: "6cc7ba11-74b3-4fd3-a7bb-50dda0fcd10d",
});

function temp(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "witt-remote-workspace-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function binding(overrides = {}) {
  return {
    workspace_id: IDS.workspace, conversation_id: IDS.conversation, customer_id: "customer-a",
    device_id: "PC-001", root_alias: "project", display_path: "D:/projects/example",
    harness_id: "grok-build", model_id: "grok-4.7", harness_session_id: "run-abc",
    ...overrides,
  };
}

test("workspace binding is persistent, strictly validated and immutable", (t) => {
  let time = "2026-10-05T00:00:00.000Z";
  const store = new WorkspaceStore(temp(t), { now: () => time });
  t.after(() => store.close());
  const created = store.create(binding());
  assert.equal(created.state, "active");
  assert.equal(created.root_alias, "project");
  assert.equal(store.getByConversation(IDS.conversation).workspace_id, IDS.workspace);
  assert.throws(() => store.create(binding()), (error) => error.code === "IMMUTABLE_BINDING");
  assert.throws(() => store.create(binding({ workspace_id: "not-a-uuid" })), (error) => error.code === "INVALID_WORKSPACE_ID");
  assert.throws(() => store.create(binding({ conversation_id: "not-a-uuid" })), (error) => error.code === "INVALID_CONVERSATION_ID");
  assert.throws(() => store.create(binding({ root_alias: "D:" })), (error) => error.code === "INVALID_ROOT_ALIAS");
  time = "2026-10-05T00:01:00.000Z";
  assert.equal(store.setState(IDS.workspace, "paused").updated_at, time);
  assert.equal(store.setState(IDS.workspace, "active").state, "active");
  assert.equal(store.setState(IDS.workspace, "closed").state, "closed");
  assert.throws(() => store.setState(IDS.workspace, "active"), (error) => error.code === "INVALID_STATE_TRANSITION");
});

test("workspace validators only admit bounded relative paths and structured exec", () => {
  assert.deepEqual(validateWorkspaceOperation("workspace.list", {}), { operation: "workspace.list", args: { path: "." } });
  assert.deepEqual(validateWorkspaceOperation("workspace.search", { query: "needle" }), {
    operation: "workspace.search", args: { query: "needle", path: "." },
  });
  assert.deepEqual(validateWorkspaceOperation("workspace.exec", {
    program: "node", argv: ["--version"], cwd: "packages/app", timeout_ms: 5_000,
  }), { operation: "workspace.exec", args: { program: "node", argv: ["--version"], cwd: "packages/app", timeout_ms: 5_000 } });
  for (const pathValue of ["../escape", "/etc/passwd", "C:/windows", "a\\b", "//server/share", ".", "a/../b"]) {
    assert.throws(() => validateWorkspaceOperation("workspace.read", { path: pathValue }), WorkspaceValidationError);
  }
  assert.throws(() => validateWorkspaceOperation("workspace.exec", { program: "npm run test", argv: [] }), /INVALID_PROGRAM/);
  assert.throws(() => validateWorkspaceOperation("workspace.exec", { program: "npm", argv: "test" }), /INVALID_ARGV/);
  assert.throws(() => validateWorkspaceOperation("workspace.patch", { path: "a.js", before: "x", after: "y", expected_sha256: "no" }), /INVALID_SHA256/);
});

test("policy classifies development calls and blocks shells, destructive commands and sensitive paths", () => {
  assert.equal(classifyWorkspaceOperation("workspace.read", { path: "src/app.js" }).category, SAFE);
  assert.equal(classifyWorkspaceOperation("workspace.patch", {
    path: "src/app.js", expected_sha256: "a".repeat(64), before: "old", after: "new",
  }).category, SAFE);
  assert.equal(classifyWorkspaceOperation("workspace.exec", { program: "node", argv: ["--test"] }).category, SAFE);
  assert.equal(classifyWorkspaceOperation("workspace.exec", { program: "node", argv: ["-e", "process.exit(0)"] }).category, CONFIRM);
  assert.equal(classifyWorkspaceOperation("workspace.exec", { program: "npm", argv: ["test"] }).category, SAFE);
  assert.equal(classifyWorkspaceOperation("workspace.exec", { program: "npm", argv: ["install"] }).category, CONFIRM);
  assert.equal(classifyWorkspaceOperation("workspace.exec", { program: "git", argv: ["push"] }).category, CONFIRM);
  assert.equal(classifyWorkspaceOperation("workspace.exec", { program: "powershell", argv: ["-Command", "x"] }).category, DENY);
  assert.equal(classifyWorkspaceOperation("workspace.exec", { program: "git", argv: ["reset", "--hard"] }).category, DENY);
  assert.equal(classifyWorkspaceOperation("workspace.write", { path: ".ssh/config", content: "x", expected_sha256: "" }).category, DENY);
});

test("approval intents are immutable, workspace-bound, expiring and single-use", () => {
  let now = 1_000;
  const gate = new ApprovalGate({ now: () => now, randomUUID: () => "18dfe855-379f-4610-8b64-b3d99bc5d7e6", ttlMs: 2_000 });
  const intent = { operation: "workspace.exec", args: { program: "npm", argv: ["install"] } };
  const approval = gate.create(IDS.workspace, intent);
  intent.args.argv.push("mutated-after-create");
  assert.deepEqual(approval.intent.args.argv, ["install"]);
  assert.throws(() => gate.accept(approval.id, IDS.other), (error) => error.code === "APPROVAL_NOT_FOUND");
  assert.equal(gate.accept(approval.id, IDS.workspace).state, "accepted");
  assert.throws(() => gate.consume(approval.id, IDS.workspace, { operation: "workspace.exec", args: { program: "npm", argv: ["update"] } }),
    (error) => error.code === "APPROVAL_INTENT_MISMATCH");
  assert.equal(gate.consume(approval.id, IDS.workspace, { operation: "workspace.exec", args: { program: "npm", argv: ["install"] } }).state, "consumed");
  assert.throws(() => gate.consume(approval.id, IDS.workspace, approval.intent), (error) => error.code === "APPROVAL_NOT_ACCEPTED");
  const expiry = gate.create(IDS.workspace, { operation: "workspace.exec", args: { program: "npm", argv: ["install"] } });
  now += 2_001;
  assert.throws(() => gate.accept(expiry.id, IDS.workspace), (error) => error.code === "APPROVAL_EXPIRED");
});

test("dispatcher binds every request to workspace transport, audits metadata and uses approval", async (t) => {
  const directory = temp(t);
  const workspaces = new WorkspaceStore(directory);
  const audit = new WorkspaceAuditStore(directory);
  t.after(() => { workspaces.close(); audit.close(); });
  workspaces.create(binding());
  const dispatched = [];
  const dispatcher = new WorkspaceDispatcher({
    workspaceStore: workspaces, audit, approvals: new ApprovalGate(),
    transport: { dispatch: async (...args) => { dispatched.push(args); return { exit_code: 0, stdout: "ok" }; } },
  });
  const read = await dispatcher.execute({ workspace_id: IDS.workspace, operation: "workspace.read", args: { path: "src/app.js" } });
  assert.equal(read.status, "completed");
  assert.deepEqual(dispatched[0], ["PC-001", "workspace", {
    root: "project", operation: "workspace.read", path: "src/app.js",
  }, 20_000, { workspaceSessionId: IDS.workspace }]);
  await dispatcher.execute({ workspace_id: IDS.workspace, operation: "workspace.system_info", args: {} });
  assert.deepEqual(dispatched[1], ["PC-001", "workspace", { operation: "workspace.system_info" }, 20_000,
    { workspaceSessionId: IDS.workspace }]);
  const needsApproval = await dispatcher.execute({ workspace_id: IDS.workspace, operation: "workspace.exec", args: { program: "npm", argv: ["install"] } });
  assert.equal(needsApproval.status, "approval_required");
  dispatcher.approvals.accept(needsApproval.approval.id, IDS.workspace);
  const accepted = await dispatcher.execute({ workspace_id: IDS.workspace, operation: "workspace.exec", args: { program: "npm", argv: ["install"] }, approval_id: needsApproval.approval.id });
  assert.equal(accepted.status, "completed");
  assert.equal(dispatched.length, 3);
  assert.deepEqual(audit.list(IDS.workspace).map((entry) => entry.status), ["completed", "approval_required", "completed", "completed"]);
  assert.equal(Object.keys(audit.list(IDS.workspace)[0]).some((key) => /content|token|argv/i.test(key)), false);
});

test("dispatcher never retries uncertain write or exec operations", async (t) => {
  const directory = temp(t);
  const workspaces = new WorkspaceStore(directory);
  const audit = new WorkspaceAuditStore(directory);
  t.after(() => { workspaces.close(); audit.close(); });
  workspaces.create(binding());
  let calls = 0;
  const dispatcher = new WorkspaceDispatcher({ workspaceStore: workspaces, audit, approvals: new ApprovalGate(),
    transport: { dispatch: async () => { calls += 1; const error = new Error("DEVICE_DISCONNECTED"); error.code = "DEVICE_DISCONNECTED"; throw error; } },
  });
  await assert.rejects(() => dispatcher.execute({ workspace_id: IDS.workspace, operation: "workspace.write", args: { path: "src/a.js", content: "x", expected_sha256: "" } }),
    (error) => error instanceof WorkspaceDispatchError && error.code === "EXECUTION_STATE_UNKNOWN");
  assert.equal(calls, 1);
  assert.equal(audit.list(IDS.workspace)[0].status, "execution_state_unknown");
  await assert.rejects(() => dispatcher.execute({ workspace_id: IDS.workspace, operation: "workspace.read", args: { path: "src/a.js" } }), /DEVICE_DISCONNECTED/);
  assert.equal(calls, 2);
});

test("dispatcher does not dispatch denied work", async (t) => {
  const directory = temp(t);
  const workspaces = new WorkspaceStore(directory);
  const audit = new WorkspaceAuditStore(directory);
  t.after(() => { workspaces.close(); audit.close(); });
  workspaces.create(binding());
  const dispatcher = new WorkspaceDispatcher({ workspaceStore: workspaces, audit, approvals: new ApprovalGate(),
    transport: { dispatch: async () => { throw new Error("must not run"); } },
  });
  await assert.rejects(() => dispatcher.execute({ workspace_id: IDS.workspace, operation: "workspace.exec", args: { program: "cmd", argv: ["/c", "del"] } }),
    (error) => error.code === "OPERATION_DENIED");
  assert.equal(audit.list(IDS.workspace)[0].status, "denied");
});
