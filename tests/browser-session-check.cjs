"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { AuthService } = require("../backend/auth-service");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "witt-browser-session-"));
const authDir = path.join(root, "auth");
const tokenFile = path.join(root, "legacy-token");
fs.writeFileSync(tokenFile, "test-legacy-token\n", { mode: 0o600 });
const auth = new AuthService({ dir: authDir, sendJson() {}, readJsonBody() {} });
const invite = auth.initialize("correct horse battery staple", "owner");
const port = 32000 + Math.floor(Math.random() * 1000);
const origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [path.join(__dirname, "../backend/server.js")], {
  stdio: ["ignore", "ignore", "pipe"],
  env: {
    ...process.env,
    DROP_VAULT_PORT: String(port),
    DROP_VAULT_AUTH_DIR: authDir,
    DROP_VAULT_DATA_DIR: path.join(root, "files"),
    DROP_VAULT_TASK_DIR: path.join(root, "tasks"),
    DROP_VAULT_CHAT_DIR: path.join(root, "chat"),
    DROP_VAULT_IMAGE_DIR: path.join(root, "images"),
    DROP_VAULT_USERS_DIR: path.join(root, "users"),
    DROP_VAULT_TOKEN_FILE: tokenFile,
  },
});
let startupError = "";
child.stderr.on("data", (chunk) => { startupError += chunk.toString(); });

async function waitForServer() {
  for (let index = 0; index < 50; index += 1) {
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`test server did not start: ${startupError}`);
}

(async () => {
  try {
    await waitForServer();
    const activation = await fetch(`${origin}/auth/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Witt-Client": "browser" },
      body: JSON.stringify({
        inviteCode: invite.code,
        deviceId: "33333333-3333-4333-8333-333333333333",
        deviceName: "Browser test",
      }),
    });
    const activationBody = await activation.json();
    const setCookie = activation.headers.get("set-cookie") || "";
    if (activation.status !== 201 || activationBody.token || !setCookie.includes("HttpOnly")) {
      throw new Error("browser activation response is not secure");
    }
    const cookie = setCookie.split(";", 1)[0];
    const status = await fetch(`${origin}/auth/status`, { headers: { Cookie: cookie } });
    const statusBody = await status.json();
    if (!statusBody.authenticated || !statusBody.principal?.admin) {
      throw new Error("browser cookie did not authenticate");
    }
    const rejected = await fetch(`${origin}/admin/invites`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ label: "rejected" }),
    });
    if (rejected.status !== 403) throw new Error("cross-origin protection was not enforced");
    const accepted = await fetch(`${origin}/admin/invites`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ label: "accepted" }),
    });
    if (accepted.status !== 201) throw new Error("same-origin browser request was rejected");
    const memberInvite = (await accepted.json()).invite;
    const memberActivation = await fetch(`${origin}/auth/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Witt-Client": "browser" },
      body: JSON.stringify({ inviteCode: memberInvite.code,
        deviceId: "44444444-4444-4444-8444-444444444444", deviceName: "Invited member" }),
    });
    if (memberActivation.status !== 201) throw new Error("member activation failed");
    const memberCookie = (memberActivation.headers.get("set-cookie") || "").split(";", 1)[0];
    const memberHeaders = { Cookie: memberCookie, Origin: origin, "Content-Type": "application/json" };
    const memberStatus = await fetch(`${origin}/auth/status`, { headers: memberHeaders });
    const memberPrincipal = (await memberStatus.json()).principal;
    if (!memberPrincipal || memberPrincipal.admin || memberPrincipal.unrestrictedModels) {
      throw new Error("test member unexpectedly has elevated privileges");
    }
    const created = await fetch(`${origin}/chat/conversations`, {
      method: "POST", headers: memberHeaders, body: JSON.stringify({ model: "gemini-3.8-flash-high" }),
    });
    if (created.status !== 201) throw new Error("invited user cannot create a conversation");
    const conversation = (await created.json()).conversation;
    if (conversation.contextUsage?.usedTokens === 1 && conversation.contextUsage?.contextWindow === 1) {
      throw new Error("invited user received fabricated exhausted quota");
    }
    // Empty input reaches normal validation without invoking a real model.
    const message = await fetch(`${origin}/chat/conversations/${conversation.id}/messages`, {
      method: "POST", headers: memberHeaders, body: JSON.stringify({ text: "" }),
    });
    if (message.status !== 400 || (await message.json()).error !== "请输入消息或添加附件") {
      throw new Error("invited user was blocked before normal message validation");
    }
    const memberAdmin = await fetch(`${origin}/admin/devices`, { headers: memberHeaders });
    if (memberAdmin.ok) throw new Error("invited user gained administrator access");
    console.log("browser session checks passed");
  } finally {
    child.kill("SIGTERM");
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
