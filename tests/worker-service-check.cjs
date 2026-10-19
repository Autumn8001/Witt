"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");

const {
  WorkerService,
  TurnInstance,
  serializeGitBaseline,
  deserializeGitBaseline,
  emptyHarnessResponseReason,
  emptyGrokResponseReason,
} = require("../backend/worker-service");

const uuid = () => require("node:crypto").randomUUID();

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "witt-worker-check-"));
  const conversationId = uuid();
  const userMessageId = uuid();
  const assistantMessageId = uuid();
  const conversation = {
    id: conversationId,
    updatedAt: new Date().toISOString(),
    messages: [
      { id: userMessageId, role: "user", status: "queued", text: "user" },
      { id: assistantMessageId, role: "assistant", status: "running", text: "", stream: [], activity: [] },
    ],
    pageMetadata: { keep: true },
  };
  const store = {
    load(id, options = {}) {
      assert.equal(id, conversationId);
      assert.equal(options.forceFresh, true);
      return structuredClone(conversation);
    },
    patchMessages(id, messages, metadata) {
      assert.equal(id, conversationId);
      for (const message of messages) {
        const index = conversation.messages.findIndex((item) => item.id === message.id);
        if (index >= 0) conversation.messages[index] = structuredClone(message);
      }
      Object.assign(conversation, metadata, { updatedAt: new Date().toISOString() });
      return structuredClone(conversation);
    },
    save() { throw new Error("worker must use patchMessages"); },
  };
  const worker = new WorkerService({ stateDir: path.join(root, "worker-state") });
  worker.getStore = () => store;
  const params = {
    conversationId,
    userMessageId,
    assistantMessageId,
    userId: "user-1",
    harnessId: "grok-build",
    chatDir: path.join(root, "chat"),
    dataDir: path.join(root, "files"),
    prompt: "must not persist",
    harnessOptions: { grok: { envValue: "must not persist" } },
  };
  return { root, worker, params, store, conversation };
}

function invoke(worker, method, url, body = null) {
  const req = Readable.from(body === null ? [] : [JSON.stringify(body)]);
  req.method = method;
  req.url = url;
  let statusCode = 0;
  let responseBody = "";
  let finished;
  const done = new Promise((resolve) => { finished = resolve; });
  const res = {
    destroyed: false,
    writableEnded: false,
    writeHead(status) { statusCode = status; },
    write(chunk) { responseBody += chunk; return true; },
    end(chunk = "") {
      responseBody += chunk;
      this.writableEnded = true;
      let parsed = responseBody || null;
      if (responseBody) {
        try { parsed = JSON.parse(responseBody); } catch {}
      }
      finished({ statusCode, body: parsed });
    },
  };
  worker.handleRequest(req, res);
  return done;
}

test("start key is idempotent while running and after completion", async (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  const originalRun = TurnInstance.prototype.run;
  let runCount = 0;
  TurnInstance.prototype.run = function runStub() {
    runCount += 1;
    this.testFinish = () => this.finish("completed");
    return new Promise(() => {});
  };
  t.after(() => { TurnInstance.prototype.run = originalRun; });

  const first = await invoke(fx.worker, "POST", "/turns/start", fx.params);
  assert.equal(first.statusCode, 202);
  await new Promise((resolve) => setImmediate(resolve));
  const turn = fx.worker.activeTurns.get(`${fx.params.conversationId}:${fx.params.assistantMessageId}`);
  assert.ok(turn);
  assert.equal(runCount, 1);

  const duplicateRunning = await invoke(fx.worker, "POST", "/turns/start", fx.params);
  assert.equal(duplicateRunning.statusCode, 200);
  assert.equal(duplicateRunning.body.status, "running");
  assert.equal(runCount, 1);

  turn.testFinish();
  const duplicateCompleted = await invoke(fx.worker, "POST", "/turns/start", fx.params);
  assert.equal(duplicateCompleted.statusCode, 200);
  assert.equal(duplicateCompleted.body.status, "completed");
  assert.equal(runCount, 1);
});

test("events persist and running turns become interrupted on worker restart", async (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  const turn = new TurnInstance(fx.params, fx.worker);
  fx.worker.activeTurns.set(turn.key, turn);
  turn.emitEvent("text_delta", { text: "partial" });
  turn.emitEvent("error", { error: "api_key=sk-1234567890123456" });

  const saved = JSON.parse(fs.readFileSync(fx.worker.turnStatePath(turn.key), "utf8"));
  assert.equal(saved.prompt, undefined);
  assert.equal(JSON.stringify(saved).includes("must not persist"), false);
  assert.equal(JSON.stringify(saved).includes("sk-1234567890123456"), false);
  assert.equal(saved.events[0].seq, 0);

  const restarted = new WorkerService({ stateDir: fx.worker.stateDir });
  restarted.getStore = () => fx.store;
  restarted.loadPersistedTurns();
  const restored = restarted.activeTurns.get(turn.key);
  assert.ok(restored);
  assert.equal(restored.status, "interrupted");
  assert.equal(restored.events[0].data.text, "partial");
  assert.match(JSON.stringify(restored.events), /REDACTED/);
  assert.equal(restored.events.at(-1).type, "finish");
  assert.equal(fx.conversation.messages[1].status, "interrupted");
  assert.equal(fx.conversation.messages[0].status, "completed");
  const replay = await invoke(restarted, "GET",
    `/turns/${fx.params.conversationId}/${fx.params.assistantMessageId}/events?fromSeq=0`);
  assert.equal(replay.statusCode, 200);
  assert.match(replay.body, /text_delta/);
  assert.match(replay.body, /finish/);
});

