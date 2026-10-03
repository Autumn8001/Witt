import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const androidSource = readFileSync(
  new URL("../android/app/src/main/java/com/codevibe/dropvault/MainActivity.java", import.meta.url),
  "utf8",
);
const sshProfileSource = readFileSync(
  new URL("../android/app/src/main/java/com/codevibe/dropvault/LocalSshProfileStore.java", import.meta.url),
  "utf8",
);
const localSshManagerSource = readFileSync(
  new URL("../android/app/src/main/java/com/codevibe/dropvault/LocalSshManager.java", import.meta.url),
  "utf8",
);
const androidManifest = readFileSync(
  new URL("../android/app/src/main/AndroidManifest.xml", import.meta.url), "utf8",
);
if (!sshProfileSource.includes('KeyStore.getInstance("AndroidKeyStore")') ||
    !sshProfileSource.includes('Cipher.getInstance("AES/GCM/NoPadding")') ||
    !sshProfileSource.includes("cipher.updateAAD")) {
  throw new Error("Saved SSH passwords are not protected by an authenticated Android Keystore envelope");
}
if (!androidManifest.includes('android:windowSoftInputMode="adjustResize"')) {
  throw new Error("Android terminal is not configured to follow the software keyboard");
}
if (!localSshManagerSource.includes("newSingleThreadExecutor()")) {
  throw new Error("Android terminal input is not serialized for interactive programs");
}
if (!localSshManagerSource.includes("ScheduledExecutorService") ||
    !localSshManagerSource.includes("scheduleReconnect()") ||
    !localSshManagerSource.includes("RECONNECT_DELAYS_SECONDS")) {
  throw new Error("Android terminal does not automatically recover saved SSH sessions");
}
if (!androidSource.includes('openApiConnection("chat/usage/reset" + suffix, "POST")') ||
    !androidSource.includes('webBridge.consumeRateLimitReset(args.optString(0))')) {
  throw new Error("Android quota reset is not connected to the chat usage reset route");
}
const backendSource = readFileSync(new URL("../backend/server.js", import.meta.url), "utf8");
const chatServiceSource = readFileSync(new URL("../backend/chat-service.js", import.meta.url), "utf8");
if (!backendSource.includes('url.pathname === "/usage/reset"') ||
    !backendSource.includes('url.pathname = "/chat/usage/reset"')) {
  throw new Error("Backend does not preserve the legacy quota reset route");
}
if (!chatServiceSource.includes('this.consumeRateLimitReset(res, url.searchParams.get("conversationId"))') ||
    !chatServiceSource.includes("codexHome: profile.codexHome") ||
    !chatServiceSource.includes("conversationId || this.lastUsageConversationId") ||
    !chatServiceSource.includes("this.usageCache.delete(profile.id)")) {
  throw new Error("Backend quota reset is not scoped to the active conversation account");
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
const cdpSession = await page.context().newCDPSession(page);
await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
  origin: "https://wit.test",
});
const errors = [];
page.on("console", (message) => {
  if (message.type() === "error") errors.push(`${message.text()} @${message.location().url || "unknown"}`);
});
page.on("pageerror", (error) => errors.push(error.message));

const now = new Date().toISOString();
const startedAt = new Date(Date.now() - 83_000).toISOString();
// Keep the global approval sheet closed during unrelated navigation checks.
// The pending state is exercised later in the dedicated mobile approval section.

const conversation = {
  id: "00000000-0000-4000-8000-000000000001",
  title: "年报项目检查",
  createdAt: now,
  updatedAt: now,
  busy: false,
  model: "gpt-5.6-sol",
  reasoning: "medium",
  accessMode: "danger-full-access",
  workDir: "",
  contextUsage: { usedTokens: 64500, contextWindow: 128000, updatedAt: now },
  messages: [
    {
      id: "u1", role: "user",
      text: "帮我检查年报项目目前的状态，并逐项说明服务、构建、测试、交付、日志和风险。".repeat(32),
      attachments: [], createdAt: startedAt, startedAt, completedAt: now, status: "completed",
    },
    {
      id: "a1", role: "assistant", text: "项目运行正常。查看 [Witt 项目](https://github.com/LeoWilson-Ben/witt)，或访问 https://example.com/docs。",
      attachments: [], createdAt: startedAt, startedAt, completedAt: now, status: "completed",
      activity: [{ type: "done", label: "处理完成", status: "completed" }],
      stream: [
        { id: "s1", kind: "message", phase: "commentary", text: "我先检查服务状态和项目文件。", status: "completed" },
        { id: "s2", kind: "command", label: "检查后端服务", status: "completed", hasDetails: true },
        { id: "turn-git-changes", kind: "file", label: "本轮修改 3 个文件", status: "completed", count: 3, hasDetails: true },
        {
          id: "s-image", kind: "image",
          imageId: "11111111-1111-4111-8111-111111111111",
          name: "执行截图.png", mimeType: "image/png", status: "completed",
        },
        {
          id: "approval-test", kind: "approval",
          approvalId: "33333333-3333-4333-8333-333333333333",
          approvalType: "command", status: "pending",
          title: "允许执行这条命令？",
          reason: "需要检查服务是否正在运行",
          command: `/bin/bash -lc "rm -rf -- ${[
            "dcb6d1181816d968f4f7d43d676a02a494eed889",
            "4648344871965d9f4465092ac442cf651d9ae5c9",
            "bb309a5ec7c6811351c871870a0d61797e6feedb",
          ].map((release) => `/data/builds/releases/${release}`).join(" ")}"`,
          cwd: "/data/drop-vault",
          approvalOptions: [
            { id: "choice-1", label: "允许一次", description: "仅批准当前这项操作", tone: "accepted" },
            { id: "choice-2", label: "在本会话中允许", description: "相同操作不再询问", tone: "accepted" },
            { id: "choice-3", label: "拒绝并继续", description: "让 Codex 尝试其他做法", tone: "declined" },
            { id: "choice-4", label: "拒绝并停止本轮", description: "立即停止当前任务", tone: "declined" },
          ],
        },
        { id: "s4", kind: "message", phase: "final_answer", text: "项目运行正常。查看 [Witt 项目](https://github.com/LeoWilson-Ben/witt)，或访问 https://example.com/docs。\n\n| 项目 | 状态 | 数量 |\n| :--- | :---: | ---: |\n| API | 正常 | 3 |\n| 构建 | `通过` | 12 |\n\n行内公式 $E=mc^2$。\n\n$$\\int_0^1 x^2 dx = \\frac{1}{3}$$\n\n```javascript\nconst answer = 42;\n```", status: "completed" },
      ],
      images: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          name: "执行截图.png", size: 68, mimeType: "image/png",
          source: "execution", createdAt: now,
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          name: "交付预览.png", size: 68, mimeType: "image/png",
          source: "delivery", artifactId: "00000000-0000-4000-8000-000000000098",
          createdAt: now,
        },
      ],
      artifacts: [{
        id: "00000000-0000-4000-8000-000000000099",
        name: "年报交付.xlsx",
        size: 8192,
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }, {
        id: "00000000-0000-4000-8000-000000000098",
        name: "交付预览.png",
        size: 68,
        mimeType: "image/png",
      }, {
        id: "00000000-0000-4000-8000-000000000097",
        name: "任务流程.html",
        size: 256,
        mimeType: "text/html",
        previewToken: "artifact-preview-test-token-000001",
      }],
    },
  ],
};

const initialCommandApproval = conversation.messages[1].stream.find((entry) => entry.kind === "approval");
initialCommandApproval.status = "accepted";

