"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ChatService } = require("../backend/chat-service");
const { WorkerService, TurnInstance } = require("../backend/worker-service");
const { AntigravityAdapter } = require("../backend/runtime/antigravity-adapter");

const MODEL = "gemini-3.8-flash-high";
const LEVELS = ["low", "medium", "high"];
const uuid = () => require("node:crypto").randomUUID();

function fakeHandle() {
  const events = new EventEmitter();
  return {
    events,
    done: Promise.resolve({ ok: true, text: "reply", sessionId: "test-session" }),
  };
}

async function withFakeAdapter(sendPrompt, fn) {
  const originalStart = AntigravityAdapter.prototype.startRuntime;
  const originalSend = AntigravityAdapter.prototype.sendPrompt;
  AntigravityAdapter.prototype.startRuntime = async function startRuntime() {};
  AntigravityAdapter.prototype.sendPrompt = sendPrompt;
  try {
    await fn();
  } finally {
    AntigravityAdapter.prototype.startRuntime = originalStart;
    AntigravityAdapter.prototype.sendPrompt = originalSend;
  }
}

function makeConversation() {
  return {
    id: uuid(),
    messages: [
      { id: uuid(), role: "user", text: "hello", stream: [] },
      { id: uuid(), role: "assistant", text: "", status: "running", stream: [], activity: [] },
    ],
  };
}

test("Antigravity CLI args keep model identity and pass each supported effort", () => {
  const adapter = new AntigravityAdapter({ model: MODEL });
  for (const effort of LEVELS) {
    const args = adapter.buildArgs({ model: MODEL, effort });
    const modelIndex = args.indexOf("--model");
    const effortIndex = args.indexOf("--effort");
    assert.equal(args[modelIndex + 1], "gemini-3.8-flash");
    assert.equal(args[effortIndex + 1], effort);
  }
  assert.equal(adapter.buildArgs({ model: MODEL }).includes("--effort"), false);
  assert.throws(() => adapter.buildArgs({ model: MODEL, effort: "xhigh" }), /Unsupported Antigravity/);
  const configured = new AntigravityAdapter({ model: MODEL, effort: "high" });
  const explicitParams = configured.buildArgs({ effort: "low" });
  assert.equal(explicitParams[explicitParams.indexOf("--model") + 1], "gemini-3.8-flash");
  assert.equal(explicitParams[explicitParams.indexOf("--effort") + 1], "low");
  assert.equal(configured.buildArgs({ effort: null }).includes("--effort"), false);
  assert.equal(configured.buildArgs({ effort: null })[
    configured.buildArgs({ effort: null }).indexOf("--model") + 1
  ], MODEL);
  const unrelatedModel = new AntigravityAdapter({ model: "claude-sonnet-high" });
  assert.equal(unrelatedModel.buildArgs({ effort: "low" })[
    unrelatedModel.buildArgs({ effort: "low" }).indexOf("--model") + 1
  ], "claude-sonnet-high");
});

test("HarnessProcess child receives explicit --effort flags", async () => {
  const adapter = new AntigravityAdapter({ bin: process.execPath, model: MODEL, printTimeoutMs: 10000 });
  const originalBuildArgs = adapter.buildArgs.bind(adapter);
  adapter.buildArgs = (params) => [
    "-e",
    'process.stdout.write(JSON.stringify(process.argv.slice(1)) + "\\n");',
    "--",
    ...originalBuildArgs(params),
  ];
  const seen = [];
  for (const effort of LEVELS) {
    const handle = adapter.sendPrompt({ model: MODEL, effort });
    handle.events.on("event", (event) => {
      if (event.type === "unknown") seen.push(event.raw);
    });
    const result = await handle.done;
    assert.equal(result.ok, true);
  }
  assert.equal(seen.length, LEVELS.length);
  for (let index = 0; index < LEVELS.length; index += 1) {
    const args = seen[index];
    assert.ok(args.includes("--model"));
    assert.equal(args[args.indexOf("--model") + 1], "gemini-3.8-flash");
    assert.ok(args.includes("--effort"));
    assert.equal(args[args.indexOf("--effort") + 1], LEVELS[index]);
  }
});

test("direct chat Antigravity path passes selected low/medium/high effort", async () => {
  const captured = [];
  await withFakeAdapter((params) => { captured.push(params); return fakeHandle(); }, async () => {
    for (const reasoning of LEVELS) {
      const conversation = makeConversation();
      const assistant = conversation.messages[1];
      const service = Object.create(ChatService.prototype);
      service.harnessOptions = {};
      service.effectiveWorkDir = () => process.cwd();
      service.remoteWorkspaceBinding = () => null;
      service.buildPrompt = () => "prompt";
      service.requestActiveInterrupt = () => {};
      service.readConversation = () => conversation;
      service.writeConversation = () => {};
      service.appendGitChanges = async () => {};
      service.store = { save() {} };
      service.finishActive = (success, text, error) => {
        service.finished = { success, text, error };
        service.active.finished = true;
      };
      await service.runAntigravityTurn(conversation, { id: "user" }, assistant, MODEL, reasoning, []);
      assert.deepEqual(service.finished, { success: true, text: "reply", error: "" });
    }
  });
  assert.deepEqual(captured.map((params) => params.effort), LEVELS);
  assert.ok(captured.every((params) => params.model === MODEL));
});

test("worker Antigravity path passes selected low/medium/high effort", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "witt-effort-worker-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const captured = [];
  await withFakeAdapter((params) => { captured.push(params); return fakeHandle(); }, async () => {
    for (const reasoning of LEVELS) {
      const conversation = makeConversation();
      const store = {
        load() { return structuredClone(conversation); },
        patchMessages(_id, messages) {
          for (const message of messages) {
            const index = conversation.messages.findIndex((entry) => entry.id === message.id);
            if (index >= 0) conversation.messages[index] = structuredClone(message);
          }
        },
      };
      const worker = new WorkerService({ stateDir: path.join(root, reasoning) });
      worker.getStore = () => store;
      const turn = new TurnInstance({
        conversationId: conversation.id,
        userMessageId: conversation.messages[0].id,
        assistantMessageId: conversation.messages[1].id,
        harnessId: "google-antigravity",
        model: MODEL,
        reasoning,
        workDir: root,
        chatDir: root,
      }, worker);
      turn.appendGitChanges = async () => {};
      await turn._runAntigravity();
      assert.equal(turn.status, "completed");
    }
  });
  assert.deepEqual(captured.map((params) => params.effort), LEVELS);
  assert.ok(captured.every((params) => params.model === MODEL));
});