test("admin status reports active worker count", async (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  const turn = new TurnInstance(fx.params, fx.worker);
  fx.worker.activeTurns.set(turn.key, turn);
  const response = await invoke(fx.worker, "GET", "/admin/status");
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.runningCount, 1);
});

test("admin resume reopens Worker admission after a deferred upgrade", async (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  const drained = await invoke(fx.worker, "POST", "/admin/drain");
  assert.equal(drained.statusCode, 200);
  assert.equal(drained.body.draining, true);
  const resumed = await invoke(fx.worker, "POST", "/admin/resume");
  assert.equal(resumed.statusCode, 200);
  assert.equal(resumed.body.draining, false);
});

test("an empty CLI final response identifies the harness and last tool without exposing output", () => {
  const reason = emptyHarnessResponseReason("Google Antigravity",
    { label: "命令：npm test", status: "completed" }, { code: 0 });
  assert.match(reason, /Google Antigravity CLI 进程正常结束/);
  assert.match(reason, /命令：npm test/);
  assert.match(reason, /已完成/);
  assert.match(reason, /未返回最终回复/);
  assert.match(emptyGrokResponseReason(null, { code: 0 }), /Grok Build CLI/);
});

test("start rejects URL-shaped or non-local chat storage paths", async (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  const response = await invoke(fx.worker, "POST", "/turns/start", { ...fx.params, chatDir: "https://example.test/chat" });
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, "invalid_turn_metadata");
});

test("harness without interactive approval returns unsupported and does not claim success", async (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  const turn = new TurnInstance(fx.params, fx.worker);
  turn.adapter = { capabilities: { approvals: false }, approve: () => ({ ok: true }), deny: () => ({ ok: true }) };
  turn.pendingApprovals.set("approval-1", { request: {} });
  const result = await turn.resolveApproval("approval-1", "accept");
  assert.equal(result.ok, false);
  assert.equal(result.error, "approval_unsupported");
  assert.equal(turn.pendingApprovals.has("approval-1"), true);
});

test("interrupt waits for the harness child to exit before confirming", async (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  const turn = new TurnInstance(fx.params, fx.worker);
  let childExited = false;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const child = { exitCode: null, pid: 12345 };
  turn.handle = { done, process: { child, kill() { child.exitCode = 0; childExited = true; resolveDone({ ok: false }); } } };
  turn.adapter = { async cancel() { await new Promise((resolve) => setTimeout(resolve, 20)); child.exitCode = 0; childExited = true; resolveDone({ ok: false }); } };
  const result = await turn.interrupt();
  assert.equal(childExited, true);
  assert.equal(result.status, "interrupted");
});

test("git baseline Map and Set survive worker state serialization", () => {
  const baseline = {
    branch: "main",
    preexisting: new Map([["a.js", "modified"]]),
    preexistingSnapshots: new Map([["a.js", { hash: "abc" }]]),
  };
  const setBaseline = { preexisting: new Set(["b.js"]) };
  const mapRestored = deserializeGitBaseline(JSON.parse(JSON.stringify(serializeGitBaseline(baseline))));
  const setRestored = deserializeGitBaseline(JSON.parse(JSON.stringify(serializeGitBaseline(setBaseline))));
  assert.ok(mapRestored.preexisting instanceof Map);
  assert.equal(mapRestored.preexisting.get("a.js"), "modified");
  assert.ok(setRestored.preexisting instanceof Set);
  assert.equal(setRestored.preexisting.has("b.js"), true);
  assert.ok(mapRestored.preexistingSnapshots instanceof Map);
  assert.equal(mapRestored.preexistingSnapshots.get("a.js").hash, "abc");
  const fromWorkerClient = deserializeGitBaseline({ preexisting: ["c.js"], preexistingSnapshots: [["c.js", { hash: "def" }]] });
  assert.ok(fromWorkerClient.preexisting instanceof Set);
  assert.ok(fromWorkerClient.preexistingSnapshots instanceof Map);
  assert.equal(fromWorkerClient.preexisting.has("c.js"), true);
});