const installBridge = ({ conversation, now }) => {
  const createConversation = (model, reasoning, accessMode, workDir = "",
      codexProfile = "default") => {
    window.__createdConversationArgs = { model, reasoning, accessMode, workDir, codexProfile };
    Object.assign(conversation, {
      id: "00000000-0000-4000-8000-000000000002",
      title: "新对话",
      model,
      reasoning,
      accessMode,
      workDir,
      codexProfile,
      messages: [],
      busy: false,
    });
    setTimeout(() => window.DropVault?.onConversationCreated(JSON.stringify({ conversation })), 80);
  };
  window.DropVaultAndroid = {
    requestAuthStatus() {
      setTimeout(() => window.DropVault?.onAuthStatus(JSON.stringify({
        initialized: true, authenticated: true, principal: { admin: true, label: "测试设备" },
      })), 10);
    },
    getImageAccessToken() { return "test-device-token"; },
    getCacheScope() { return "0123456789abcdef0123456789abcdef"; },
    hasBundledLumoraMedia() { return false; },
    contentReady(mode) { window.__contentReadyMode = mode; },
    requestConversations() {
      window.__conversationRequestCount = (window.__conversationRequestCount || 0) + 1;
      setTimeout(() => window.DropVault?.onConversations(JSON.stringify({
        conversations: [{
          id: conversation.id, title: conversation.title, updatedAt: now,
          lastMessage: conversation.messages.at(-1)?.text || "",
          busy: conversation.messages.some((message) =>
            message.role === "assistant" &&
            (message.status === "queued" || message.status === "running")),
        }, ...Array.from({ length: 18 }, (_, index) => ({
          id: `00000000-0000-4000-9000-${String(index + 10).padStart(12, "0")}`,
          title: `历史对话 ${index + 1}`,
          updatedAt: new Date(Date.parse(now) - (index + 1) * 3600000).toISOString(),
          lastMessage: `这是第 ${index + 1} 条历史记录的摘要`,
          busy: false,
        }))],
      })), 30);
    },
    requestCapabilities() {
      setTimeout(() => window.DropVault?.onCapabilities(JSON.stringify({
        models: [
          { id: "gpt-5.6-sol", displayName: "GPT-5.6-Sol", reasoningEfforts: [
            { id: "low" }, { id: "medium" }, { id: "high" }, { id: "xhigh" },
          ] },
          { id: "gpt-5.6-terra", displayName: "GPT-5.6-Terra", reasoningEfforts: [
            { id: "low" }, { id: "medium" }, { id: "high" }, { id: "xhigh" },
            { id: "max" }, { id: "ultra" },
          ] },
          { id: "gpt-5.6-luna", displayName: "GPT-5.6-Luna", reasoningEfforts: [
            { id: "low" }, { id: "medium" }, { id: "high" },
          ] },
        ],
        skills: [{ name: "imagegen", enabled: true }],
        mcpServers: [{ name: "openaiDeveloperDocs", status: "ready" }],
        features: [{ name: "multi_agent", enabled: true }],
      })), 10);
    },
    requestLocalSshStatus() {
      setTimeout(() => window.DropVault?.onLocalSshStatus(JSON.stringify({
        connected: false, connecting: false,
      })), 10);
    },
    requestLocalSshProfiles() {
      window.__sshProfiles ||= [];
      setTimeout(() => window.DropVault?.onLocalSshProfiles(JSON.stringify({
        profiles: window.__sshProfiles,
      })), 10);
    },
    saveAndConnectLocalSsh(label, host, username, port, password) {
      window.__localSshSave = { label, host, username, port, password };
      const profile = {
        id: "55555555-5555-4555-8555-555555555555",
        label: label || host, host, username, port, updatedAt: Date.now(),
      };
      window.__sshProfiles = [profile];
      setTimeout(() => {
        window.DropVault?.onLocalSshProfiles(JSON.stringify({ profiles: window.__sshProfiles }));
        window.DropVault?.onLocalSshConnected(JSON.stringify({
          connected: true, connecting: false, profileId: profile.id,
          host, username, port, connectedAt: Date.now(),
        }));
        window.DropVault?.onLocalSshOutput("Open https://example.com/oauth/authorize?response_type=code&client_id=witt-terminal-test&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid%20profile%20email%20offline_access&code_challenge=abcdefghijklmnopqrstuvwxyz0123456789\r\nroot@test:~# ");
      }, 20);
    },
    connectSavedLocalSsh(profileId) {
      window.__savedSshConnect = profileId;
      const profile = window.__sshProfiles.find((item) => item.id === profileId);
      setTimeout(() => window.DropVault?.onLocalSshConnected(JSON.stringify({
        connected: true, connecting: false, profileId,
        host: profile.host, username: profile.username, port: profile.port,
        connectedAt: Date.now(),
      })), 20);
    },
    deleteSavedLocalSsh(profileId) {
      window.__sshProfiles = window.__sshProfiles.filter((item) => item.id !== profileId);
      setTimeout(() => window.DropVault?.onLocalSshProfiles(JSON.stringify({
        profiles: window.__sshProfiles,
      })), 10);
    },
    connectLocalSsh(host, username, port, password) {
      window.__localSshConnect = { host, username, port, password };
      setTimeout(() => {
        window.DropVault?.onLocalSshConnected(JSON.stringify({
          connected: true, connecting: false, host, username, port,
          connectedAt: Date.now(),
        }));
        window.DropVault?.onLocalSshOutput("root@test:~# ");
      }, 20);
    },
    sendLocalSshInput(input) {
      window.__localSshInput = input;
      window.__localSshInputs = [...(window.__localSshInputs || []), input];
      setTimeout(() => window.DropVault?.onLocalSshOutput(`${input}ok\nroot@test:~# `), 10);
    },
    disconnectLocalSsh() {
      window.__localSshDisconnected = true;
      setTimeout(() => window.DropVault?.onLocalSshDisconnected(), 10);
    },
    requestLocalSftp(path) {
      window.__localSftpPath = path;
      setTimeout(() => window.DropVault?.onLocalSftpList(JSON.stringify({
        path: path === "." ? "/root" : path,
        entries: [
          { name: "projects", directory: true, size: 0, modifiedAt: Date.now() },
          { name: "notes.txt", directory: false, size: 128, modifiedAt: Date.now() },
        ],
      })), 10);
    },
    pickLocalSftpUpload(path) { window.__localSftpUploadPath = path; },
    downloadLocalSftp(path, name) { window.__localSftpDownload = { path, name }; },
    requestConversation(id) {
      window.__requestedConversationId = id;
      setTimeout(() => window.DropVault?.onConversation(JSON.stringify({ conversation })), 30);
    },
    requestConversationDelta() {
      window.__deltaRequestCount = (window.__deltaRequestCount || 0) + 1;
      const replaceFrom = Math.max(0, conversation.messages.findLastIndex(
        (message) => message.role === "assistant"));
      const metadata = { ...conversation };
      delete metadata.messages;
      setTimeout(() => window.DropVault?.onConversationDelta(JSON.stringify({
        conversation: metadata,
        replaceFrom,
        totalMessages: conversation.messages.length,
        messages: conversation.messages.slice(replaceFrom),
      })), 30);
    },
    requestCodexAccounts() {
      setTimeout(() => window.DropVault?.onCodexAccounts(JSON.stringify({
        accounts: [
          { id: "default", label: "Witt 默认账号", authenticated: true,
            account: { type: "chatgpt", planType: "plus" } },
          { id: "xuanyu", label: "子账号",
            authenticated: Boolean(window.__xuanyuAuthenticated),
            account: window.__xuanyuAuthenticated
              ? { type: "chatgpt", planType: "plus" } : null },
        ],
      })), 20);
    },
    requestStreamDetail(id, messageId, entryId) {
      const entry = entryId === "s2"
        ? {
            id: entryId, kind: "command", status: "failed",
            details: {
              command: "systemctl is-active drop-vault.service",
              cwd: "/data/drop-vault", exitCode: 7, durationMs: 240,
              output: "test output", error: "测试命令返回失败",
            },
          }
        : {
            id: entryId, kind: "file", status: "completed",
            details: {
              branch: "platform/personal-ai-ops",
              changes: [
                { path: "web/app.js", kind: "update", diff: "@@ changed UI", bytes: 120, afterHash: "aa11" },
                { path: "web/new.js", kind: "untracked", diff: "+new text", untracked: true, bytes: 28, afterHash: "bb22" },
                { path: "web/new-name.js", oldPath: "web/old-name.js", kind: "rename", diff: "@@ renamed", afterHash: "cc33" },
                { path: "assets/image.bin", kind: "add", binary: true, bytes: 8192, afterHash: "dd44" },
                { path: "assets/bundle.js", kind: "update", large: true, truncated: true, bytes: 5242880, diff: "@@ partial", afterHash: "ee55" },
              ],
            },
          };
      setTimeout(() => window.DropVault?.onStreamDetail(JSON.stringify({ entry })), 20);
    },
    startDevelopmentWorkflow(conversationId, messageId, commitMessage) {
      window.__developmentWorkflowRequest = { conversationId, messageId, commitMessage };
      setTimeout(() => window.DropVault?.onDevelopmentWorkflow(JSON.stringify({
        job: {
          id: "00000000-0000-4000-8000-000000000099",
          conversationId, messageId, status: "running", stage: "testing",
          message: "正在运行测试",
        },
      })), 20);
    },
    confirmDevelopmentCommit(jobId, commitMessage) {
      window.__developmentCommitRequest = { jobId, commitMessage };
    },
    confirmDevelopmentDeploy(jobId) {
      window.__developmentDeployRequest = { jobId };
    },
    requestUsage() {
      setTimeout(() => window.DropVault?.onUsage(JSON.stringify({
        summary: {
          lifetimeTokens: 1234567,
          peakDailyTokens: 88000,
          currentStreakDays: 4,
          longestStreakDays: 11,
          longestRunningTurnSec: 120,
        },
        dailyUsageBuckets: [
          { startDate: new Date().toISOString().slice(0, 10), tokens: 88000 },
        ],
        rateLimits: {
          planType: "plus",
          primary: { usedPercent: 4, windowDurationMins: 10080, resetsAt: 1785300000 },
          resetCredits: 1,
        },
        context: conversation.contextUsage,
      })), 20);
    },
    consumeRateLimitReset(conversationId) {
      window.__resetAttempt = true;
      window.__resetConversationId = conversationId;
    },
    createConversation(model, reasoning, accessMode) {
      createConversation(model, reasoning, accessMode);
    },
    createConversationWithPath(model, reasoning, accessMode, workDir) {
      createConversation(model, reasoning, accessMode, workDir);
    },
    createConversationWithProfile(model, reasoning, accessMode, workDir, codexProfile) {
      createConversation(model, reasoning, accessMode, workDir, codexProfile);
    },
    pickFiles() {
      setTimeout(() => window.DropVault?.onFilesPicked(JSON.stringify([
        { id: "local-one", name: "道路数据.xlsx", size: 283040, type: "application/vnd.ms-excel" },
      ])), 20);
    },
    uploadFile(id) {
      setTimeout(() => window.DropVault?.onUploadProgress(id, 64), 20);
      setTimeout(() => window.DropVault?.onUploadFinished(id, true, "", JSON.stringify({
        file: { id: "1785000000000-00000000-0000-4000-8000-000000000001" },
      })), 50);
    },
    sendChatMessage(id, text) {
      const runningAssistant = conversation.messages.find((message) =>
        message.role === "assistant" && message.status === "running");
      if (runningAssistant) {
        conversation.messages.push({
          id: "u3", role: "user", text, attachments: [], createdAt: now,
          status: "running", steeredInto: runningAssistant.id,
          steerAtStreamIndex: (runningAssistant.stream || []).length,
        });
        setTimeout(() => {
          runningAssistant.stream = [...(runningAssistant.stream || []), {
            id: "after-steer",
            kind: "message",
            phase: "commentary",
            text: "我接着补充要求继续检查。",
            status: "running",
            createdAt: new Date(Date.now() + 1000).toISOString(),
          }];
          window.DropVault?.onConversation(JSON.stringify({ conversation }));
        }, 80);
      } else {
        conversation.messages.push(
          { id: "u2", role: "user", text, attachments: [], createdAt: now, status: "running" },
          { id: "a2", role: "assistant", text: "", attachments: [], createdAt: now, status: "running",
            activity: [{ type: "thinking", label: "正在理解并处理你的要求", status: "running" }] },
        );
      }
      setTimeout(() => window.DropVault?.onMessageSent(JSON.stringify({ conversation })), 120);
    },
    interruptConversation(id) {
      window.__interruptedConversationId = id;
      setTimeout(() => window.DropVault?.onConversationInterruptRequested(
        JSON.stringify({ ok: true, conversation })), 20);
      setTimeout(() => {
        for (const message of conversation.messages) {
          if (message.role === "user" && message.status === "running") message.status = "completed";
          if (message.role === "assistant" && message.status === "running") {
            message.status = "interrupted";
            message.text = "已暂停本轮执行。";
          }
        }
        conversation.busy = false;
        window.DropVault?.onConversation(JSON.stringify({ conversation }));
      }, 80);
    },
    updateConversationSettings(id, model, reasoning, accessMode) {
      conversation.model = model;
      conversation.reasoning = reasoning;
      conversation.accessMode = accessMode;
      setTimeout(() => window.DropVault?.onSettingsUpdated(JSON.stringify({ conversation })), 20);
    },
    updateConversationProject(id, workDir) {
      conversation.workDir = workDir;
      window.__updatedProject = workDir;
      setTimeout(() => window.DropVault?.onConversationProjectUpdated(
        JSON.stringify({ conversation })), 20);
    },
    resolveApproval(id, approvalId, choiceId) {
      window.__resolvedApproval = { id, approvalId, choiceId };
      const approval = conversation.messages.flatMap((message) => message.stream || [])
        .find((entry) => entry.approvalId === approvalId);
      const selected = approval?.approvalOptions.find((option) => option.id === choiceId);
      if (approval && selected) {
        approval.status = selected.tone || "accepted";
        approval.resolutionLabel = selected.label || "已处理";
      } else if (approval && choiceId.startsWith("{")) {
        approval.status = "accepted";
        approval.resolutionLabel = "已提交连接器选择";
      }
      setTimeout(() => window.DropVault?.onApprovalResolved(JSON.stringify({
        ok: true, conversation,
      })), 20);
    },
    downloadArtifact(id, messageId, artifactId, name) {
      window.__downloadedArtifact = { id, messageId, artifactId, name };
    },
    downloadImage(url, name, mimeType) {
      window.__downloadedImage = { url, name, mimeType };
    },
    archiveConversation() {},
    checkForUpdates() {},
    getVersion() { return "2.2.16"; },
  };
  window.WittNative = {
    postMessage(raw) {
      const message = JSON.parse(raw);
      window.DropVaultAndroid?.[message.method]?.(...(message.args || []));
    },
  };
};

