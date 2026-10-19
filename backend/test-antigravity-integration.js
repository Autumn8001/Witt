"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { ChatService } = require("./chat-service");

test("isolated Antigravity CLI retains native permissions even for a full-access conversation", () => {
  const { AntigravityAdapter } = require("./runtime/antigravity-adapter");
  assert.throws(() => new AntigravityAdapter({ remoteWorkspace: { remoteCli: {} } }), /ISOLATED_REMOTE_CLI_REQUIRED/);
  const adapter = new AntigravityAdapter({ skipPermissions: true, runAsAdmin: true,
    remoteWorkspace: { home: "/home/assist", remoteCli: { isolated: true, socketPath: "/channel/control.sock" } } });
  assert.equal(adapter.buildArgs({ prompt: "test", skipPermissions: true }).includes("--dangerously-skip-permissions"), false);
  assert.equal(adapter.childEnv().CHLOE_AGY_ADMIN_EXECUTION, "0");
  assert.equal(adapter.childEnv().CHLOE_REMOTE_SOCKET, "/channel/control.sock");
  assert.equal(adapter.formatToolCall({ tool: "run_command", input: { CommandLine: "chloe-remote read README.md" } }).details.command,
    "chloe-remote read README.md");
});

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

test("remote Antigravity turns get a longer bounded budget without changing local defaults", () => {
  const service = Object.create(ChatService.prototype);
  service.harnessOptions = { antigravity: {} };
  service.effectiveWorkDir = () => "/workspace";
  const binding = { workspace_id: "test" };
  service.remoteWorkspaceBinding = conversation => conversation.remote ? binding : null;
  service.remoteWorkspaceService = { runtimeFor: () => ({ geminiBin: "/tools/agy" }) };
  assert.equal(service.antigravityAdapter("test-model", {}).printTimeoutMs, 300000);
  const remote = service.antigravityAdapter("test-model", { remote: true });
  assert.equal(remote.printTimeoutMs, 900000);
  const args = remote.buildArgs({ prompt: "test" });
  assert.equal(args[args.indexOf("--print-timeout") + 1], "900s");
  service.harnessOptions.antigravity.timeoutMs = 420000;
  assert.equal(service.antigravityAdapter("test-model", { remote: true }).printTimeoutMs, 420000);
  service.harnessOptions.antigravity.remoteTimeoutMs = 600000;
  assert.equal(service.antigravityAdapter("test-model", { remote: true }).printTimeoutMs, 600000);
});

test("remote device waiting is visible in the existing conversation stream and resolves in place", () => {
  const service = Object.create(ChatService.prototype);
  const assistant = { id: "assistant", stream: [], activity: [] };
  const conversation = { id: "conversation", messages: [assistant] };
  service.active = { conversationId: conversation.id, messageId: assistant.id, finished: false };
  service.readConversation = () => conversation;
  let saves = 0;
  service.writeConversation = () => { saves++; };
  const binding = { conversation_id: conversation.id };
  service.notifyRemoteWorkspaceWait(binding, { id: "wait-1", state: "waiting" });
  assert.equal(assistant.stream.length, 1);
  assert.equal(assistant.stream[0].status, "running");
  assert.match(assistant.stream[0].summary, /正在等待/);
  assert.match(assistant.stream[0].label, /正在等待/);
  service.notifyRemoteWorkspaceWait(binding, { id: "wait-1", state: "resumed" });
  assert.equal(assistant.stream.length, 1);
  assert.equal(assistant.stream[0].status, "completed");
  assert.equal(assistant.activity[0].status, "completed");
  service.notifyRemoteWorkspaceWait({ conversation_id: "other-customer" }, { id: "wait-2", state: "waiting" });
  assert.equal(saves, 2);
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

test("Antigravity tool DONE updates match the original step and complete reads", () => {
  const { parseAntigravityEvent } = require("./runtime/event-parsers");
  const { AntigravityAdapter } = require("./runtime/antigravity-adapter");
  const start = parseAntigravityEvent({ event: "step_update", step_update: {
    step_index: 5, state: "ACTIVE", tool_info: { name: "view_file", input: { AbsolutePath: "/workspace/schema.json" } },
  } });
  const end = parseAntigravityEvent({ event: "step_update", step_update: {
    step_index: 5, state: "DONE", tool_info: { name: "view_file", output: "schema" },
  } });
  assert.equal(start.id, end.id);
  assert.equal(end.type, "tool_call_update");
  assert.equal(end.status, "completed");
  const adapter = new AntigravityAdapter({ bin: "agy" });
  assert.equal(adapter.formatToolUpdate(end).status, "completed");
  assert.deepEqual(adapter.buildArgs({ prompt: "image", addDirs: ["/attachments"] }).slice(0, 2), ["--add-dir", "/attachments"]);
});

test("a terminal tool first reported as DONE is retained in Chloe", async () => {
  const { AntigravityAdapter } = require("./runtime/antigravity-adapter");
  const turn = makeTurn({ events: [{ type: "tool_call_update", id: "tool-5", tool: "run_command",
    status: "completed", input: { CommandLine: "chloe-remote read README.md" }, output: "windows-marker" }],
    result: { ok: true, text: "done" } });
  const adapter = new AntigravityAdapter();
  // Keep the fake process, exercising the real presentation of native events.
  const fake = turn.service.antigravityAdapter();
  fake.formatToolCall = adapter.formatToolCall.bind(adapter);
  fake.formatToolUpdate = adapter.formatToolUpdate.bind(adapter);
  const upsert = turn.service.upsertStream;
  turn.service.upsertStream = (message, id, fields) => Object.assign(upsert(message, id, fields), fields);
  await turn.run();
  const entry = turn.assistant.stream.find(e => e.id === "tool-5");
  assert.equal(entry.kind, "command");assert.equal(entry.status, "completed");
  assert.equal(entry.details.output, "windows-marker");
});
