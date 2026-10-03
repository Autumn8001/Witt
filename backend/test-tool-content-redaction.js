"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { ChatService } = require("./chat-service");
const { GrokBuildAdapter } = require("./runtime/grok-build-adapter");
const { redactHarnessText, sanitizeHarnessContent } = require("./runtime/tool-content");

function makeService(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "witt-tool-redaction-"));
  const service = new ChatService({
    chatDir: path.join(directory, "chat"), dataDir: path.join(directory, "files"),
    imageDir: path.join(directory, "images"), codexBin: "/bin/false", codexWorkDir: directory,
    sendJson() {}, readJsonBody(_req, _limit, callback) { callback(null, {}); }, allowedModels: null,
  });
  service.runNext = () => {};
  t.after(() => {
    for (const entry of service.jsonCheckpoints.values()) clearTimeout(entry.timer);
    for (const timer of service.eventBroadcasts.values()) clearTimeout(timer);
    for (const pending of [...service.store.pendingSaves.values()])
      service.store.save(pending.conversation, { immediate: true });
    service.store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return service;
}

test("harness content redaction handles secret fields, assignments, flags, bearer values and token shapes", () => {
  const input = sanitizeHarnessContent({
    apiKey: "field-secret-1",
    nested: { password: "field-secret-2", output: "API_KEY=assignment-secret useful diagnostic" },
    command: "curl --api-key=flag-secret -H 'Authorization: Bearer header-secret'",
    safe: "process exited with status 17",
  });
  const serialized = JSON.stringify(input);
  for (const value of ["field-secret-1", "field-secret-2", "assignment-secret", "flag-secret", "header-secret"])
    assert.equal(serialized.includes(value), false);
  assert.match(serialized, /useful diagnostic/);
  assert.match(serialized, /status 17/);
  assert.match(redactHarnessText("xai-abcdefghijklmnopqrstuv"), /REDACTED/);
});

test("Grok tool call and update persistence redact command, input, error and output while retaining exit status", async (t) => {
  const service = makeService(t);
  const conversation = service.createConversation();
  const user = { id: crypto.randomUUID(), role: "user", text: "run command", status: "running",
    attachments: [], createdAt: new Date().toISOString() };
  const assistant = { id: crypto.randomUUID(), role: "assistant", text: "", status: "running",
    replyTo: user.id, stream: [], activity: [], createdAt: new Date().toISOString() };
  conversation.messages.push(user, assistant);
  service.writeConversation(conversation);

  service.grokAdapter = () => Object.assign(new GrokBuildAdapter({ bin: "/bin/false" }), {
    async startRuntime() {},
    sendPrompt() {
      const events = new EventEmitter();
      let finish;
      const done = new Promise((resolve) => { finish = resolve; });
      setImmediate(() => {
        events.emit("event", { type: "tool_call", id: "call-1", tool: "run_terminal_command",
          input: { command: "curl --api-key=command-secret -H 'Authorization: Bearer command-header'",
            password: "input-secret" } });
        events.emit("event", { type: "tool_call_update", id: "call-1", status: "failed",
          output: { exitCode: 23, stderr: "API_KEY=output-secret useful diagnostic", error: "token=error-secret" } });
        events.emit("event", { type: "text_delta", text: "Finished" });
        finish({ ok: true, sessionId: null });
      });
      return { events, done, sessionId: null };
    },
  });

  await service.runGrokTurn(conversation, user, assistant, "grok-4.7-high", "medium", []);
  const saved = service.readConversation(conversation.id);
  const command = saved.messages.find((message) => message.id === assistant.id)
    .stream.find((entry) => entry.id === "call-1");
  const serialized = JSON.stringify(command);
  for (const value of ["command-secret", "command-header", "input-secret", "output-secret", "error-secret"])
    assert.equal(serialized.includes(value), false);
  assert.equal(command.exitCode, 23);
  assert.equal(command.details.exitCode, 23);
  assert.match(command.details.command, /REDACTED/);
  assert.match(command.details.output, /useful diagnostic/);
  assert.equal(saved.messages.find((message) => message.id === assistant.id).status, "completed");
});