const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const cssNames = ["styles.css", "quota.css", "quota-fix.css", "reset-glow.css", "composer-aura.css", "composer-refine.css", "composer-transparency.css", "composer-overlay.css", "composer-spectra.css", "quota-layout.css", "quota-header-restore.css", "quota-confirm.css", "quota-compact.css", "drawer-motion.css", "quota-profile-motion.css", "usage-insight.css", "quota-spacing.css", "usage-ring-fit.css", "auth-gate.css", "approval-card.css", "approval-dock.css", "night-contrast.css", "witt-white.css", "browser-chatgpt.css", "conversation-type.css", "night-theme.css", "message-collapse.css", "chat-overflow-fix.css", "codex-accounts.css", "formula-code.css", "performance.css", "landscape.css", "lumora-global.css", "codex-model-picker.css", "chat-links.css", "completed-turn.css", "drawer-layout.css", "witt-next.css", "artifact-preview.css", "claude-app.css", "local-terminal.css"];
const cssFiles = new Map(cssNames.map((name) => [
  name, readFileSync(new URL(`../web/${name}`, import.meta.url), "utf8"),
]));
const js = readFileSync(new URL("../web/app-workspace-20260916-r3.js", import.meta.url), "utf8");
const browserBridgeJs = readFileSync(new URL("../web/browser-bridge.js", import.meta.url), "utf8");
const katexJs = readFileSync(new URL("../web/vendor/katex/katex.min.js", import.meta.url), "utf8");
const katexCss = readFileSync(new URL("../web/vendor/katex/katex.min.css", import.meta.url), "utf8");
const xtermJs = readFileSync(new URL("../web/vendor/xterm/xterm.js", import.meta.url), "utf8");
const xtermFitJs = readFileSync(new URL("../web/vendor/xterm/addon-fit.js", import.meta.url), "utf8");
const xtermWebLinksJs = readFileSync(new URL("../web/vendor/xterm/addon-web-links.js", import.meta.url), "utf8");
const xtermCss = readFileSync(new URL("../web/vendor/xterm/xterm.css", import.meta.url), "utf8");
const icon = readFileSync(new URL("../web/icon.svg", import.meta.url), "utf8");
await page.route("**/vault/**", async (route) => {
  const pathname = new URL(route.request().url()).pathname;
  if (pathname.endsWith("version.json")) return route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ frontendSha: "abcdef0123456789abcdef0123456789abcdef01" }),
  });
  if (pathname.endsWith(".css")) {
    const name = pathname.split("/").pop();
    return route.fulfill({ contentType: "text/css", body: name === "katex.min.css" ? katexCss : (name === "xterm.css" ? xtermCss : (cssFiles.get(name) || "")) });
  }
  if (pathname.endsWith("xterm.js")) return route.fulfill({ contentType: "application/javascript", body: xtermJs });
  if (pathname.endsWith("addon-fit.js")) return route.fulfill({ contentType: "application/javascript", body: xtermFitJs });
  if (pathname.endsWith("addon-web-links.js")) return route.fulfill({ contentType: "application/javascript", body: xtermWebLinksJs });
  if (pathname.endsWith("browser-bridge.js")) return route.fulfill({ contentType: "application/javascript", body: browserBridgeJs });
  if (pathname.endsWith(".js")) return route.fulfill({ contentType: "application/javascript", body: pathname.endsWith("katex.min.js") ? katexJs : js });
  if (pathname.includes("/fonts/")) return route.fulfill({ status: 204 });
  if (pathname.endsWith(".svg")) return route.fulfill({ contentType: "image/svg+xml", body: icon });
  return route.fulfill({ contentType: "text/html", body: html });
});
await page.route("**/vault-api/version", (route) => route.fulfill({
  contentType: "application/json",
  body: JSON.stringify({ backendSha: "abcdef0123456789abcdef0123456789abcdef01" }),
}));
await page.route("**/vault-api/runtime/profiles", (route) => route.fulfill({
  contentType: "application/json",
  body: JSON.stringify({ profiles: [
    { id: "grok-main", name: "Grok Main", harness: "grok-build", model: "grok-4.7-high" },
  ] }),
}));
await page.route("**/vault-api/servers/overview", (route) => route.fulfill({
  contentType: "application/json",
  body: JSON.stringify({
    cpu: { count: 4 }, memory: { totalBytes: 1024, usedBytes: 512 },
    uptimeSeconds: 3600, http: [{ name: "Witt", status: "healthy" }],
    openWebuiUrl: "http://example.test:3000",
    checkedAt: now,
  }),
}));
await page.route("**/vault-api/chat-images/**", async (route) => {
  const image = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  return route.fulfill({ contentType: "image/png", body: image });
});
await page.route("**/vault-api/chat/artifact-previews/**", (route) =>
  route.fulfill({ contentType: "text/html", body: "<!doctype html><html><body><h1>Artifact ready</h1></body></html>" }));
await page.route("**/vault-api/chat/artifact-sources/**", (route) =>
  route.fulfill({ contentType: "text/html", body: "<!doctype html><html><body><h1>Artifact ready</h1></body></html>" }));
await page.route("**/*.mp4", (route) => route.fulfill({ status: 204 }));
await page.route("**/0b4a435b2df2747593c43d7a1c9b4578f7d8d90c.png",
  (route) => route.fulfill({ status: 204 }));
await page.route("https://fonts.googleapis.com/**", (route) =>
  route.fulfill({ contentType: "text/css", body: "" }));
await page.route("https://fonts.gstatic.com/**", (route) => route.fulfill({ status: 204 }));
await page.route("**/vault-api/chat/conversations/*/approvals/*", async (route) => {
  const body = route.request().postDataJSON();
  const approval = conversation.messages[1].stream.find((entry) => entry.kind === "approval");
  const selected = approval.approvalOptions.find((option) => option.id === body.choiceId);
  approval.status = selected?.tone || "accepted";
  approval.resolutionLabel = selected?.label || "已处理";
  return route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ ok: true, conversation }),
  });
});
await page.addInitScript(installBridge, { conversation, now });
await page.goto("https://wit.test/vault/", { waitUntil: "networkidle" });

