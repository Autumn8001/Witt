"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { AntigravityAdapter } = require("../backend/runtime/antigravity-adapter");
const { TurnInstance } = require("../backend/worker-service");
const { ChatService } = require("../backend/chat-service");

const ADMIN_ENV = "CHLOE_AGY_ADMIN_EXECUTION";

async function inspectWorkerIdentity({ runAsAdmin, accessMode }) {
  const turn = new TurnInstance({
    conversationId: "conversation-test",
    assistantMessageId: "assistant-test",
    userMessageId: "user-test",
    harnessId: "google-antigravity",
    model: "gemini-3.8-flash-high",
    reasoning: "medium",
    accessMode,
    workDir: process.cwd(),
    prompt: "identity test",
    chatDir: "unused-test-dir",
    harnessOptions: { antigravity: { runAsAdmin } },
  }, { getStore: () => ({}), logger: null });

  const originalStartRuntime = AntigravityAdapter.prototype.startRuntime;
  const originalSendPrompt = AntigravityAdapter.prototype.sendPrompt;
  AntigravityAdapter.prototype.startRuntime = async function startRuntime() {};
  AntigravityAdapter.prototype.sendPrompt = function sendPrompt() {
    return { events: new EventEmitter(), done: new Promise(() => {}) };
  };
  try {
    const pending = turn._runAntigravity();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(turn.adapter, "Worker should construct its Antigravity adapter");
    return {
      runAsAdmin: turn.adapter.runAsAdmin,
      childEnv: turn.adapter.childEnv(),
      pending,
    };
  } finally {
    AntigravityAdapter.prototype.startRuntime = originalStartRuntime;
    AntigravityAdapter.prototype.sendPrompt = originalSendPrompt;
  }
}

function directAdapter({ runAsAdmin, accessMode }) {
  const service = Object.create(ChatService.prototype);
  service.harnessOptions = { antigravity: { runAsAdmin } };
  service.runtimeLogger = null;
  service.effectiveWorkDir = () => process.cwd();
  return service.antigravityAdapter("gemini-3.8-flash-high", { accessMode });
}

test("admin marker is explicit and emitted only for trusted admin full-access turns", async (t) => {
  const old = process.env[ADMIN_ENV];
  process.env[ADMIN_ENV] = "1"; // Parent pollution must not grant admin execution.
  t.after(() => {
    if (old === undefined) delete process.env[ADMIN_ENV];
    else process.env[ADMIN_ENV] = old;
  });

  const cases = [
    { runAsAdmin: true, skipPermissions: true, expected: "1" },
    { runAsAdmin: true, skipPermissions: false, expected: "0" },
    { runAsAdmin: false, skipPermissions: true, expected: "0" },
    { runAsAdmin: undefined, skipPermissions: true, expected: "0" },
  ];

  for (const item of cases) {
    const adapter = new AntigravityAdapter({
      bin: process.execPath,
      runAsAdmin: item.runAsAdmin,
      skipPermissions: item.skipPermissions,
    });
    adapter.buildArgs = () => ["-e", `process.exit(process.env.${ADMIN_ENV} === ${JSON.stringify(item.expected)} ? 0 : 41)`];
    const handle = adapter.sendPrompt({ model: "gemini-test" });
    const result = await handle.done;
    assert.equal(result.ok, true);
    assert.equal(handle.process.env[ADMIN_ENV], item.expected);
  }
});

test("Worker grants admin CLI identity only when trusted options and full-access mode agree", async () => {
  const admin = await inspectWorkerIdentity({ runAsAdmin: true, accessMode: "danger-full-access" });
  assert.equal(admin.runAsAdmin, true);
  assert.equal(admin.childEnv[ADMIN_ENV], "1");

  const nonAdminFullAccess = await inspectWorkerIdentity({ runAsAdmin: false, accessMode: "danger-full-access" });
  assert.equal(nonAdminFullAccess.runAsAdmin, false);
  assert.equal(nonAdminFullAccess.childEnv[ADMIN_ENV], "0");

  const adminWorkspaceWrite = await inspectWorkerIdentity({ runAsAdmin: true, accessMode: "workspace-write" });
  assert.equal(adminWorkspaceWrite.runAsAdmin, false);
  assert.equal(adminWorkspaceWrite.childEnv[ADMIN_ENV], "0");
});

test("direct ChatService adapter follows the same identity and access-mode gate", () => {
  assert.equal(directAdapter({ runAsAdmin: true, accessMode: "danger-full-access" }).runAsAdmin, true);
  assert.equal(directAdapter({ runAsAdmin: false, accessMode: "danger-full-access" }).runAsAdmin, false);
  assert.equal(directAdapter({ runAsAdmin: true, accessMode: "workspace-write" }).runAsAdmin, false);
});
