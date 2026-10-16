"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ChatService } = require("../backend/chat-service");
const { ConversationStore } = require("../backend/sqlite-store");
const { RemoteWorkspaceService } = require("../backend/remote-workspace-service");

const uuid = () => crypto.randomUUID();
const turnKey = (conversationId, messageId) => `${conversationId}:${messageId}`;

class FakeWorkerClient {
  constructor({ available = true } = {}) {
    this.available = available;
    this.turns = new Map();
    this.starts = [];
    this.interrupts = [];
    this.approvals = [];
    this.interruptResult = { ok: true, status: 202, data: { status: "interrupted" } };
    this.approvalResult = { ok: true, status: 200, data: { ok: true } };
  }

  async isAvailable() { return this.available; }

  async startTurn(params) {
    const key = turnKey(params.conversationId, params.assistantMessageId);
    const existing = this.turns.get(key);
    if (existing) return { ok: true, status: 200, data: { status: existing.status } };
    const turn = { params, status: "running", handlers: null, unsubscribeCount: 0 };
    this.turns.set(key, turn);
    this.starts.push(params);
    return { ok: true, status: 202, data: { status: "running" } };
  }

  subscribeTurnEvents(conversationId, messageId, handlers) {
    const turn = this.turns.get(turnKey(conversationId, messageId));
    assert.ok(turn, "turn must be started before subscribing");
    turn.handlers = handlers;
    return () => { turn.unsubscribeCount += 1; };
  }

  async getTurnStatus(conversationId, messageId) {
    const turn = this.turns.get(turnKey(conversationId, messageId));
    if (!turn) return null;
    return { ok: true, status: turn.status };
  }

  async interruptTurn(conversationId, messageId) {
    this.interrupts.push({ conversationId, messageId });
    return this.interruptResult;
  }

  async resolveApproval(conversationId, messageId, approvalId, decision, choiceId = null) {
    this.approvals.push({ conversationId, messageId, approvalId, decision, choiceId });
    return this.approvalResult;
  }

  finish(conversationId, messageId, status = "completed", text = "worker result") {
    const turn = this.turns.get(turnKey(conversationId, messageId));
    assert.ok(turn?.handlers, "turn subscription must be active");
    turn.status = status;
    turn.handlers.onFinish?.({ status, text, ...(status === "failed" ? { error: text } : {}) });
  }
}

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "witt-chat-worker-check-"));
  const chatDir = path.join(root, "chat");
  if (options.seed) {
    const seedStore = new ConversationStore(chatDir);
    try { options.seed({ root, chatDir, store: seedStore }); }
    finally { seedStore.close(); }
  }
  const workerClient = options.workerClient || new FakeWorkerClient();
  const service = new ChatService({
    chatDir,
    dataDir: path.join(root, "files"),
    imageDir: path.join(root, "images"),
    codexBin: "/bin/false",
    codexWorkDir: root,
    sendJson(res, status, payload) { res.status = status; res.payload = payload; },
    readJsonBody(req, _limit, callback) { callback(null, req.body || {}); },
    allowedModels: null,
    workerClient,
  });
  const runNextActual = service.runNext.bind(service);
  service.runNext = () => {};
  t.after(() => {
    for (const entry of service.jsonCheckpoints.values()) clearTimeout(entry.timer);
    for (const timer of service.eventBroadcasts.values()) clearTimeout(timer);
    service.active?.unsubscribe?.();
    service.store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, chatDir, service, workerClient, runNextActual };
}

function appendTurn(conversation, { model = "gemini-3.8-flash-high", status = "queued", deviceId = "phone-a", text = "task" } = {}) {
  conversation.model = model;
  conversation.harnessId = model.startsWith("gemini-") ? "google-antigravity" : "grok-build";
  conversation.providerId = model.startsWith("gemini-") ? "sub2api" : "grok2api";
  const user = { id: uuid(), role: "user", text, status, senderDeviceId: deviceId,
    attachments: [], createdAt: new Date().toISOString() };
  const assistant = { id: uuid(), role: "assistant", text: "", status, replyTo: user.id,
    stream: [], activity: [], createdAt: new Date().toISOString() };
  conversation.messages.push(user, assistant);
  conversation.updatedAt = new Date().toISOString();
  return { user, assistant };
}