await page.waitForTimeout(250);
await page.evaluate(() => window.DropVault.nativeReady({
  version: "2.2.16", cacheScope: "0123456789abcdef01234567",
}));
await page.waitForTimeout(180);
await page.evaluate(() => {
  const registerLinkProvider = window.Terminal.prototype.registerLinkProvider;
  window.Terminal.prototype.registerLinkProvider = function captureLinkProvider(provider) {
    window.__terminalLinkProvider = provider;
    window.__terminalForLinkTest = this;
    return registerLinkProvider.call(this, provider);
  };
});
const nativeRequestCount = await page.evaluate(() => window.__conversationRequestCount || 0);
if (nativeRequestCount !== 1) {
  throw new Error(`Native initialization request count was ${nativeRequestCount}: ${errors.join(" | ")}`);
}
if ((await page.locator(".message.assistant").count()) === 0) {
  const status = await page.evaluate(() => ({
    hasBridge: Boolean(window.DropVaultAndroid),
    hasApp: Boolean(window.DropVault),
    title: document.querySelector("#chatTitle")?.textContent,
  }));
  throw new Error(`Initial conversation did not render: ${JSON.stringify(status)} | ${errors.join(" | ")}`);
}
const artifactHandoff = page.locator(".message.assistant .artifact-handoff");
if ((await artifactHandoff.count()) !== 1) {
  throw new Error("HTML deliverable did not render as an Artifact handoff");
}
await artifactHandoff.click();
await page.waitForFunction(() => document.body.classList.contains("artifact-open"));
if (!(await page.locator("#artifactFrame").getAttribute("src"))?.includes("artifact-preview-test-token")) {
  throw new Error("Artifact workspace did not load the isolated preview URL");
}
await page.locator("#artifactCodeTab").click();
await page.waitForFunction(() => document.querySelector("#artifactCode code")?.textContent.includes("Artifact ready"));
await page.locator("#artifactClose").click();
await page.waitForFunction(() => !document.body.classList.contains("artifact-open"));
await page.locator("#menuButton").click();
await page.locator("#localSshButton").click();
await page.locator("#localSshSheet.open").waitFor();
await page.locator("#localSshConnectForm:not([hidden])").waitFor();
await page.locator("#localSshLabel").fill("测试服务器");
await page.locator("#localSshHost").fill("203.0.113.10");
await page.locator("#localSshPassword").fill("temporary-test-password");
await page.locator("#localSshConnectButton").click();
await page.locator("#localTerminal:not([hidden])").waitFor();
const localSshState = await page.evaluate(() => ({
  request: window.__localSshSave,
  passwordValue: document.querySelector("#localSshPassword")?.value,
  terminalTarget: document.querySelector("#localTerminalTarget")?.textContent,
}));
if (localSshState.request?.host !== "203.0.113.10" ||
    localSshState.request?.label !== "测试服务器" ||
    localSshState.request?.username !== "root" || localSshState.request?.port !== 22 ||
    localSshState.passwordValue !== "" ||
    localSshState.terminalTarget !== "root@203.0.113.10") {
  throw new Error(`Local SSH connection UI failed: ${JSON.stringify(localSshState)}`);
}
await page.waitForTimeout(80);
if (await page.locator("#copyLocalTerminal").count()) {
  throw new Error("Local SSH terminal still exposes the removed fixed copy button");
}
const parsedTerminalLinks = await page.evaluate(async () => {
  const provider = window.__terminalLinkProvider;
  const terminal = window.__terminalForLinkTest;
  if (!provider || !terminal) return [];
  await new Promise((resolve) => terminal.write("", resolve));
  const links = [];
  for (let row = 1; row <= terminal.buffer.active.length; row += 1) {
    await new Promise((resolve) => provider.provideLinks(row, (items) => {
      for (const item of items || []) links.push(item.text);
      resolve();
    }));
  }
  return [...new Set(links)];
});
const expectedWrappedLink = "https://example.com/oauth/authorize?response_type=code&client_id=witt-terminal-test&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid%20profile%20email%20offline_access&code_challenge=abcdefghijklmnopqrstuvwxyz0123456789";
if (!parsedTerminalLinks.includes(expectedWrappedLink)) {
  throw new Error(`Wrapped terminal URL was not parsed intact: ${JSON.stringify(parsedTerminalLinks)}`);
}
await page.locator("#localTerminalOutput").dispatchEvent("contextmenu", {
  bubbles: true, cancelable: true, clientX: 80, clientY: 160, button: 2,
});
const terminalContextDebug = await page.evaluate(() => {
  const output = document.querySelector("#localTerminalOutput");
  const menu = document.querySelector("#localTerminalContext");
  return {
    ready: output?.dataset.contextMenuReady,
    hidden: menu?.hidden,
    parent: menu?.parentElement?.tagName,
    display: menu ? getComputedStyle(menu).display : "missing",
    selection: window.__terminalForLinkTest?.getSelection(),
  };
});
if (terminalContextDebug.hidden) {
  throw new Error(`Local SSH context menu did not open: ${JSON.stringify(terminalContextDebug)} | ${errors.join(" | ")}`);
}
await page.locator("#localTerminalContext:not([hidden])").waitFor();
await page.locator("[data-terminal-context='select-all']").click();
await page.locator("[data-terminal-context='copy']").click();
const copiedTerminal = await page.evaluate(() => navigator.clipboard.readText());
if (!copiedTerminal.includes(expectedWrappedLink)) {
  throw new Error("Local SSH terminal content was not copied");
}
await page.evaluate(() => navigator.clipboard.writeText("echo clipboard-test"));
await page.locator("#localTerminalOutput").dispatchEvent("contextmenu", {
  bubbles: true, cancelable: true, clientX: 80, clientY: 160, button: 2,
});
await page.locator("[data-terminal-context='paste']").click();
await page.waitForTimeout(30);
if (!(await page.evaluate(() => (window.__localSshInputs || []).join(""))).includes("echo clipboard-test")) {
  throw new Error("Local SSH long-press menu did not paste clipboard text");
}
const terminalBox = await page.locator("#localTerminalOutput").boundingBox();
await cdpSession.send("Input.dispatchTouchEvent", {
  type: "touchStart",
  touchPoints: [{ x: terminalBox.x + 80, y: terminalBox.y + 30 }],
});
await page.waitForTimeout(600);
await cdpSession.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
await page.locator("#localTerminalContext:not([hidden])").waitFor();
if (process.env.WITT_LOCAL_SSH_ONLY === "1") {
  await page.screenshot({ path: "/tmp/witt-local-terminal-context.png", fullPage: false });
}
await page.locator("[data-terminal-context='copy']").click();
const terminalInput = page.locator("#localTerminalOutput .xterm-helper-textarea");
await terminalInput.focus();
await terminalInput.pressSequentially("pwd");
await terminalInput.press("Enter");
await page.waitForTimeout(30);
const terminalInputs = await page.evaluate(() => window.__localSshInputs || []);
if (!terminalInputs.join("").includes("pwd\r")) {
  throw new Error("Local SSH terminal input/output bridge failed");
}
await page.setViewportSize({ width: 390, height: 500 });
await page.waitForTimeout(100);
const terminalDockPosition = await page.locator(".local-terminal-tools").evaluate((node) => ({
  bottom: Math.round(node.getBoundingClientRect().bottom),
  viewport: window.innerHeight,
}));
if (Math.abs(terminalDockPosition.bottom - terminalDockPosition.viewport) > 2) {
  throw new Error(`Local SSH shortcuts did not follow the keyboard viewport: ${JSON.stringify(terminalDockPosition)}`);
}
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(100);
await page.getByRole("button", { name: "Tab", exact: true }).click();
if (await page.evaluate(() => window.__localSshInput) !== "\t") {
  throw new Error("Local SSH shortcut bar did not send Tab");
}
await page.getByRole("button", { name: "文件", exact: true }).click();
await page.locator("#localSftp:not([hidden])").waitFor();
await page.getByRole("button", { name: "下载", exact: true }).click();
await page.getByRole("button", { name: "上传", exact: true }).click();
const sftpState = await page.evaluate(() => ({
  path: window.__localSftpPath,
  uploadPath: window.__localSftpUploadPath,
  download: window.__localSftpDownload,
}));
if (sftpState.path !== "." || sftpState.uploadPath !== "/root" ||
    sftpState.download?.path !== "/root/notes.txt") {
  throw new Error(`Local SFTP browser bridge failed: ${JSON.stringify(sftpState)}`);
}
if (process.env.WITT_LOCAL_SSH_ONLY === "1") {
  await page.screenshot({ path: "/tmp/witt-local-sftp.png", fullPage: false });
}
await page.locator("#closeLocalSftp").click();
await page.locator("#localTerminal:not([hidden])").waitFor();
await page.locator("#disconnectLocalSsh").click();
await page.locator("#localSshLibrary:not([hidden])").waitFor();
const savedProfileText = await page.locator(".local-ssh-profile").textContent();
if (!savedProfileText.includes("测试服务器") || savedProfileText.includes("temporary-test-password")) {
  throw new Error("Saved SSH profile leaked its password or did not render");
}
if (process.env.WITT_LOCAL_SSH_ONLY === "1") {
  await page.screenshot({ path: "/tmp/witt-local-ssh-profiles.png", fullPage: false });
}
await page.locator("[data-connect-ssh-profile]").click();
await page.locator("#localTerminal:not([hidden])").waitFor();
if (await page.evaluate(() => window.__savedSshConnect) !==
    "55555555-5555-4555-8555-555555555555") {
  throw new Error("Saved SSH profile did not connect with one tap");
}
if (process.env.WITT_LOCAL_SSH_ONLY === "1") {
  await page.screenshot({ path: "/tmp/witt-local-ssh-mobile.png", fullPage: false });
  await page.evaluate(() => {
    window.DropVault.onLocalSshDisconnected();
    window.DropVault.onLocalSshStatus(JSON.stringify({
      connected: false, connecting: false, reconnecting: true,
      profileId: "55555555-5555-4555-8555-555555555555",
      host: "127.0.0.1", username: "root", port: 22,
    }));
  });
  await page.waitForTimeout(30);
  const unexpectedDisconnect = await page.evaluate(() => ({
    terminalHidden: document.querySelector("#localTerminal")?.hidden,
    target: document.querySelector("#localTerminalTarget")?.textContent,
    disconnectHidden: document.querySelector("#disconnectLocalSsh")?.hidden,
  }));
  if (unexpectedDisconnect.terminalHidden || unexpectedDisconnect.disconnectHidden ||
      !unexpectedDisconnect.target.includes("自动重连中")) {
    throw new Error(`Unexpected SSH disconnect discarded the terminal: ${JSON.stringify(unexpectedDisconnect)}`);
  }
  await page.evaluate(() => window.DropVault.onLocalSshConnected(JSON.stringify({
    connected: true, connecting: false, reconnecting: false, reconnected: true,
    profileId: "55555555-5555-4555-8555-555555555555",
    host: "127.0.0.1", username: "root", port: 22, connectedAt: Date.now(),
  })));
  await page.waitForTimeout(30);
  const recoveredConnection = await page.evaluate(() => ({
    terminalHidden: document.querySelector("#localTerminal")?.hidden,
    target: document.querySelector("#localTerminalTarget")?.textContent,
  }));
  if (recoveredConnection.terminalHidden || recoveredConnection.target.includes("自动重连中")) {
    throw new Error(`Recovered SSH session did not restore the terminal: ${JSON.stringify(recoveredConnection)}`);
  }
  await browser.close();
  console.log("Local SSH UI check passed");
  process.exit(0);
}
await page.locator("#closeLocalSsh").click();
const surfaceMotion = await page.evaluate(() => {
  const sheetIds = [
    "projectSheet", "profileSheet", "adminSettingsSheet", "codexAccountSheet",
    "settingsSheet", "deliverySheet", "actionDetailSheet",
  ];
  const sheetDurations = sheetIds.map((id) => {
    const panel = document.querySelector(`#${id} .sheet-panel`);
    return { id, duration: Number.parseFloat(getComputedStyle(panel).transitionDuration) };
  });
  const overlays = [
    ["dialog", ".dialog-card"],
    ["quota", ".quota-confirm-card"],
    ["image", ".image-viewer-panel"],
    ["activation", ".auth-gate-card"],
  ].map(([id, selector]) => {
    const node = document.querySelector(selector);
    const style = getComputedStyle(node);
    return { id, duration: Number.parseFloat(style.transitionDuration), willChange: style.willChange };
  });
  return { sheetDurations, overlays };
});
if (surfaceMotion.sheetDurations.some(({ duration }) => duration < .4) ||
    surfaceMotion.overlays.some(({ duration, willChange }) =>
      duration < .34 || !willChange.includes("transform"))) {
  throw new Error(`Not every surface uses the smooth motion system: ${JSON.stringify(surfaceMotion)}`);
}
const completedProcess = page.locator(".message.assistant .completed-process");
if ((await completedProcess.count()) !== 1 || await completedProcess.evaluate((node) => node.open)) {
  throw new Error("Completed task process did not collapse by default");
}
if (!(await completedProcess.locator(":scope > summary").textContent()).includes("用时 1 分 23 秒")) {
  throw new Error("Completed task runtime did not render");
}
if ((await page.locator(".message.assistant .completed-result .stream-message.final").count()) !== 1) {
  throw new Error("Completed task did not keep only the final result visible");
}
const renderedTable = page.locator(".completed-result .chat-table");
if ((await renderedTable.count()) !== 1 ||
    (await renderedTable.locator("thead th").allTextContents()).join("|") !== "项目|状态|数量" ||
    (await renderedTable.locator("tbody tr").count()) !== 2) {
  throw new Error("Markdown table did not render as a semantic table");
}
if ((await renderedTable.locator("th").nth(1).getAttribute("class")) !== "align-center" ||
    (await renderedTable.locator("th").nth(2).getAttribute("class")) !== "align-right") {
  throw new Error("Markdown table column alignment was not preserved");
}
const tableOverflow = await page.evaluate(() => ({
  page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  table: document.querySelector(".chat-table-scroll").scrollWidth -
    document.querySelector(".chat-table-scroll").clientWidth,
}));
if (tableOverflow.page > 1) {
  throw new Error(`Markdown table expanded the page: ${JSON.stringify(tableOverflow)}`);
}
await page.locator(".message.assistant").screenshot({ path: "tests/ui-completed-result-mobile.png" });
await completedProcess.locator(":scope > summary").click();
if ((await page.locator(".message.assistant .katex").count()) < 2) {
  throw new Error("Assistant formulas did not render with KaTeX");
}
if ((await page.locator(".message.assistant .chat-code-block code").textContent()) !== "const answer = 42;") {
  throw new Error("Assistant fenced code block did not render");
}
const chatLinks = page.locator(".message.assistant .chat-link");
if ((await chatLinks.count()) < 2) {
  throw new Error("Assistant Markdown and bare URL links did not render");
}
const linkState = await chatLinks.evaluateAll((links) => links.map((link) => ({
  href: link.href,
  rel: link.rel,
  pointerEvents: getComputedStyle(link).pointerEvents,
})));
if (!linkState.some(({ href }) => href.includes("github.com/LeoWilson-Ben/witt")) ||
    !linkState.some(({ href }) => href.includes("example.com/docs")) ||
    linkState.some(({ rel, pointerEvents }) => !rel.includes("noopener") || pointerEvents === "none")) {
  throw new Error(`Assistant links were not safe and tappable: ${JSON.stringify(linkState)}`);
}
await page.evaluate(() => {
  window.__clickedChatLink = "";
  document.addEventListener("click", (event) => {
    const link = event.target.closest(".chat-link");
    if (!link) return;
    event.preventDefault();
    window.__clickedChatLink = link.href;
  }, { capture: true, once: true });
});
await chatLinks.first().click();
await page.waitForFunction(() => window.__clickedChatLink.includes("github.com/LeoWilson-Ben/witt"));
await page.locator(".message.assistant [data-copy-code]").click();
await page.waitForFunction(() =>
  document.querySelector(".message.assistant [data-copy-code]")?.textContent === "已复制");
