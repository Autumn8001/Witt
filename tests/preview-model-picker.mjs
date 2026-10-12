import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(new URL("../backend/package.json", import.meta.url));
const { chromium } = require("playwright");

const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const cssNames = [
  "ui-system.css", "profile-overview.css", "component-interactions.css", "styles.css",
  "quota.css", "quota-fix.css", "reset-glow.css", "composer-aura.css", "composer-refine.css",
  "composer-transparency.css", "composer-overlay.css", "composer-spectra.css", "quota-layout.css",
  "quota-header-restore.css", "quota-confirm.css", "quota-compact.css", "drawer-motion.css",
  "quota-profile-motion.css", "usage-insight.css", "quota-spacing.css", "usage-ring-fit.css",
  "auth-gate.css", "approval-card.css", "approval-dock.css", "night-contrast.css", "witt-white.css",
  "browser-chatgpt.css", "conversation-type.css", "night-theme.css", "message-collapse.css",
  "chat-overflow-fix.css", "codex-accounts.css", "formula-code.css", "performance.css",
  "landscape.css", "lumora-global.css", "codex-model-picker.css", "chat-links.css",
  "completed-turn.css", "drawer-layout.css", "witt-next.css", "artifact-preview.css",
  "claude-app.css", "local-terminal.css", "customer-devices.css"
];
const cssFiles = new Map(cssNames.map((name) => {
  try { return [name, readFileSync(new URL(`../web/${name}`, import.meta.url), "utf8")]; }
  catch { return [name, ""]; }
}));
const js = readFileSync(new URL("../web/app-workspace-20260916-r3.js", import.meta.url), "utf8");
const profileOverviewJs = readFileSync(new URL("../web/profile-overview.js", import.meta.url), "utf8");
const customerDevicesJs = readFileSync(new URL("../web/customer-devices.js", import.meta.url), "utf8");
const browserBridgeJs = readFileSync(new URL("../web/browser-bridge.js", import.meta.url), "utf8");

const browser = await chromium.launch({ headless: true });

async function setupPage(viewport, { runtimeProfileFail = false } = {}) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: "https://wit.test" });

  await page.route("**/vault/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("version.json")) {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ frontendSha: "abcdef01" }) });
    }
    if (pathname.endsWith(".css")) {
      const name = pathname.split("/").pop();
      return route.fulfill({ contentType: "text/css", body: cssFiles.get(name) || "" });
    }
    if (pathname.endsWith("profile-overview.js")) return route.fulfill({ contentType: "application/javascript", body: profileOverviewJs });
    if (pathname.endsWith("customer-devices.js")) return route.fulfill({ contentType: "application/javascript", body: customerDevicesJs });
    if (pathname.endsWith("browser-bridge.js")) return route.fulfill({ contentType: "application/javascript", body: browserBridgeJs });
    if (pathname.endsWith(".js")) return route.fulfill({ contentType: "application/javascript", body: js });
    if (pathname.includes("/fonts/")) return route.fulfill({ status: 204 });
    return route.fulfill({ contentType: "text/html", body: html });
  });

  await page.route("**/vault-api/**", (route) => {
    const url = route.request().url();
    if (url.includes("/vault-api/version")) {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ backendSha: "abcdef01" }) });
    }
    if (url.includes("/vault-api/runtime/profiles")) {
      if (runtimeProfileFail) {
        return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Runtime unavailable" }) });
      }
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          profiles: [
            { id: "grok-build-standard", name: "Grok Build · 标准", model: "grok-4.7-high", reasoning: "high", harness: "grok-build" },
            { id: "codex-fast", name: "Codex · 快速响应", model: "gpt-6-sol", reasoning: "medium", harness: "codex" }
          ]
        })
      });
    }
    if (url.includes("/vault-api/servers/overview")) {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          cpu: { count: 8 },
          memory: { totalBytes: 34359738368, usedBytes: 12884901888 },
          uptimeSeconds: 86400,
          services: [{ name: "grok-runtime", status: "running" }, { name: "sqlite", status: "healthy" }],
          checkedAt: new Date().toISOString()
        })
      });
    }
    if (url.includes("/vault-api/chat/capabilities")) {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          models: [
            { id: "grok-4.7-high", displayName: "Grok 4.7 High", harness: "grok-build", reasoningEfforts: [{ id: "xhigh" }, { id: "high" }, { id: "medium" }, { id: "low" }] },
            { id: "gpt-6-sol", displayName: "Sol (GPT-6)", harness: "codex", reasoningEfforts: [{ id: "high" }, { id: "medium" }, { id: "low" }] }
          ],
          harness: {
            "grok-build": { available: true },
            codex: { available: true },
            "google-antigravity": { available: false }
          }
        })
      });
    }
    if (url.includes("/vault-api/remote-workspaces/options")) {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          devices: [{ device_id: "PC-ONLINE", device_label: "林工电脑", status: "online", roots: [{ root_alias: "workspace", display_path: "林工 · 网站项目" }], ready: true }],
          roots: []
        })
      });
    }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });

  await page.addInitScript(() => {
    localStorage.setItem("wit_model", "grok-4.7-high");
    localStorage.setItem("wit_reasoning", "high");
    localStorage.removeItem("wit_active_conversation");
  });

  await page.goto("https://wit.test/vault/index.html");
  await page.evaluate(() => {
    document.body.classList.add("web-browser");
    if (window.DropVault?.onAuthStatus) {
      window.DropVault.onAuthStatus(JSON.stringify({ authenticated: true, admin: true, principal: { admin: true }, clientMode: "browser" }));
    }
  });
  await page.waitForTimeout(600);
  return page;
}

