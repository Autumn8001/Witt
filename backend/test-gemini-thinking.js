"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { parseAntigravityEvent } = require("./runtime/event-parsers");
const { AntigravityAdapter } = require("./runtime/antigravity-adapter");

test("parseAntigravityEvent parses reasoning_delta and tool_call", () => {
  const stepThought = parseAntigravityEvent({
    event: "step_update",
    step_update: { conversation_id: "c-1", step_index: 1, state: "ACTIVE", thinking_delta: "正在分析问题根因..." },
  });
  assert.equal(stepThought.type, "reasoning_delta");
  assert.equal(stepThought.text, "正在分析问题根因...");

  const stepTool = parseAntigravityEvent({
    event: "step_update",
    step_update: {
      conversation_id: "c-1",
      step_index: 2,
      state: "ACTIVE",
      tool_info: { id: "call_1", name: "exec", input: { command: "git status" }, status: "running" },
    },
  });
  assert.equal(stepTool.type, "tool_call");
  assert.equal(stepTool.tool, "exec");
  assert.deepEqual(stepTool.input, { command: "git status" });
});

test("Antigravity parser preserves plans and separates tool updates", () => {
  const plan = parseAntigravityEvent({
    type: "step_update",
    step: { conversationId: "c-2", steps: [{ title: "读取项目", status: "completed" }] },
  });
  assert.equal(plan.type, "plan");
  assert.equal(plan.entries[0].title, "读取项目");

  const update = parseAntigravityEvent({
    type: "step_update",
    step: { toolCall: { call_id: "call_2", name: "exec", status: "completed", result: "ok" } },
  });
  assert.equal(update.type, "tool_call_update");
  assert.equal(update.id, "call_2");
  assert.equal(update.output, "ok");
});

test("Antigravity parser treats non-success result status as a failure", () => {
  const result = parseAntigravityEvent({
    type: "result", result: { status: "FAILED", response: "", error: "tool failed" },
  });
  assert.equal(result.type, "result");
  assert.equal(result.error, "tool failed");
});

test("AntigravityAdapter formats commands, file operations and custom tools", () => {
  const adapter = new AntigravityAdapter({ bin: "agy" });

  // 1. 命令工具
  const cmdCall = {
    type: "tool_call",
    tool: "exec",
    input: { command: "npm test" },
    status: "running",
  };
  const presentedCmd = adapter.formatToolCall(cmdCall, "/repo");
  assert.equal(presentedCmd.kind, "command");
  assert.ok(presentedCmd.label.includes("npm test"));
  assert.equal(presentedCmd.status, "running");
  assert.equal(presentedCmd.hasDetails, true);

  // 2. 文件工具
  const fileCall = {
    type: "tool_call",
    tool: "read_file",
    input: { path: "package.json" },
    status: "running",
  };
  const presentedFile = adapter.formatToolCall(fileCall, "/repo");
  assert.equal(presentedFile.kind, "file");
  assert.ok(presentedFile.label.includes("package.json"));
  assert.equal(presentedFile.status, "running");
  assert.equal(presentedFile.readOnly, true);
  assert.match(presentedFile.label, /读取文件/);

  // 3. 状态更新
  const update = adapter.formatToolUpdate({ status: "completed", output: "file contents..." }, presentedFile);
  assert.equal(update.status, "completed");
  assert.equal(update.details.output, "file contents...");
});