if ((await page.evaluate(() => window.__contentReadyMode)) !== "light") {
  throw new Error("Native system bars were not released with the active theme");
}
const nextShell = await page.evaluate(() => {
  const topbar = getComputedStyle(document.querySelector(".compact-nav-button"));
  const composer = getComputedStyle(document.querySelector(".composer"));
  return {
    videoCount: document.querySelectorAll("video").length,
    atmosphereLayers: document.querySelectorAll(".app-atmosphere i").length,
    topbarRadius: Number.parseFloat(topbar.borderRadius),
    topbarBlur: topbar.webkitBackdropFilter || topbar.backdropFilter,
    composerRadius: Number.parseFloat(composer.borderRadius),
    composerBlur: composer.webkitBackdropFilter || composer.backdropFilter,
    font: getComputedStyle(document.body).fontFamily,
    headingFont: getComputedStyle(document.querySelector(".welcome h1")).fontFamily,
  };
});
if (nextShell.videoCount !== 0 || nextShell.atmosphereLayers !== 3 ||
    nextShell.topbarRadius < 10 || nextShell.composerRadius < 16 ||
    !nextShell.font.includes("OpenAI Sans")) {
  throw new Error(`Workspace shell was not applied: ${JSON.stringify(nextShell)}`);
}
await page.waitForTimeout(80);
await page.screenshot({ path: "tests/ui-next-chat-mobile.png", fullPage: false });
await page.setViewportSize({ width: 844, height: 390 });
await page.waitForTimeout(140);
const compactHeader = await page.evaluate(() => {
  const topbar = document.querySelector(".compact-nav");
  const actions = document.querySelector(".compact-nav-actions");
  const menu = document.querySelector("#menuButton");
  return {
    background: getComputedStyle(topbar).backgroundColor,
    height: topbar.getBoundingClientRect().height,
    actionsWidth: actions.getBoundingClientRect().width,
    menuTop: menu.getBoundingClientRect().top,
  };
});
if (compactHeader.background !== "rgba(0, 0, 0, 0)" ||
    compactHeader.height > 68 ||
    compactHeader.actionsWidth > 160 ||
    compactHeader.menuTop < 6 ||
    compactHeader.menuTop > 24) {
  throw new Error(`Compact landscape header is invalid: ${JSON.stringify(compactHeader)}`);
}
await page.screenshot({ path: "tests/ui-next-header-landscape.png", fullPage: false });
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(140);
await page.waitForFunction(() => new Promise((resolve) => {
  const open = indexedDB.open("witt-local-conversations", 1);
  open.onerror = () => resolve(false);
  open.onsuccess = () => {
    const request = open.result.transaction("records", "readonly")
      .objectStore("records")
      .get("0123456789abcdef0123456789abcdef:conversation:00000000-0000-4000-8000-000000000001");
    request.onerror = () => resolve(false);
    request.onsuccess = () => resolve(Boolean(request.result?.value?.messages?.length));
  };
}));
const longUserMessage = page.locator('.message.user[data-message="u1"]');
if (!(await longUserMessage.evaluate((node) => node.classList.contains("long-message")))) {
  throw new Error("Long user message did not collapse automatically");
}
const collapsedMetrics = await longUserMessage.locator(".user-message-copy").evaluate((node) => ({
  clientHeight: node.clientHeight,
  scrollHeight: node.scrollHeight,
}));
if (!(collapsedMetrics.scrollHeight > collapsedMetrics.clientHeight)) {
  throw new Error("Collapsed user message did not hide overflowing text");
}
await longUserMessage.locator(".user-message-toggle").click();
if (!(await longUserMessage.evaluate((node) => node.classList.contains("expanded")))) {
  throw new Error("Long user message did not expand");
}
const expandedMetrics = await longUserMessage.locator(".user-message-copy").evaluate((node) => ({
  clientHeight: node.clientHeight,
  viewportHeight: window.innerHeight,
  scrollHeight: node.scrollHeight,
}));
if (expandedMetrics.clientHeight > expandedMetrics.viewportHeight * .64 + 2 ||
    expandedMetrics.scrollHeight <= expandedMetrics.clientHeight) {
  throw new Error("Expanded user message was not capped to an internal scroll area");
}
await longUserMessage.locator(".user-message-toggle").click();
if (await longUserMessage.evaluate((node) => node.classList.contains("expanded"))) {
  throw new Error("Long user message did not collapse again");
}
await longUserMessage.scrollIntoViewIfNeeded();
await page.screenshot({ path: "tests/ui-long-message-mobile.png", fullPage: false });
await page.locator("#quotaButton").waitFor();
if (!(await page.locator("#quotaButton").textContent()).includes("4%")) {
  throw new Error("Weekly quota did not render in the conversation menu");
}
await page.evaluate(() => {
  const stage = document.querySelector("#chatStage");
  stage.scrollTop = stage.scrollHeight;
});
await page.waitForTimeout(80);
const bottomSafeArea = await page.evaluate(() => {
  const shell = document.querySelector(".app-shell");
  const stage = document.querySelector("#chatStage");
  const composer = document.querySelector(".composer-wrap");
  const lastMessage = document.querySelector("#messageList > .message:last-child");
  const quota = document.querySelector("#quotaButton");
  const bars = [...quota.querySelectorAll("i")];
  const quotaRect = quota.getBoundingClientRect();
  return {
    composerInset: Number.parseFloat(getComputedStyle(shell).getPropertyValue("--composer-inset")),
    stagePaddingBottom: Number.parseFloat(getComputedStyle(stage).paddingBottom),
    lastMessageBottom: lastMessage.getBoundingClientRect().bottom,
    composerTop: composer.getBoundingClientRect().top,
    quotaOverflow: quota.scrollWidth - quota.clientWidth,
    barsInside: bars.every((bar) => {
      const rect = bar.getBoundingClientRect();
      return rect.left >= quotaRect.left && rect.right <= quotaRect.right + .5;
    }),
  };
});
if (bottomSafeArea.composerInset < 80 ||
    bottomSafeArea.stagePaddingBottom < bottomSafeArea.composerInset ||
    bottomSafeArea.lastMessageBottom > bottomSafeArea.composerTop - 8 ||
    bottomSafeArea.quotaOverflow > 1 || !bottomSafeArea.barsInside) {
  throw new Error(`Composer safe area or quota menu item overflowed: ${JSON.stringify(bottomSafeArea)}`);
}
const mobileCommandApproval = conversation.messages[1].stream.find((entry) => entry.kind === "approval");
mobileCommandApproval.status = "pending";
await page.evaluate(({ conversation }) => {
  window.DropVault.onConversation(JSON.stringify({ conversation }));
}, { conversation });
await page.locator(".approval-card.pending").waitFor();
if ((await page.locator(".stream-message").count()) !== 2) throw new Error("Process messages did not render");
if (await page.locator(".stream-message").first().evaluate(
  (node) => Number.parseFloat(getComputedStyle(node).fontSize)) < 14) {
  throw new Error("Conversation text scale did not increase");
}
if (!(await page.locator(".approval-card").textContent()).includes("允许执行这条命令")) {
  throw new Error("Approval card did not render");
}
if ((await page.locator(".approval-choice-grid label").count()) !== 4) {
  throw new Error("Codex approval choices did not render");
}
const pendingOverflow = await page.evaluate(() => {
  const stage = document.querySelector("#chatStage");
  const card = document.querySelector(".approval-card");
  const evidence = document.querySelector(".approval-evidence code");
  return {
    stage: stage.scrollWidth - stage.clientWidth,
    card: card.getBoundingClientRect().right - document.documentElement.clientWidth,
    evidence: evidence.scrollWidth - evidence.clientWidth,
  };
});
if (pendingOverflow.stage > 1 || pendingOverflow.card > 1 || pendingOverflow.evidence > 1) {
  throw new Error(`Long approval command overflowed on mobile: ${JSON.stringify(pendingOverflow)}`);
}
await page.locator(".approval-choice-grid label").nth(1).click();
await page.locator("[data-approval-decision-form] button[type=submit]").click();
await page.waitForTimeout(250);
await page.waitForFunction(() => !document.body.classList.contains("approval-dock-open"));
if ((await page.evaluate(() => window.__resolvedApproval?.choiceId)) !== "choice-2") {
  throw new Error("Approval choice was not submitted through the mobile dialog");
}
mobileCommandApproval.status = "accepted";
const resolvedOverflow = await page.evaluate(() => {
  const stage = document.querySelector("#chatStage");
  const dock = document.querySelector("#approvalDock");
  return {
    stage: stage.scrollWidth - stage.clientWidth,
    dock: dock.scrollWidth - dock.clientWidth,
  };
});
if (resolvedOverflow.stage > 1 || resolvedOverflow.dock > 1) {
  throw new Error(`Resolved approval overflowed on mobile: ${JSON.stringify(resolvedOverflow)}`);
}
await page.screenshot({ path: "tests/ui-overflow-mobile.png", fullPage: false });
await page.evaluate(({ conversation }) => {
  conversation.messages[1].stream.push({
    id: "approval-figma", kind: "approval",
    approvalId: "44444444-4444-4444-8444-444444444444",
    approvalType: "connector", status: "pending",
    title: "Figma 画布操作",
    reason: "允许 Figma 修改 Witt Model & Reasoning Control Redesign 吗？",
    approvalOptions: [
      { id: "input-1", label: "Accept", description: "允许这次画布操作", tone: "accepted" },
      { id: "input-2", label: "Decline", description: "拒绝并继续", tone: "declined" },
      { id: "input-3", label: "Cancel", description: "取消本轮", tone: "declined" },
    ],
  });
  window.DropVault.onConversation(JSON.stringify({ conversation }));
}, { conversation });
const figmaApproval = page.locator('[data-approval-card="44444444-4444-4444-8444-444444444444"]');
await figmaApproval.waitFor();
if (!(await figmaApproval.textContent()).includes("Figma 画布操作")) {
  throw new Error("Connector approval card did not render");
}
if ((await figmaApproval.locator(".approval-choice-grid label").count()) !== 3) {
  throw new Error("Connector approval choices did not render");
}
await figmaApproval.locator(".approval-choice-grid label").first().click();
await figmaApproval.locator("[data-approval-decision-form] button[type=submit]").click();
if ((await page.evaluate(() => window.__resolvedApproval?.approvalId)) !==
    "44444444-4444-4444-8444-444444444444") {
  throw new Error("Connector approval was not submitted through the Android bridge");
}
if ((await page.evaluate(() => window.__resolvedApproval?.choiceId)) !== "input-1") {
  throw new Error("Connector approval submitted the wrong choice");
}
await page.waitForFunction(() => !document.body.classList.contains("approval-dock-open"));
if ((await page.locator(".execution-image").count()) !== 1) {
  throw new Error("Execution image did not render inline");
}
if ((await page.locator(".delivery-image").count()) !== 1) {
  throw new Error("Delivered image did not render inline");
}
const processDetails = page.locator(".completed-process").first();
if (!(await processDetails.evaluate((details) => details.open))) {
  await processDetails.locator(":scope > summary").click();
}
await page.locator(".execution-image").scrollIntoViewIfNeeded();
await page.waitForFunction(() =>
  document.querySelector(".execution-image img")?.naturalWidth > 0);
await page.locator(".execution-image").click();
if (!(await page.locator("#imageViewer").evaluate((viewer) => viewer.classList.contains("open")))) {
  throw new Error("Image viewer did not open");
}
await page.locator("#downloadImageViewer").click();
if (!(await page.evaluate(() => window.__downloadedImage?.name === "执行截图.png"))) {
  throw new Error("Image download bridge was not called");
}
await page.locator("#closeImageViewer").click();
if ((await page.locator(".stream-action-group").count()) !== 1) {
  throw new Error("Consecutive actions were not grouped");
}
if (await page.locator(".stream-action-group").evaluate((node) => node.open)) {
  throw new Error("Completed action group did not collapse automatically");
}
if (!(await page.locator(".stream-action-group summary").textContent()).includes("修改 3 个文件")) {
  throw new Error("Action group summary did not include the file count");
}
await page.evaluate(({ conversation }) => {
  conversation.messages[1].status = "running";
  conversation.messages[1].stream[2].status = "running";
  window.DropVault.onConversation(JSON.stringify({ conversation }));
}, { conversation });
if (!(await page.locator(".stream-action-group").evaluate((node) => node.open))) {
  throw new Error("Running action group did not stay expanded");
}
await page.evaluate(({ conversation }) => {
  conversation.messages[1].status = "completed";
  conversation.messages[1].stream[2].status = "completed";
  window.DropVault.onConversation(JSON.stringify({ conversation }));
}, { conversation });
if (await page.locator(".stream-action-group").evaluate((node) => node.open)) {
  throw new Error("Action group did not collapse after completion");
}
await page.locator(".completed-process > summary").click();
await page.locator(".stream-action-group summary").click();
await page.locator(".stream-action.command").click();
await page.locator(".detail-block.command").waitFor();
const commandDetails = await page.locator("#actionDetailContent").textContent();
if (!commandDetails.includes("systemctl is-active") ||
    !commandDetails.includes("退出码 7") ||
    !commandDetails.includes("失败原因") ||
    !commandDetails.includes("测试命令返回失败")) {
  throw new Error("Command detail omitted its exit code or failure reason: " + commandDetails.slice(0, 300));
}
await page.locator("#closeActionDetail").evaluate((button) => button.click());
await page.evaluate(({ conversation }) => {
  conversation.workDir = "/opt/witt";
  conversation.gitBranch = "platform/personal-ai-ops";
  conversation.harnessId = "grok-build";
  window.DropVault.onConversation(JSON.stringify({ conversation }));
}, { conversation });
if (!(await page.locator(".completed-process").first().evaluate((node) => node.open))) {
  await page.locator(".completed-process > summary").first().click();
}
if (!(await page.locator(".stream-action-group").evaluate((node) => node.open))) {
  await page.locator(".stream-action-group > summary").click();
}
await page.locator(".stream-action.file").click();
await page.locator(".development-workflow-launch").waitFor();
const fileDetails = await page.locator("#actionDetailContent").textContent();
for (const label of ["新增", "未跟踪文本", "重命名", "二进制文件", "大文件", "Diff 已截断"]) {
  if (!fileDetails.includes(label)) throw new Error(`File details omitted ${label}`);
}
await page.locator("[data-workflow-prepare]").click();
if (await page.evaluate(() => window.__developmentWorkflowRequest || null)) {
  throw new Error("Workflow started before the explicit confirmation click");
}
await page.locator("[data-workflow-confirm-send]").click();
await page.waitForFunction(() => window.__developmentWorkflowRequest?.commitMessage === "");
await page.waitForFunction(() =>
  document.querySelector("[data-development-workflow-status]")?.textContent.includes("正在运行测试"));