// 场景 1：手机 390×844，普通对话展开快捷模型菜单
// 验证：单选层级卡片、选中态突出高亮、档位说明清晰、Runtime Profile 正常
{
  const page = await setupPage({ width: 390, height: 844 }, { runtimeProfileFail: false });
  await page.locator("#modelButton").click();
  await page.locator("#quickModelMenu").waitFor({ state: "visible" });
  await page.waitForTimeout(400);
  await page.screenshot({ path: "tests/preview-model-mobile-regular.png", fullPage: false });
  await page.close();
}

// 场景 2：手机 390×844，Runtime Profile 报错容灾
// 验证：绝无 "Failed to fetch"，展示友好中文说明与“重试读取”操作
{
  const page = await setupPage({ width: 390, height: 844 }, { runtimeProfileFail: true });
  await page.locator("#modelButton").click();
  await page.locator("#quickModelMenu").waitFor({ state: "visible" });
  await page.waitForTimeout(400);
  await page.screenshot({ path: "tests/preview-model-mobile-error-retry.png", fullPage: false });
  await page.close();
}

// 场景 3：手机 390×844，远程工作区会话锁定展示（快捷菜单 + 设置抽屉）
// 验证：顶部醒目锁定横幅、展示设备与范围、单选选项置为锁定状态
{
  const remoteConv = {
    id: "remote-conv-1",
    title: "林工电脑 · 网站项目",
    remoteWorkspace: {
      deviceId: "PC-ONLINE",
      deviceLabel: "林工电脑",
      rootAlias: "workspace",
      displayPath: "林工 · 网站项目",
      status: "ready"
    },
    workspace_device_id: "PC-ONLINE",
    workspace_device_label: "林工电脑",
    workspace_root_alias: "workspace",
    workspace_root_display_path: "林工 · 网站项目",
    workspace_binding_status: "ready",
    model: "grok-4.7-high",
    reasoning: "high",
    messages: [
      { id: "m1", role: "assistant", text: "已连接远程设备 **林工电脑** 并绑定受控项目目录 `林工 · 网站项目`。环境已锁定。" }
    ]
  };
  const page = await setupPage({ width: 390, height: 844 });
  // 注入已绑定的远程工作区会话
  await page.evaluate((c) => {
    window.DropVault?.onConversations?.(JSON.stringify({ conversations: [c] }));
    window.DropVault?.onConversation?.(JSON.stringify({ conversation: c }));
  }, remoteConv);
  await page.waitForTimeout(600);

  // 1. 快捷菜单中的锁定状态
  await page.locator("#modelButton").click();
  await page.locator("#quickModelMenu").waitFor({ state: "visible" });
  await page.waitForTimeout(400);
  await page.screenshot({ path: "tests/preview-model-mobile-remote-locked.png", fullPage: false });

  // 关闭快捷菜单，打开设置面板
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  await page.locator("#menuButton").click();
  await page.locator("#drawer.open").waitFor();
  await page.waitForTimeout(300);
  await page.locator("#runtimeSettingsButton").click();
  await page.locator("#settingsSheet.open").waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: "tests/preview-model-mobile-remote-settings-locked.png", fullPage: false });
  await page.close();
}

// 场景 4：手机 390×844，设置面板抽屉（普通对话首屏）
// 验证：模型双列显示不截断、智能程度、访问权限布局清晰
{
  const page = await setupPage({ width: 390, height: 844 });
  await page.locator("#menuButton").click();
  await page.locator("#drawer.open").waitFor();
  await page.waitForTimeout(300);
  await page.locator("#runtimeSettingsButton").click();
  await page.locator("#settingsSheet.open").waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: "tests/preview-model-mobile-settings-sheet.png", fullPage: false });

  // 场景 5：手机 390×844，设置面板滚动到底部
  // 验证：独立滚动，滚到最底部时内容完全露出，底栏绝不遮挡内容
  await page.locator(".settings-scroll").evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(300);
  await page.screenshot({ path: "tests/preview-model-mobile-settings-scrolled.png", fullPage: false });
  await page.close();
}

await browser.close();
console.log("ALL_PREVIEWS_GENERATED_SUCCESSFULLY");
