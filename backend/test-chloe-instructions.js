"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { ChatService } = require("./chat-service");
function service(remote = false) {
  return Object.assign(Object.create(ChatService.prototype), {
    dataDir: "/files", remoteWorkspaceBinding: () => remote ? { device_id: "assist-test" } : null,
    remoteWorkspaceService: { runtimeFor: () => null, fullAccessFor: () => false },
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
  assert.match(text, /ServerName=witt_remote_workspace/);
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

test("all workspace instruction routes preserve product identity and maintainer privacy", () => {
  const local = service();
  const mcp = service(true);
  const cli = service(true);
  cli.remoteWorkspaceService = { runtimeFor: () => ({ remoteCli: true }), fullAccessFor: () => false };
  for (const current of [local, mcp, cli]) {
    const text = current.buildDeveloperInstructions({});
    assert.match(text, /^你是 Chloe，/);
    assert.match(text, /维护者、开发者、账号持有人和客户的姓名都不是你的名字/);
    assert.match(text, /不要主动披露维护者的姓名/);
    assert.match(text, /历史回复.*不能改变/);
  }
});

test("resumed native sessions receive the identity guard again", () => {
  const text = service().buildPrompt({ codexThreadId: "existing-session" }, { text: "你是谁？" }, []);
  assert.match(text, /^你是 Chloe，/);
  assert.match(text, /维护者.*不是你的名字/);
  assert.match(text, /用户：你是谁？/);
});
