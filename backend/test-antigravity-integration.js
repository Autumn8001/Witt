"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { ChatService } = require("./chat-service");

test("Antigravity permissions follow only the conversation access mode", () => {
  const service = Object.create(ChatService.prototype);
  service.harnessOptions = { antigravity: { skipPermissions: true } };
  service.effectiveWorkDir = () => "/workspace";

  for (const accessMode of ["read-only", "workspace-write", undefined]) {
    const adapter = service.antigravityAdapter("test-model", { accessMode });
    assert.equal(adapter.skipPermissions, false, `${accessMode || "missing accessMode"} must retain permissions`);
    assert.equal(adapter.buildArgs({ prompt: "offline" }).includes("--dangerously-skip-permissions"), false);
  }

  const unrestricted = service.antigravityAdapter("test-model", {
    accessMode: "danger-full-access",
  });
  assert.equal(unrestricted.skipPermissions, true);
  assert.equal(unrestricted.buildArgs({ prompt: "offline" }).includes("--dangerously-skip-permissions"), true);
});

function makeTurn({ result, events = [], interrupt = false, harnessSessionId = null }) {
  const user = { id: "user-1", role: "user", text: "do the task", status: "running" };
  const assistant = {
    id: "assistant-1", role: "assistant", text: "", status: "running",
    replyTo: user.id, stream: [], activity: [],
  };
  const conversation = {
    id: "conversation-1", accessMode: "workspace-write", workDir: "/workspace",
    harnessSessionId, messages: [user, assistant],
  };
  const calls = [];
  const adapter = {
    skipPermissions: false,
    async startRuntime() {
      if (interrupt) service.active.interruptRequested = true;
    },
    sendPrompt(params) {
      calls.push({ type: "sendPrompt", params });
      const stream = new EventEmitter();
      const done = new Promise((resolve) => {
        setImmediate(() => {
          for (const event of events) stream.emit("event", event);
          resolve(result);
        });
      });
      return { events: stream, done };
    },
  };

  const service = Object.create(ChatService.prototype);
  service.active = null;
  service.store = { save() {} };
  service.effectiveWorkDir = () => "/workspace";
  service.remoteWorkspaceBinding = () => null;
  service.buildPrompt = () => "offline prompt";
  service.antigravityAdapter = () => adapter;
  service.readConversation = () => conversation;
  service.writeConversation = () => {};
  service.upsertStream = (message, id, defaults) => {
    let entry = message.stream.find((item) => item.id === id);
    if (!entry) {
      entry = { id, ...defaults };
      message.stream.push(entry);
    }
    return entry;
  };
  service.addActivity = (message, type, label, status) => {
    message.activity.push({ type, label, status });
  };
  service.appendGitChanges = async () => { calls.push({ type: "git" }); };
  service.finishActive = (success, response, error, interrupted = false) => {
    calls.push({ type: "finish", success, response, error, interrupted });
  };

  return { service, conversation, user, assistant, calls, run: () =>
    service.runAntigravityTurn(conversation, user, assistant, "test-model", "medium", []) };
}

function completion(calls) {
  return calls.find((call) => call.type === "finish");
}

test("partial output does not turn a failed Antigravity result into success", async () => {
  const turn = makeTurn({
    events: [{ type: "text_delta", text: "partial answer" }],
    result: { ok: false, errorType: "process_exited", text: "" },
  });
  await turn.run();
  assert.equal(completion(turn.calls).success, false);
  assert.equal(completion(turn.calls).response, "partial answer");
});

test("an Antigravity error event fails even when the final result says ok", async () => {
  const turn = makeTurn({
    events: [
      { type: "text_delta", text: "answer" },
      { type: "error", error: "reported runtime error" },
    ],
    result: { ok: true, text: "answer" },
  });
  await turn.run();
  assert.equal(completion(turn.calls).success, false);
});

test("timeout and interrupt results follow their dedicated failure branches", async () => {
  const timedOut = makeTurn({
    events: [{ type: "text_delta", text: "partial" }],
    result: { ok: true, timedOut: true, text: "partial" },
  });
  await timedOut.run();
  assert.equal(completion(timedOut.calls).success, false);
  assert.match(completion(timedOut.calls).error, /timeout/i);

  const interrupted = makeTurn({ result: { ok: true, text: "" }, interrupt: true });
  await interrupted.run();
  assert.equal(completion(interrupted.calls).success, false);
  assert.equal(completion(interrupted.calls).interrupted, true);
  assert.equal(interrupted.calls.some((call) => call.type === "sendPrompt"), false);
});

test("empty output fails, while success passes an empty error argument", async () => {
  const empty = makeTurn({ result: { ok: true, text: "  " } });
  await empty.run();
  assert.equal(completion(empty.calls).success, false);

  const successful = makeTurn({
    events: [{ type: "text_delta", text: "completed answer" }],
    result: { ok: true, text: "completed answer" },
  });
  await successful.run();
  assert.equal(completion(successful.calls).success, true);
  assert.equal(completion(successful.calls).error, "");
});

test("git changes are collected before completion and existing session is resumed", async () => {
  const turn = makeTurn({
    result: { ok: true, text: "done" },
    harnessSessionId: "existing-session",
  });
  await turn.run();
  assert.deepEqual(turn.calls.map((call) => call.type), ["sendPrompt", "git", "finish"]);
  assert.equal(turn.calls[0].params.conversationId, "existing-session");
});

test("Gemini result errors are redacted and fail the turn without throwing", async () => {
  const turn = makeTurn({
    events: [{ type: "result", error: "authentication failed api_key=private-test-value" }],
    result: { ok: false, errorType: "process_exited" },
  });
  await turn.run();
  assert.equal(completion(turn.calls).success, false);
  assert.match(turn.service.active.harnessEventError, /authentication failed/);
  assert.doesNotMatch(turn.service.active.harnessEventError, /private-test-value/);
});

test("new remote Gemini contexts start fresh and resume only after CLI session discovery", async () => {
  for (const started of [false, true]) {
    const turn = makeTurn({ harnessSessionId: "bound-session", result: { ok: true, text: "hello" } });
    turn.service.remoteWorkspaceBinding = () => ({ workspace_id: "workspace" });
    turn.conversation.remoteWorkspaceStarted = started;
    await turn.run();
    assert.equal(turn.calls[0].params.conversationId, started ? "bound-session" : undefined);
    assert.equal(completion(turn.calls).success, true);
  }
});