if (await page.evaluate(() => window.__developmentCommitRequest || window.__developmentDeployRequest)) {
  throw new Error("Commit or deploy started during the test-only step");
}
await page.evaluate(({ conversation }) => {
  window.DropVault.onDevelopmentWorkflow(JSON.stringify({
    job: { id: "00000000-0000-4000-8000-000000000099",
      conversationId: conversation.id, messageId: conversation.messages[1].id,
      status: "awaiting_commit_confirmation", stage: "testing", message: "测试通过" },
  }));
}, { conversation });
await page.locator("[data-workflow-prepare-commit]").click();
if (await page.evaluate(() => window.__developmentCommitRequest || null)) {
  throw new Error("Commit started before its explicit confirmation");
}
await page.locator("[data-workflow-commit-message]").fill("Witt: 手机交付闭环");
await page.locator("[data-workflow-confirm-commit]").click();
await page.waitForFunction(() => window.__developmentCommitRequest?.commitMessage === "Witt: 手机交付闭环");
await page.evaluate(({ conversation }) => {
  window.DropVault.onDevelopmentWorkflow(JSON.stringify({
    job: { id: "00000000-0000-4000-8000-000000000099",
      conversationId: conversation.id, messageId: conversation.messages[1].id,
      status: "awaiting_deploy_confirmation", stage: "pushing",
      sha: "abcdef0123456789abcdef0123456789abcdef01", message: "已推送" },
  }));
}, { conversation });
await page.locator("[data-workflow-prepare-deploy]").click();
if (await page.evaluate(() => window.__developmentDeployRequest || null)) {
  throw new Error("Deploy started before its separate confirmation");
}
await page.locator("[data-workflow-confirm-deploy]").click();
await page.waitForFunction(() => Boolean(window.__developmentDeployRequest?.jobId));
await page.waitForFunction(() => document.querySelector("#deploymentVersionStatus")?.textContent === "前后端一致");
const mobileFileLayout = await page.evaluate(() => ({
  viewport: document.documentElement.clientWidth,
  page: document.documentElement.scrollWidth,
  sheet: document.querySelector(".action-detail-panel")?.scrollWidth,
  content: document.querySelector("#actionDetailContent")?.scrollWidth,
}));
if (mobileFileLayout.page > mobileFileLayout.viewport ||
    mobileFileLayout.sheet > mobileFileLayout.viewport ||
    mobileFileLayout.content > mobileFileLayout.sheet) {
  throw new Error(`File details overflowed mobile width: ${JSON.stringify(mobileFileLayout)}`);
}
await page.locator("#closeActionDetail").evaluate((button) => button.click());
await page.locator(".message.assistant").first().evaluate((node) => { node.dataset.stabilityProbe = "kept"; });
await page.evaluate(({ conversation }) => {
  window.DropVault.onConversation(JSON.stringify({ conversation }));
}, { conversation });
if ((await page.locator('[data-stability-probe="kept"]').count()) !== 1) {
  throw new Error("Conversation refresh replaced stable message DOM");
}
const scrollAnchorBefore = await page.evaluate(() => {
  const stage = document.querySelector("#chatStage");
  const assistant = document.querySelector('.message.assistant[data-message="a1"]');
  stage.scrollTop = Math.min(
    assistant.offsetTop + 150,
    Math.max(0, stage.scrollHeight - stage.clientHeight - 240));
  const stageTop = stage.getBoundingClientRect().top;
  const visible = [...document.querySelector("#messageList").children].find((message) =>
    message.getBoundingClientRect().bottom > stageTop + 1);
  return {
    scrollTop: stage.scrollTop,
    messageId: visible?.dataset.message,
    offset: visible?.getBoundingClientRect().top - stageTop,
    bottomGap: stage.scrollHeight - stage.scrollTop - stage.clientHeight,
  };
});
if (scrollAnchorBefore.scrollTop < 100 || scrollAnchorBefore.bottomGap < 180) {
  throw new Error(`Scroll stability fixture was not away from either edge: ${JSON.stringify(scrollAnchorBefore)}`);
}
await page.evaluate(({ conversation }) => {
  conversation.messages[1].stream[0].text += " 输出状态刚刚更新。";
  window.DropVault.onConversation(JSON.stringify({ conversation }));
}, { conversation });
await page.waitForTimeout(80);
const scrollAnchorAfter = await page.evaluate(() => {
  const stage = document.querySelector("#chatStage");
  const stageTop = stage.getBoundingClientRect().top;
  const visible = [...document.querySelector("#messageList").children].find((message) =>
    message.getBoundingClientRect().bottom > stageTop + 1);
  return {
    scrollTop: stage.scrollTop,
    messageId: visible?.dataset.message,
    offset: visible?.getBoundingClientRect().top - stageTop,
  };
});
if (scrollAnchorAfter.scrollTop < 100 ||
    scrollAnchorAfter.messageId !== scrollAnchorBefore.messageId ||
    Math.abs(scrollAnchorAfter.offset - scrollAnchorBefore.offset) > 3) {
  throw new Error(`Output refresh moved the visible conversation anchor: ${JSON.stringify({ scrollAnchorBefore, scrollAnchorAfter })}`);
}
await page.locator("#modelButton").click();
await page.locator("#quickModelExpand").click();
await page.locator('[data-quick-model="gpt-5.6-terra"]').click();
await page.waitForTimeout(120);
await page.evaluate(() => {
  const sheet = document.querySelector("#settingsSheet");
  sheet.classList.add("open");
  sheet.setAttribute("aria-hidden", "false");
});
if ((await page.locator("#reasoningStops [data-reasoning]").count()) !== 6) {
  throw new Error("Dynamic reasoning rail did not expose all supported levels");
}
await page.locator('#reasoningSegments [data-reasoning="high"]').click();
if ((await page.locator("#reasoningControl").getAttribute("data-level")) !== "high") {
  throw new Error("Clickable reasoning rail did not update its visual intensity");
}
const modelRailHeight = await page.locator(".model-options").evaluate((node) => node.getBoundingClientRect().height);
if (modelRailHeight > 118) throw new Error("Model selector is no longer compact");
const reasoningAnimation = await page.locator(".reasoning-liquid-fill").evaluate((node) => getComputedStyle(node).animationName);
if (!reasoningAnimation.includes("reasoning-spectrum")) {
  throw new Error("Higher reasoning level did not activate the spectrum animation");
}
const reasoningRailHeight = await page.locator(".reasoning-liquid").evaluate((node) => node.getBoundingClientRect().height);
if (reasoningRailHeight < 36) {
  throw new Error(`Reasoning energy capsule is not visually substantial enough: ${reasoningRailHeight}px`);
}
const reasoningHitHeight = await page.locator('#reasoningSegments [data-reasoning="high"]').evaluate((node) => node.getBoundingClientRect().height);
if (reasoningHitHeight < 40) {
  throw new Error(`Reasoning rail touch target is too small: ${reasoningHitHeight}px`);
}
if ((await page.locator("#appServerStatus .app-server-metrics > div").count()) !== 4) {
  throw new Error("App Server runtime dashboard did not render four live metrics");
}
const settingsVisual = await page.evaluate(() => {
  const footer = document.querySelector(".settings-apply-bar").getBoundingClientRect();
  const panel = getComputedStyle(document.querySelector(".settings-panel"));
  const runtime = getComputedStyle(document.querySelector(".app-server-capabilities"));
  const metric = getComputedStyle(document.querySelector(".app-server-metrics strong"));
  const action = getComputedStyle(document.querySelector(".app-server-actions strong"));
  return {
    footerTop: footer.top,
    footerBottom: footer.bottom,
    viewportHeight: innerHeight,
    panelOverflow: panel.overflowY,
    runtimeBackground: runtime.backgroundImage,
    metricColor: metric.color,
    actionColor: action.color,
  };
});
if (settingsVisual.footerTop < 0 || settingsVisual.footerBottom > settingsVisual.viewportHeight + 1) {
  throw new Error(`Settings action bar is not fixed inside the visible sheet: ${JSON.stringify(settingsVisual)}`);
}
if (settingsVisual.panelOverflow !== "hidden" || !settingsVisual.runtimeBackground.includes("linear-gradient")) {
  throw new Error(`Settings sheet did not use the new scrolling and runtime surfaces: ${JSON.stringify(settingsVisual)}`);
}
if (!settingsVisual.metricColor.includes("248") || !settingsVisual.actionColor.includes("248")) {
  throw new Error(`Runtime text lost contrast: ${JSON.stringify(settingsVisual)}`);
}
await page.screenshot({ path: "tests/ui-settings-mobile.png", fullPage: true });
await page.evaluate(() => {
  document.documentElement.dataset.theme = "light";
  document.documentElement.dataset.themeMode = "light";
});
await page.waitForTimeout(520);
const lightSettingsVisual = await page.evaluate(() => ({
  metricColor: getComputedStyle(document.querySelector(".app-server-metrics strong")).color,
  actionColor: getComputedStyle(document.querySelector(".app-server-actions strong")).color,
  selectedModelColor: getComputedStyle(document.querySelector(".model-options > button.selected strong")).color,
}));
if (!lightSettingsVisual.metricColor.includes("248") ||
    !lightSettingsVisual.actionColor.includes("248") ||
    lightSettingsVisual.selectedModelColor.includes("255, 255, 255")) {
  throw new Error(`Day settings text is not readable: ${JSON.stringify(lightSettingsVisual)}`);
}
await page.screenshot({ path: "tests/ui-settings-light-mobile.png", fullPage: true });
await page.locator(".settings-scroll").evaluate((node) => { node.scrollTop = node.scrollHeight; });
await page.waitForTimeout(80);
const settingsBottomLayout = await page.evaluate(() => {
  const lastAction = document.querySelector(".app-server-actions button:last-child").getBoundingClientRect();
  const footer = document.querySelector(".settings-apply-bar").getBoundingClientRect();
  const header = document.querySelector(".settings-panel > .sheet-head").getBoundingClientRect();
  return {
    lastActionBottom: lastAction.bottom,
    footerTop: footer.top,
    footerBottom: footer.bottom,
    headerTop: header.top,
    viewportHeight: innerHeight,
    label: document.querySelector(".app-server-actions button:last-child strong")?.textContent,
    detail: document.querySelector(".app-server-actions button:last-child small")?.textContent,
  };
});
if (settingsBottomLayout.lastActionBottom > settingsBottomLayout.footerTop + 1 ||
    settingsBottomLayout.headerTop < 0 || settingsBottomLayout.footerBottom > settingsBottomLayout.viewportHeight + 1 ||
    !settingsBottomLayout.label || !settingsBottomLayout.detail) {
  throw new Error(`Settings content cannot scroll fully above the action bar: ${JSON.stringify(settingsBottomLayout)}`);
}
await page.screenshot({ path: "tests/ui-settings-bottom-light-mobile.png", fullPage: true });
await page.locator(".settings-scroll").evaluate((node) => { node.scrollTop = 0; });
await page.evaluate(() => {
  document.documentElement.dataset.theme = "colorful";
  document.documentElement.dataset.themeMode = "colorful";
});
await page.locator('#reasoningSegments [data-reasoning="ultra"]').click();
if ((await page.locator("#reasoningControl").getAttribute("data-intensity")) !== "5") {
  throw new Error("Ultra reasoning did not activate maximum visual intensity");
}
await page.screenshot({ path: "tests/ui-settings-ultra-mobile.png", fullPage: true });
await page.locator('#reasoningStops [data-reasoning="high"]').click();
await page.locator('[data-access="workspace-write"]').click();
await page.locator("#saveSettings").click();
await page.waitForTimeout(60);
if (!(await page.locator("#modelLabel").textContent()).includes("Terra")) throw new Error("Model selection did not persist");
if ((await page.locator(".assistant-avatar").count()) !== 0) throw new Error("Assistant avatar should not render");
if ((await page.locator(".assistant-name").count()) !== 0) throw new Error("Assistant name should not render");
await page.locator("#chatMoreButton").click();
await page.locator("#deliveryButton").click();
await page.locator('[data-artifact="00000000-0000-4000-8000-000000000099"]').click();
if (!(await page.evaluate(() => window.__downloadedArtifact?.name === "年报交付.xlsx"))) {
  throw new Error("Artifact download bridge was not called");
}
await page.locator("#closeDelivery").click();
await page.locator("#attachButton").click();
await page.locator("#projectButton").click();
await page.locator('[data-project-path="/data/xuanyu-build-console/repo"]').click();
await page.waitForFunction(() => window.__updatedProject === "/data/xuanyu-build-console/repo");
await page.waitForFunction(() => document.querySelector("#projectLabel")?.textContent === "玄遇");
if ((await page.locator("#projectLabel").textContent()) !== "玄遇") {
  throw new Error("Conversation project selector did not update");
}
await page.locator("#menuButton").click();
await page.waitForTimeout(520);
const drawerLayout = await page.evaluate(() => {
  const panel = document.querySelector(".drawer-panel");
  const history = document.querySelector(".drawer-history");
  const list = document.querySelector("#conversationList");
  const tools = document.querySelector(".drawer-tools");
  return {
    count: document.querySelector("#conversationCount")?.textContent,
    rowCount: list.children.length,
    listHeight: list.clientHeight,
    listScrollHeight: list.scrollHeight,
    listScrollable: list.scrollHeight > list.clientHeight,
    historyBottom: history.getBoundingClientRect().bottom,
    toolsTop: tools.getBoundingClientRect().top,
    toolsBottom: tools.getBoundingClientRect().bottom,
    panelBottom: panel.getBoundingClientRect().bottom,
    transitionDuration: Number.parseFloat(getComputedStyle(panel).transitionDuration),
    rowAnimation: getComputedStyle(list.querySelector(".conversation-row")).animationName,
    willChange: getComputedStyle(panel).willChange,
  };
});
if (drawerLayout.count !== "19" || !drawerLayout.listScrollable ||
    drawerLayout.historyBottom > drawerLayout.toolsTop + 1 ||
    drawerLayout.toolsBottom > drawerLayout.panelBottom + 1 ||
    drawerLayout.transitionDuration < .4 || drawerLayout.rowAnimation !== "none" ||
    !drawerLayout.willChange.includes("transform")) {
  throw new Error(`Conversation drawer did not keep an independent history rail: ${JSON.stringify(drawerLayout)}`);
}
await page.screenshot({ path: "tests/ui-drawer-history-mobile.png", fullPage: false });
await page.evaluate(() => {
  const stage = document.querySelector("#chatStage");
  window.__conversationOpenScrolls = [];
  stage.addEventListener("scroll", () => window.__conversationOpenScrolls.push(stage.scrollTop),
    { passive: true });
  stage.scrollTop = 0;
});
await page.locator('[data-open="00000000-0000-4000-8000-000000000001"]').click();
await page.waitForTimeout(120);
const openedConversationBottomGap = await page.locator("#chatStage").evaluate((stage) =>
  Math.max(0, stage.scrollHeight - stage.scrollTop - stage.clientHeight));