async function waitFor(predicate, message, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

for (const state of ["paused", "closed"]) {
  test(`queued ${state} remote workspace fails only its turn and the next valid turn starts`, async (t) => {
    const fx = fixture(t);
    await fx.service.recovery;
    const conversation = fx.service.createConversation("stale assist", "gemini-3.8-flash-high");
    const failed = appendTurn(conversation);
    fx.service.store.save(conversation, { immediate: true });
    fx.service.remoteWorkspaceService = {
      bindingForConversation: (id) => id === conversation.id ? { state } : null,
      runtimeFor: RemoteWorkspaceService.prototype.runtimeFor,
    };
    let remoteStarts = 0;
    fx.service.runAntigravityTurn = async () => { remoteStarts += 1; };
    await fx.runNextActual();
    const stored = fx.service.readConversation(conversation.id, { forceFresh: true });
    assert.equal(stored.messages.find((m) => m.id === failed.user.id).status, "failed");
    const result = stored.messages.find((m) => m.id === failed.assistant.id);
    assert.equal(result.status, "failed");
    assert.match(result.text, /远程工作区当前不可用/);
    assert.match(result.text, /不会自动重试/);
    assert.equal(remoteStarts, 0);
    assert.equal(fx.workerClient.starts.length, 0, "remote task must not fall back to server tools");
    assert.equal(fx.service.runningNext, false);

    const valid = fx.service.createConversation("healthy next turn", "gemini-3.8-flash-high");
    appendTurn(valid);
    fx.service.store.save(valid, { immediate: true });
    fx.service.runNext = fx.runNextActual;
    await waitFor(() => fx.workerClient.starts.length === 1, "queue should continue after stale turn");
    assert.equal(fx.workerClient.starts[0].conversationId, valid.id);
    assert.equal(remoteStarts, 0);
  });
}

test("authorization revoked during async dispatch fails cleanly without launching a harness", async (t) => {
  const fx = fixture(t);
  await fx.service.recovery;
  const conversation = fx.service.createConversation("revocation race", "gemini-3.8-flash-high");
  const turn = appendTurn(conversation);
  fx.service.store.save(conversation, { immediate: true });
  const binding = { state: "active" };
  fx.service.remoteWorkspaceService = {
    bindingForConversation: () => binding,
    runtimeFor(b) {
      if (b.state !== "active") return RemoteWorkspaceService.prototype.runtimeFor.call(this, b);
      return { cwd: fx.root };
    },
  };
  fx.workerClient.isAvailable = async () => { binding.state = "closed"; return true; };
  fx.service.antigravityAdapter = () => { assert.fail("revoked session must not create adapter"); };
  await fx.runNextActual();
  const result = fx.service.readConversation(conversation.id, { forceFresh: true })
    .messages.find((m) => m.id === turn.assistant.id);
  assert.equal(result.status, "failed");
  assert.match(result.text, /远程工作区当前不可用/);
  assert.equal(fx.service.active, null);
  assert.equal(fx.workerClient.starts.length, 0);
});

test("unexpected dispatch errors fail the turn without leaking error details or retrying", async (t) => {
  const fx = fixture(t);
  await fx.service.recovery;
  const conversation = fx.service.createConversation("dispatch failure", "gemini-3.8-flash-high");
  const turn = appendTurn(conversation);
  fx.service.store.save(conversation, { immediate: true });
  fx.service.effectiveWorkDir = () => { throw new Error("private-path-and-credential"); };
  await fx.runNextActual();
  const result = fx.service.readConversation(conversation.id, { forceFresh: true })
    .messages.find((m) => m.id === turn.assistant.id);
  assert.equal(result.status, "failed");
  assert.match(result.text, /本轮任务调度失败/);
  assert.doesNotMatch(result.text, /private-path-and-credential/);
  assert.equal(fx.service.active, null);
  assert.equal(fx.service.runningNext, false);
});

test("queue storage failure is contained at the timer entry point without automatic retry", async (t) => {
  const fx = fixture(t);
  await fx.service.recovery;
  let calls = 0;
  fx.service.nextQueued = () => { calls += 1; throw new Error("storage unavailable"); };
  await assert.doesNotReject(fx.runNextActual());
  assert.equal(calls, 1);
  assert.equal(fx.service.runningNext, false);
});

function requestResult(service, invoke) {
  const res = {};
  return Promise.resolve(invoke(res)).then(() => res);
}

test("finished Worker turn clears active and automatically starts queued Gemini without Codex steer", async (t) => {
  const fx = fixture(t);
  await fx.service.recovery;
  const conversation = fx.service.createConversation("Gemini queue", "gemini-3.8-flash-high");
  const first = appendTurn(conversation, { status: "queued", text: "first Gemini request" });
  const second = appendTurn(conversation, { status: "queued", text: "second Gemini request" });
  fx.service.store.save(conversation, { immediate: true });
  let steerCalls = 0;
  fx.service.sendSteer = () => { steerCalls += 1; };
  fx.service.clientFor = () => { throw new Error("queued Gemini must not start Codex"); };
  fx.service.runNext = fx.runNextActual;

  await fx.runNextActual();
  assert.equal(fx.workerClient.starts.length, 1);
  assert.equal(fx.workerClient.starts[0].assistantMessageId, first.assistant.id);
  assert.equal(fx.service.active?.messageId, first.assistant.id);

  fx.workerClient.finish(conversation.id, first.assistant.id);
  assert.equal(fx.service.active, null, "finishing a Worker turn must clear the active slot before queue dispatch");
  await waitFor(() => fx.workerClient.starts.length === 2,
    "the queued Gemini turn should start after the first Worker finish");
  assert.equal(fx.service.active?.messageId, second.assistant.id);
  assert.equal(steerCalls, 0);
  assert.equal(fx.service.readConversation(conversation.id).messages.find((m) => m.id === second.user.id).status,
    "running");
});

test("web-service recovery reconnects to the running Worker and retains originating device ownership", async (t) => {
  const fx = fixture(t);
  await fx.service.recovery;
  const conversation = fx.service.createConversation("resume Gemini", "gemini-3.8-flash-high");
  const { user, assistant } = appendTurn(conversation, { status: "running", deviceId: "origin-phone" });
  fx.service.store.save(conversation, { immediate: true });
  fx.workerClient.turns.set(turnKey(conversation.id, assistant.id), {
    params: {}, status: "running", handlers: null, unsubscribeCount: 0,
  });
  const options = {
    chatDir: fx.chatDir,
    dataDir: path.join(fx.root, "files"),
    imageDir: path.join(fx.root, "images"),
    codexBin: "/bin/false",
    codexWorkDir: fx.root,
    sendJson(res, status, payload) { res.status = status; res.payload = payload; },
    readJsonBody(req, _limit, callback) { callback(null, req.body || {}); },
    allowedModels: null,
    workerClient: fx.workerClient,
  };
  const recovered = new ChatService(options);
  recovered.runNext = () => {};
  t.after(() => {
    recovered.active?.unsubscribe?.();
    for (const entry of recovered.jsonCheckpoints.values()) clearTimeout(entry.timer);
    recovered.store.close();
  });
  await recovered.recovery;
  assert.equal(recovered.readConversation(conversation.id).messages.find((m) => m.id === assistant.id).status, "running");
  assert.equal(recovered.active?.messageId, assistant.id);
  assert.equal(recovered.active?.ownerDeviceId, "origin-phone");
  assert.equal(fx.workerClient.starts.length, 0, "a known running Worker key must resume without duplicate start");

  const wrongDevice = {};
  await recovered.interruptConversation(wrongDevice, conversation.id, "other-phone");
  assert.equal(wrongDevice.status, 409);
  assert.equal(fx.workerClient.interrupts.length, 0);
  const ownerDevice = {};
  await recovered.interruptConversation(ownerDevice, conversation.id, user.senderDeviceId);
  assert.equal(ownerDevice.status, 202);
  assert.equal(fx.workerClient.interrupts.length, 1);
});

test("pending Worker dispatch recovers through the same assistant key when no Worker key exists", async (t) => {
  let seededConversation;
  let seededTurn;
  const fx = fixture(t, {
    seed({ store }) {
      seededConversation = {
        id: uuid(),
        title: "dispatch window recovery",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        archived: false,
        model: "gemini-3.8-flash-high",
        harnessId: "google-antigravity",
        providerId: "sub2api",
        codexProfile: "default",
        reasoning: "medium",
        accessMode: "danger-full-access",
        workDir: "",
        messages: [],
      };
      seededTurn = appendTurn(seededConversation, {
        status: "running", deviceId: "origin-phone", text: "dispatch before restart",
      });
      seededTurn.assistant.workerDispatchPending = true;
      store.save(seededConversation, { immediate: true });
    },
  });
  await fx.service.recovery;

  const recovered = fx.service.readConversation(seededConversation.id, { forceFresh: true });
  assert.equal(recovered.messages.find((m) => m.id === seededTurn.assistant.id).status, "queued");
  assert.equal(recovered.messages.find((m) => m.id === seededTurn.user.id).status, "queued");
  assert.equal(fx.workerClient.turns.has(turnKey(seededConversation.id, seededTurn.assistant.id)), false,
    "the simulated Worker has no registration for the pending dispatch key");

  await fx.runNextActual();
  assert.equal(fx.workerClient.starts.length, 1);
  assert.equal(fx.workerClient.starts[0].assistantMessageId, seededTurn.assistant.id,
    "retry must register the original assistant key instead of creating a new turn id");
  assert.equal(fx.workerClient.turns.has(turnKey(seededConversation.id, seededTurn.assistant.id)), true);
  const afterDispatch = fx.service.readConversation(seededConversation.id, { forceFresh: true });
  assert.equal(afterDispatch.messages.find((m) => m.id === seededTurn.assistant.id).status, "running");
  assert.notEqual(afterDispatch.messages.find((m) => m.id === seededTurn.assistant.id).status, "failed");
});

test("a failed Worker cancellation remains running and is not reported as interrupted", async (t) => {
  const fx = fixture(t);
  await fx.service.recovery;
  const conversation = fx.service.createConversation("cancel failure", "gemini-3.8-flash-high");
  const { user, assistant } = appendTurn(conversation, { status: "queued", deviceId: "phone-a" });
  fx.service.store.save(conversation, { immediate: true });
  await fx.runNextActual();
  fx.workerClient.interruptResult = { ok: false, status: 503, error: "worker unavailable" };

  const res = {};
  await fx.service.interruptConversation(res, conversation.id, user.senderDeviceId);
  const persisted = fx.service.readConversation(conversation.id, { forceFresh: true });
  assert.equal(res.status, 503);
  assert.equal(persisted.messages.find((m) => m.id === assistant.id).status, "running");
  assert.notEqual(persisted.messages.find((m) => m.id === assistant.id).status, "interrupted");
  assert.equal(fx.service.active?.interruptRequested, false);
});

test("Worker unavailable fails Grok and Gemini turns without falling back to local harnesses", async (t) => {
  for (const model of ["grok-4.7-high", "gemini-3.8-flash-high"]) {
    const fx = fixture(t, { workerClient: new FakeWorkerClient({ available: false }) });
    await fx.service.recovery;
    const conversation = fx.service.createConversation(`unavailable ${model}`, model);
    const { user, assistant } = appendTurn(conversation, { status: "queued", model });
    fx.service.store.save(conversation, { immediate: true });
    let localCalls = 0;
    fx.service.runGrokTurn = async () => { localCalls += 1; };
    fx.service.runAntigravityTurn = async () => { localCalls += 1; };

    await fx.runNextActual();
    const persisted = fx.service.readConversation(conversation.id, { forceFresh: true });
    assert.equal(localCalls, 0, `${model} must not use an in-process fallback`);
    assert.equal(fx.workerClient.starts.length, 0);
    assert.equal(persisted.messages.find((m) => m.id === user.id).status, "failed");
    assert.equal(persisted.messages.find((m) => m.id === assistant.id).status, "failed");
    assert.match(persisted.messages.find((m) => m.id === assistant.id).text, /执行服务暂时不可用/);
  }
});

test("Worker unsupported approval is returned as failure and stays pending", async (t) => {
  const fx = fixture(t);
  await fx.service.recovery;
  const conversation = fx.service.createConversation("approval", "gemini-3.8-flash-high");
  const { user, assistant } = appendTurn(conversation, { status: "queued", deviceId: "phone-a" });
  const approvalId = uuid();
  assistant.stream.push({ id: `approval-${approvalId}`, kind: "approval", approvalId,
    status: "pending", approvalOptions: [{ id: "accept", label: "允许" }] });
  fx.service.store.save(conversation, { immediate: true });
  await fx.runNextActual();
  fx.workerClient.approvalResult = { ok: false, status: 501, error: "approval_unsupported" };

  const res = {};
  await requestResult(fx.service, () => fx.service.resolveApproval({ body: { choiceId: "accept" } }, res,
    conversation.id, approvalId, user.senderDeviceId));
  await waitFor(() => Number.isInteger(res.status), "approval request should return a response");
  assert.equal(res.status, 501);
  const persisted = fx.service.readConversation(conversation.id, { forceFresh: true });
  assert.equal(persisted.messages.find((m) => m.id === assistant.id).stream.find((e) => e.approvalId === approvalId).status,
    "pending");
  assert.equal(fx.workerClient.approvals.length, 1);
});

test("web queued message survives Worker patchMessages using two actual SQLite stores", async (t) => {
  const fx = fixture(t);
  await fx.service.recovery;
  const conversation = fx.service.createConversation("two stores", "gemini-3.8-flash-high");
  const current = appendTurn(conversation, { status: "running", deviceId: "phone-a" });
  fx.service.store.save(conversation, { immediate: true });

  const workerStore = new ConversationStore(fx.chatDir);
  t.after(() => workerStore.close());
  const webSnapshot = fx.service.readConversation(conversation.id, { forceFresh: true });
  const queued = appendTurn(webSnapshot, { status: "queued", deviceId: "phone-a", text: "next turn" });
  fx.service.writeConversation(webSnapshot);

  const workerAssistant = structuredClone(current.assistant);
  workerAssistant.text = "worker streamed response";
  workerAssistant.stream = [{ id: "message-1", kind: "message", text: "worker streamed response" }];
  workerStore.patchMessages(conversation.id, [workerAssistant], { harnessSessionId: "gemini-session-2" });

  const persisted = fx.service.readConversation(conversation.id, { forceFresh: true });
  assert.equal(persisted.messages.find((m) => m.id === current.assistant.id).text, "worker streamed response");
  assert.ok(persisted.messages.some((m) => m.id === queued.user.id), "Worker patch must retain web-added user message");
  assert.ok(persisted.messages.some((m) => m.id === queued.assistant.id), "Worker patch must retain queued assistant message");
  assert.equal(persisted.harnessSessionId, "gemini-session-2");
});
