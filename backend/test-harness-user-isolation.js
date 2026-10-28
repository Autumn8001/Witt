"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { antigravityIsolation } = require("./runtime/antigravity-isolation");
const { AntigravityAdapter } = require("./runtime/antigravity-adapter");
const { GrokBuildAdapter } = require("./runtime/grok-build-adapter");
const { ChatService } = require("./chat-service");

test("user scope is stable, opaque and cannot contain a client supplied path", () => {
  assert.deepEqual(antigravityIsolation("a"), antigravityIsolation("a"));
  assert.notEqual(antigravityIsolation("a").scope, antigravityIsolation("b").scope);
  assert.match(antigravityIsolation("../../etc").scope, /^[a-f0-9]{32}$/);
  assert.throws(() => antigravityIsolation(null), /USER_REQUIRED/);
});

test("ordinary users cannot inherit administrator execution; actual administrators retain full access", () => {
  const isolation = antigravityIsolation("ordinary");
  const normal = new AntigravityAdapter({ isolation, skipPermissions: true });
  assert.equal(normal.childEnv().CHLOE_AGY_ADMIN_EXECUTION, "0");
  assert.equal(normal.childEnv().CHLOE_AGY_USER_SCOPE, isolation.scope);
  const admin = new AntigravityAdapter({ runAsAdmin: true, skipPermissions: true });
  assert.equal(admin.childEnv().CHLOE_AGY_ADMIN_EXECUTION, "1");
  assert.ok(admin.buildArgs({ prompt: "test" }).includes("--dangerously-skip-permissions"));
  const readonly = new GrokBuildAdapter({ isolation, workspaceWrite: false });
  assert.equal(readonly.childEnv().CHLOE_AGY_ADMIN_EXECUTION, "0");
  assert.equal(readonly.childEnv().CHLOE_AGY_WORKSPACE_WRITE, "0");
  assert.equal(readonly.childEnv().CHLOE_AGY_USER_SCOPE, isolation.scope);
});

test("old global paths and alternate unsandboxed harness cannot bypass the private workspace", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chloe-user-policy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "own");
  const other = path.join(root, "other");
  fs.mkdirSync(workspace); fs.mkdirSync(other);
  const service = new ChatService({ chatDir: path.join(root, "chat"), dataDir: path.join(root, "files"),
    imageDir: path.join(root, "images"), codexBin: "codex", codexWorkDir: workspace,
    privateWorkspace: workspace, workDirRoots: [other] });
  assert.equal(service.effectiveWorkDir({ workDir: other }), workspace);
  assert.throws(() => service.normalizeWorkDir(other), /范围/);
  assert.equal(service.normalizeWorkDir(workspace), fs.realpathSync(workspace));
  assert.throws(() => service.clientFor({ workDir: workspace }), /尚未启用进程隔离/);
});
