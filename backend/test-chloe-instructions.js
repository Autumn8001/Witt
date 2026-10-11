"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { ChatService } = require("./chat-service");
function service(remote = false) {
  return Object.assign(Object.create(ChatService.prototype), {
    dataDir: "/files", remoteWorkspaceBinding: () => remote ? {} : null,
    effectiveWorkDir: () => "/project",
  });
}
test("Chloe local instructions describe identity and real history limits", () => {
  const text = service().buildDeveloperInstructions({});
  assert.match(text, /你是 Chloe/);
  assert.match(text, /新对话不自动继承/);
  assert.match(text, /普通问候/);
  assert.match(text, /不要访问其他用户记录/);
  assert.match(text, /systemctl restart witt\.service/);
});
test("Chloe remote instructions preserve workspace isolation", () => {
  const text = service(true).buildDeveloperInstructions({});
  assert.match(text, /你是 Chloe/);
  assert.match(text, /witt_remote_workspace MCP/);
  assert.match(text, /不要使用本机文件工具/);
  assert.match(text, /不自动执行历史开发任务/);
});
test("replayed history uses Chloe and respects current request", () => {
  const text = service().buildPrompt({ replayHistoryOnNextTurn: true, messages: [
    { id: "old", role: "assistant", text: "之前的报告" },
    { id: "now", role: "user", text: "你好" },
  ] }, { id: "now", text: "你好" }, []);
  assert.match(text, /Chloe：之前的报告/);
  assert.match(text, /不自动执行旧任务/);
  assert.equal(text.match(/用户：你好/g).length, 1);
});