if (openedConversationBottomGap > 2) {
  const openDebug = await page.evaluate(() => ({
    requestedId: window.__requestedConversationId,
    scrolls: window.__conversationOpenScrolls,
    activeRow: document.querySelector(".conversation-row.active")?.dataset.id,
  }));
  throw new Error(`Opening a conversation did not show its latest message: ${openedConversationBottomGap} ${JSON.stringify(openDebug)}`);
}
await page.waitForTimeout(420);
await page.locator("#menuButton").click();
await page.waitForTimeout(520);
await page.locator('[data-theme-choice="dark"]').click();
await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
if ((await page.locator("html").getAttribute("data-theme")) !== "dark") {
  throw new Error("Night theme did not activate");
}
if ((await page.evaluate(() => localStorage.getItem("wit_theme"))) !== "dark") {
  throw new Error("Night theme preference was not saved");
}
await page.screenshot({ path: "tests/ui-night-mobile.png", fullPage: true });
await page.locator("#closeDrawer").click();
await page.waitForTimeout(400);
await page.screenshot({ path: "tests/ui-night-chat-mobile.png", fullPage: true });
await page.locator("#menuButton").click();
await page.locator("#profileButton").click();
await page.locator(".usage-grid").waitFor();
await page.screenshot({ path: "tests/ui-night-profile-mobile.png", fullPage: true });
await page.locator("#closeProfile").click();
await page.locator("#menuButton").click();
await page.locator('[data-theme-choice="light"]').click();
await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
if ((await page.locator("html").getAttribute("data-theme")) !== "light") {
  throw new Error("Day theme did not restore");
}
const originalDay = await page.evaluate(() => ({
  videos: document.querySelectorAll("video").length,
  cinematicStylesheet: Boolean(document.querySelector("#cinematicStylesheet")),
  themeColor: document.querySelector("#themeColor")?.content,
}));
if (originalDay.videos !== 0 || originalDay.cinematicStylesheet || originalDay.themeColor !== "#ffffff") {
  throw new Error(`Day theme retained legacy cinematic resources: ${JSON.stringify(originalDay)}`);
}
await page.locator("#profileButton").click();
await page.locator(".usage-grid").waitFor();
if ((await page.locator(".usage-day").count()) !== 112) {
  throw new Error("Token usage heatmap did not render 16 weeks");
}
if ((await page.locator(".usage-insight").count()) !== 1) {
  throw new Error("Recent activity insight did not render beside the heatmap");
}
if (!(await page.locator(".usage-stats").textContent()).includes("1.2M")) {
  throw new Error("Token usage summary did not render");
}
if ((await page.locator(".quota-actions").count()) !== 1) throw new Error("Quota actions did not render");
if (!(await page.locator(".weekly-quota-summary").textContent()).includes("剩余 96%")) {
  throw new Error("Weekly quota did not render in the profile");
}
if (await page.locator(".usage-capacity").count()) throw new Error("Legacy capacity card is still rendered");
if ((await page.locator(".glow-reset").count()) !== 1) throw new Error("Glowing reset control did not render");
await page.locator("[data-reset-rate-limit]").click();
await page.locator("#quotaConfirm.open").waitFor();
if ((await page.locator("#quotaConfirm").textContent()).includes("https://")) {
  throw new Error("Quota confirmation exposed a web address");
}
await page.locator("#confirmQuotaReset").click();
if (!(await page.evaluate(() => window.__resetAttempt))) throw new Error("Reset confirmation did not call the bridge");
if ((await page.evaluate(() => window.__resetConversationId)) !== conversation.id) {
  throw new Error("Reset confirmation did not target the active conversation account");
}
await page.screenshot({ path: "tests/ui-profile-mobile.png", fullPage: true });
await page.locator("#closeProfile").click();
await page.locator("#attachButton").click();
await page.locator("#attachmentMenu.open").waitFor();
await page.locator("#attachFileButton").click();
await page.locator(".attachment-chip").waitFor();
await page.locator("#messageInput").fill("读取这个附件并给我摘要。");
await page.locator("#sendButton").click();
await page.locator(".message.user").nth(1).waitFor();
await page.locator("#sendButton.sending").waitFor({ state: "detached" });
if (await page.locator("#messageInput").isDisabled()) throw new Error("Composer locked while Codex was running");
if (!(await page.locator("#sendButton").evaluate((node) => node.classList.contains("working")))) {
  throw new Error("Send button did not become the running spinner");
}
if (!(await page.locator(".composer").evaluate((node) => node.classList.contains("has-active-turn")))) {
  throw new Error("Composer did not enter its active-turn visual state");
}
await page.locator("#messageInput").fill("补充：也检查桥梁数据。");
if (await page.locator("#sendButton").evaluate((node) => node.classList.contains("working"))) {
  throw new Error("Typing guidance did not restore the send arrow");
}
await page.locator("#sendButton").click();
await page.locator(".message.user").nth(2).waitFor();
await page.locator("#sendButton.sending").waitFor({ state: "detached" });
if (!(await page.locator(".message.user.guided time").textContent()).includes("已引导")) {
  throw new Error("Guidance message did not show the guided label");
}
const guidedOrder = await page.evaluate(() => {
  const assistant = document.querySelector('.message.assistant[data-message="a2"]');
  const guided = document.querySelector(".message.user.guided");
  return Boolean(assistant && guided && assistant.nextElementSibling === guided);
});
if (!guidedOrder) throw new Error("Guidance message was not placed immediately below the active response");
await page.waitForFunction(() => {
  const guided = document.querySelector(".message.user.guided");
  const continuation = guided?.nextElementSibling;
  return continuation?.classList.contains("assistant") &&
    continuation.textContent.includes("我接着补充要求继续检查。");
});
const continuationOrder = await page.evaluate(() => {
  const guided = document.querySelector(".message.user.guided");
  const continuation = guided?.nextElementSibling;
  const original = guided?.previousElementSibling;
  return Boolean(continuation &&
    continuation.dataset.message.startsWith("a2--continuation-") &&
    !original?.textContent.includes("我接着补充要求继续检查。"));
});
if (!continuationOrder) throw new Error("Assistant continuation did not move below the guidance message");
await page.waitForFunction(() => (window.__deltaRequestCount || 0) > 0, null, { timeout: 2500 });
const deltaCountBeforePause = await page.evaluate(() => window.__deltaRequestCount || 0);
await page.evaluate(() => window.DropVault.onAppVisibility(false));
if (!(await page.locator("body").evaluate((node) => node.classList.contains("power-paused")))) {
  throw new Error("Hidden app did not pause web animations");
}
await page.waitForTimeout(1350);
if ((await page.evaluate(() => window.__deltaRequestCount || 0)) !== deltaCountBeforePause) {
  throw new Error("Hidden app continued polling the active conversation");
}
await page.evaluate(() => window.DropVault.onAppVisibility(true));
await page.waitForFunction((count) => (window.__deltaRequestCount || 0) > count,
  deltaCountBeforePause, { timeout: 1800 });
await page.screenshot({ path: "tests/ui-mobile.png", fullPage: true });

