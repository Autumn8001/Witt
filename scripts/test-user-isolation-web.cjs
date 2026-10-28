"use strict";
// Run against a separate loopback test server and auth database, never customers.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { AuthService } = require("../backend/auth-service");
const { antigravityIsolation } = require("../backend/runtime/antigravity-isolation");
const root = process.env.CHLOE_SECURITY_TEST_DIR;
if (!root || !root.startsWith("/root/chloe-identity-validation/")) throw Error("TEST_DIRECTORY_REQUIRED");
const tokenFile = path.join(root, "test-identities.json");
if (process.argv.includes("--seed")) {
  const auth = new AuthService({ dir: path.join(root, "auth") });
  const adminInvite = auth.initialize(crypto.randomBytes(24).toString("hex"));
  const entries = {};
  for (const role of ["a", "b", "admin"]) {
    const invite = role === "admin" ? adminInvite : auth.createInvite({ label: "Security test " + role });
    entries[role] = auth.activate({ inviteCode: invite.code, deviceId: crypto.randomUUID(), deviceName: "Synthetic test " + role });
  }
  fs.writeFileSync(tokenFile, JSON.stringify(entries), { mode: 0o600 });
  process.exit(0);
}
const accounts = JSON.parse(fs.readFileSync(tokenFile));
const base = process.env.CHLOE_SECURITY_TEST_URL;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw Error("LOOPBACK_TEST_SERVER_REQUIRED");
async function api(role, method, route, body) {
  const response = await fetch(base + route, { method, headers: {
    Authorization: "Bearer " + accounts[role].token, "Content-Type": "application/json",
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
}
async function create(role, model="gemini-3.8-flash-high", accessMode="workspace-write") {
  const response = await api(role, "POST", "/chat/conversations", { model, accessMode, title: "Isolation test" });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.conversation;
}
async function turn(role, conversation, text) {
  const sent = await api(role, "POST", `/chat/conversations/${conversation.id}/messages`, { text });
  assert.ok(sent.status >= 200 && sent.status < 300, JSON.stringify(sent.body));
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const state = await api(role, "GET", `/chat/conversations/${conversation.id}/messages`);
    const message = state.body.conversation?.messages?.filter(m => m.role === "assistant").at(-1);
    if (message && ["completed","failed","interrupted"].includes(message.status)) return message;
  }
  throw Error("Harness test turn timed out");
}
(async () => {
  if (process.argv.includes("--admin-only")) {
    const canary = path.join(root, "admin-canary.txt");
    fs.writeFileSync(canary, "ADMIN_FULL_ACCESS_OK", { mode: 0o600 });
    const conversation = await create("admin", "gemini-3.8-flash-high", "danger-full-access");
    const reply = await turn("admin", conversation, `读取 ${canary}，返回其中的文本。不修改任何文件，不读取其他文件。`);
    const result = { admin_root_file_read: reply.status === "completed" && /ADMIN_FULL_ACCESS_OK/.test(reply.text), status: reply.status };
    fs.writeFileSync(path.join(root, "admin-e2e-results.json"), JSON.stringify(result,null,2));
    console.log(JSON.stringify(result));
    process.exitCode = result.admin_root_file_read ? 0 : 1;
    return;
  }
  const results = {};
  const a = await create("a");
  const b = await create("b");
  const prohibited = await api("a", "POST", "/chat/conversations", { model: "gemini-3.8-flash-high", accessMode: "danger-full-access" });
  results.customer_full_access_denied = prohibited.status === 400;
  results.other_user_conversation_denied = (await api("a", "GET", `/chat/conversations/${b.id}/messages`)).status === 404;
  results.admin_full_access_preserved = (await create("admin", "gemini-3.8-flash-high", "danger-full-access")).accessMode === "danger-full-access";
  const identity = await turn("a", a, "你是谁？请只用一句话回答，不要调用工具。");
  results.gemini_identity = identity.status === "completed" && /Chloe/i.test(identity.text);
  const workspace = antigravityIsolation(accounts.a.device.userId).workspace;
  const readme = path.join(workspace, "README.md");
  // Prepare synthetic input as root, preserving the DynamicUser ownership.
  const owner = fs.statSync(workspace);
  fs.writeFileSync(readme, "# Synthetic security test\nRead and edit only this test project.\n");
  fs.chownSync(readme, owner.uid, owner.gid);
  const editing = await turn("a", a, "读取当前项目的 README.md，然后创建 isolation-test.txt，内容为 ISOLATION_OK。只修改这个测试文件，不运行命令。");
  const output = path.join(workspace, "isolation-test.txt");
  results.gemini_workspace_write = editing.status === "completed" && fs.existsSync(output) && fs.readFileSync(output,"utf8").includes("ISOLATION_OK");
  const grok = await create("b", "grok-4.7-high");
  const grokReply = await turn("b", grok, "你好。只回答一句话，不调用工具。");
  results.grok_scoped_smoke = grokReply.status === "completed" && Boolean(grokReply.text);
  const report = { results, all_pass: Object.values(results).every(Boolean),
    identity_reply: identity.text, edit_status: editing.status, edit_reply: editing.text,
    grok_status: grokReply.status };
  fs.writeFileSync(path.join(root, "http-e2e-results.json"), JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
  process.exitCode = report.all_pass ? 0 : 1;
})().catch(error => { console.error(error.message); process.exitCode=1; });