if ((await page.locator(".message").count()) !== 6) throw new Error("Steered continuation did not render");
if ((await page.locator(".attachment-chip").count()) !== 0) throw new Error("Composer attachment did not clear");
if ((await page.locator("#pauseButton").count()) !== 0) throw new Error("Legacy pause button still exists");
await page.locator("#menuButton").click();
if ((await page.locator(".conversation-mark i").count()) !== 1) {
  throw new Error("Busy conversation did not show a drawer spinner");
}
await page.locator("#closeDrawer").click();
await page.locator("#sendButton.working").evaluate((button) => {
  button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
});
await page.waitForFunction(() => Boolean(window.__interruptedConversationId));
await page.locator("#sendButton.working").waitFor({ state: "detached" });
await page.evaluate(({ conversation, now }) => {
  conversation.messages.push({
    id: "orphan-steer",
    role: "user",
    text: "任务结束前追加的补充要求",
    attachments: [],
    createdAt: now,
    status: "queued",
  });
  conversation.busy = false;
  window.DropVault.onConversation(JSON.stringify({ conversation }));
}, { conversation, now });
if (await page.locator("#sendButton").evaluate((node) => node.classList.contains("working"))) {
  throw new Error("An orphan queued user message incorrectly kept the conversation busy");
}
await page.locator("#menuButton").click();
if ((await page.locator(".conversation-mark i").count()) !== 0) {
  throw new Error("Completed conversation remained spinning in the drawer");
}
await page.locator("#closeDrawer").click();
await page.locator("#chatStage").evaluate((stage) => {
  stage.scrollTop = stage.scrollHeight;
});
await page.setViewportSize({ width: 844, height: 390 });
await page.waitForTimeout(420);
const landscapeLayout = await page.evaluate(() => {
  const shell = document.querySelector(".app-shell");
  const topbar = document.querySelector(".compact-nav");
  const stage = document.querySelector(".chat-stage");
  const composer = document.querySelector(".composer-wrap");
  const message = document.querySelector(".message.user .user-message-rich");
  return {
    landscape: matchMedia("(orientation: landscape)").matches,
    shellWidth: shell?.getBoundingClientRect().width || 0,
    topbarHeight: topbar?.getBoundingClientRect().height || 0,
    fontSize: Number.parseFloat(getComputedStyle(message).fontSize),
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth ||
      stage.scrollWidth > stage.clientWidth,
    composerVisible: composer?.getBoundingClientRect().bottom <= innerHeight + 1,
    bottomGap: Math.max(0, stage.scrollHeight - stage.scrollTop - stage.clientHeight),
  };
});
if (!landscapeLayout.landscape ||
    landscapeLayout.shellWidth <= 620 ||
    landscapeLayout.topbarHeight <= 0 ||
    landscapeLayout.fontSize < 14 ||
    landscapeLayout.overflow ||
    !landscapeLayout.composerVisible ||
    landscapeLayout.bottomGap > 2) {
  throw new Error(`Landscape layout usability failed: ${JSON.stringify(landscapeLayout)}`);
}
await page.screenshot({ path: "tests/ui-landscape.png", fullPage: false });
await page.setViewportSize({ width: 360, height: 800 });
await page.waitForTimeout(420);
const portraitBottomGap = await page.locator("#chatStage").evaluate((stage) =>
  Math.max(0, stage.scrollHeight - stage.scrollTop - stage.clientHeight));
if (portraitBottomGap > 2) {
  throw new Error(`Portrait rotation lost the latest message: ${portraitBottomGap}`);
}
await page.locator("#menuButton").click();
await page.locator("#codexAccountsButton").click();
await page.waitForFunction(() =>
  document.querySelector("#codexAccountSheet")?.classList.contains("open") &&
  document.querySelector("#codexAccountList")?.textContent.includes("子账号"));
if ((await page.locator("[data-login-codex='xuanyu']").count()) !== 1) {
  throw new Error("Signed-out Xuanyu account did not show its login action");
}
await page.locator("#closeCodexAccounts").click();
await page.locator("#menuButton").click();
await page.locator("#drawerNewChat").click();
await page.waitForFunction(() => Boolean(window.__createdConversationArgs));
if ((await page.evaluate(() => window.__createdConversationArgs.workDir)) !== "") {
  throw new Error("New conversation unexpectedly selected a project path");
}
if ((await page.evaluate(() => window.__createdConversationArgs.codexProfile)) !== "default") {
  throw new Error("Regular new conversation did not stay on the default Codex account");
}
if ((await page.locator("#projectLabel").textContent()) !== "空白") {
  throw new Error("New conversation project did not default to blank");
}
if ((await page.locator("#welcome").textContent()).includes("项目")) {
  throw new Error("New conversation landing still mentioned a project");
}
await page.waitForFunction(() => !document.querySelector("#welcome")?.hidden);
await page.waitForTimeout(480);
const welcomeLayout = await page.evaluate(() => {
  const welcome = document.querySelector("#welcome");
  window.__welcomeDebug = {
    welcome: { display: getComputedStyle(welcome).display, rect: welcome.getBoundingClientRect().toJSON(), hidden: welcome.hidden },
    suggestionContainer: { display: getComputedStyle(welcome.querySelector(".suggestions")).display, rect: welcome.querySelector(".suggestions").getBoundingClientRect().toJSON() },
    buttons: [...welcome.querySelectorAll(".suggestions button")].map((button) => ({ display: getComputedStyle(button).display, minHeight: getComputedStyle(button).minHeight, rect: button.getBoundingClientRect().toJSON() })),
    css: [...document.styleSheets].map((sheet) => sheet.href).filter(Boolean),
    bodyClass: document.body.className,
  };
  const heading = welcome.querySelector("h1");
  const suggestions = [...welcome.querySelectorAll(".suggestions button")];
  return {
    headingSize: Number.parseFloat(getComputedStyle(heading).fontSize),
    suggestionCount: suggestions.length,
    minSuggestionHeight: Math.min(...suggestions.map((button) => button.getBoundingClientRect().height)),
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    debug: window.__welcomeDebug,
  };
});
if (welcomeLayout.headingSize < 20 || welcomeLayout.suggestionCount !== 3 ||
    welcomeLayout.overflow) {
  throw new Error(`Witt mobile welcome layout failed: ${JSON.stringify(welcomeLayout)}`);
}
await page.screenshot({ path: "tests/ui-next-welcome-mobile.png", fullPage: false });
await page.locator("#messageInput").fill("新对话首次发送测试");
await page.locator("#sendButton").click();
if ((await page.evaluate(() => window.__createdConversationArgs.accessMode)) !== "workspace-write") {
  throw new Error("New conversation did not keep the selected access mode");
}
if ((await page.locator(".message.user.sending").count()) !== 1) {
  throw new Error("Sent message did not appear optimistically");
}
if (!(await page.locator("#sendButton").evaluate((node) => node.classList.contains("sending")))) {
  throw new Error("Send button did not switch to the rotating state");
}
await page.locator(".message.user.sending").waitFor({ state: "detached" });
await page.locator(".message.user").waitFor();
for (const viewport of [{ width: 360, height: 800 }, { width: 620, height: 900 }]) {
  await page.setViewportSize(viewport);
  const layout = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    composerVisible: document.querySelector(".composer")?.getBoundingClientRect().bottom <= innerHeight,
  }));
  if (layout.overflow || !layout.composerVisible) {
    throw new Error(`Responsive layout failed at ${viewport.width}px: ${JSON.stringify(layout)}`);
  }
}
await page.evaluate(() => {
  window.__xuanyuAuthenticated = true;
  window.__createdConversationArgs = null;
  window.DropVault.onCodexAccounts(JSON.stringify({
    accounts: [
      { id: "default", label: "Witt 默认账号", authenticated: true,
        account: { type: "chatgpt", planType: "plus" } },
      { id: "xuanyu", label: "子账号", authenticated: true,
        account: { type: "chatgpt", planType: "plus" } },
    ],
  }));
});
await page.setViewportSize({ width: 360, height: 800 });
await page.locator("#menuButton").click();
await page.locator("#codexAccountsButton").click();
await page.locator("#codexAccountSheet.open .codex-account-actions").first().waitFor();
await page.waitForTimeout(200);
const accountActionsLayout = await page.locator("#codexAccountSheet.open .codex-account-actions:visible").evaluateAll((actions) =>
  actions.map((action) => ({
    width: action.getBoundingClientRect().width,
    buttons: [...action.querySelectorAll("button")].map((button) => ({
      width: button.getBoundingClientRect().width,
      height: button.getBoundingClientRect().height,
      writingMode: getComputedStyle(button).writingMode,
    })),
  })));
if (!accountActionsLayout.length || accountActionsLayout.some((action) => action.width < 200 || action.buttons.some((button) =>
  button.width < 100 || button.height < 40 || button.writingMode !== "horizontal-tb"))) {
  throw new Error(`Codex account actions collapsed: ${JSON.stringify(accountActionsLayout)}`);
}
await page.screenshot({ path: "tests/ui-codex-accounts-mobile.png", fullPage: true });
await page.locator("[data-new-codex-chat='xuanyu']").click();
await page.waitForFunction(() => window.__createdConversationArgs?.codexProfile === "xuanyu");
const xuanyuConversation = await page.evaluate(() => window.__createdConversationArgs);
if (xuanyuConversation.workDir !== "/data/xuanyu-build-console") {
  throw new Error(`Xuanyu conversation used the wrong project: ${JSON.stringify(xuanyuConversation)}`);
}
await page.evaluate(() => {
  window.DropVault.onAuthStatus(JSON.stringify({
    initialized: true,
    authenticated: true,
    principal: {
      admin: false,
      label: "OPPO PHN110",
      codexProfiles: ["xuanyu"],
      unrestrictedModels: true,
    },
  }));
});
await page.waitForTimeout(80);
const ordinaryUserAdminEntries = await page.evaluate(() =>
  ["adminSettingsButton", "codexAccountsButton"].map((id) => {
    const node = document.getElementById(id);
    return {
      id,
      hidden: node.hidden,
      display: getComputedStyle(node).display,
    };
  }));
if (ordinaryUserAdminEntries.some((entry) => !entry.hidden || entry.display !== "none")) {
  throw new Error(`Ordinary user can see admin entries: ${JSON.stringify(ordinaryUserAdminEntries)}`);
}
// A full page reload clears the transient bridge map. The persisted stream must
// still expose the next explicit action for each completed workflow stage.
for (const [status, stage, sha, button] of [
  ["awaiting_commit_confirmation", "testing", null, "[data-workflow-prepare-commit]"],
  ["awaiting_deploy_confirmation", "pushing", "abcdef0123456789abcdef0123456789abcdef01",
    "[data-workflow-prepare-deploy]"],
]) {
  const persisted = structuredClone(conversation);
  persisted.workDir = "/opt/witt";
  persisted.gitBranch = "platform/personal-ai-ops";
  persisted.harnessId = "grok-build";
  persisted.messages[1].status = "completed";
  persisted.messages[1].stream.push({
    id: "persisted-development-job", kind: "development_workflow",
    jobId: "00000000-0000-4000-8000-000000000099",
    status, stage, sha, message: status,
  });
  await page.evaluate((id) => localStorage.setItem("wit_active_conversation", id), persisted.id);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.DropVault?.nativeReady === "function");
  await page.evaluate(() => window.DropVault.nativeReady({
    version: "2.2.16", cacheScope: "0123456789abcdef01234567",
  }));
  // The fake bridge sends its startup snapshot asynchronously. Let it finish,
  // then simulate the backend response carrying the persisted job stage.
  await page.waitForTimeout(180);
  await page.evaluate((snapshot) => {
    window.DropVault.onConversation(JSON.stringify({ conversation: snapshot }));
  }, persisted);
  await page.locator(".message.assistant").first().waitFor();
  await page.locator("#bootScreen").waitFor({ state: "hidden" });
  const process = page.locator(".completed-process").first();
  if (!(await process.evaluate((node) => node.open))) {
    await process.locator(":scope > summary").click();
  }
  const group = page.locator(".stream-action-group").first();
  if (!(await group.evaluate((node) => node.open))) {
    await group.locator(":scope > summary").click();
  }
  await page.locator(".stream-action.file").first().click();
  await page.waitForTimeout(350);
  if (!(await page.locator(button).count())) {
    const details = await page.evaluate(() => ({
      content: document.querySelector("#actionDetailContent")?.textContent?.slice(0, 700),
      admin: !document.querySelector("#adminSettingsButton")?.hidden,
      title: document.querySelector("#chatTitle")?.textContent,
    }));
    throw new Error(`Persisted ${status} action unavailable: ${JSON.stringify(details)}`);
  }
  await page.locator(button).waitFor();
  if (!(await page.locator("#actionDetailContent").textContent()).includes("web/app.js")) {
    throw new Error(`Persisted ${status} state lost the file diff after refresh`);
  }
  await page.locator("#closeActionDetail").evaluate((node) => node.click());
}
if (errors.length) throw new Error(`Browser errors: ${errors.join(" | ")}`);
await browser.close();
console.log("Witt chat UI check passed");
