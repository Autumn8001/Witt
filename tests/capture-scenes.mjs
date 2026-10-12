import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(new URL("../backend/package.json", import.meta.url));
const { chromium } = require("playwright");

const prefix = process.argv[2] || "current";

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
    "claude-app.css", "local-terminal.css", "customer-devices.css", "chloe-autumn.css"
];
const cssFiles = new Map(cssNames.map((name) => {
  try { return [name, readFileSync(new URL(`../web/${name}`, import.meta.url), "utf8")]; }
  catch { return [name, ""]; }
}));
const js = readFileSync(new URL("../web/app-workspace-20260916-r3.js", import.meta.url), "utf8");
const profileOverviewJs = readFileSync(new URL("../web/profile-overview.js", import.meta.url), "utf8");
const customerDevicesJs = readFileSync(new URL("../web/customer-devices.js", import.meta.url), "utf8");
const browserBridgeJs = readFileSync(new URL("../web/browser-bridge.js", import.meta.url), "utf8");
const katexJs = readFileSync(new URL("../web/vendor/katex/katex.min.js", import.meta.url), "utf8");
const katexCss = readFileSync(new URL("../web/vendor/katex/katex.min.css", import.meta.url), "utf8");
const xtermJs = readFileSync(new URL("../web/vendor/xterm/xterm.js", import.meta.url), "utf8");
const xtermFitJs = readFileSync(new URL("../web/vendor/xterm/addon-fit.js", import.meta.url), "utf8");
const xtermWebLinksJs = readFileSync(new URL("../web/vendor/xterm/addon-web-links.js", import.meta.url), "utf8");
const xtermCss = readFileSync(new URL("../web/vendor/xterm/xterm.css", import.meta.url), "utf8");
const icon = readFileSync(new URL("../web/icon.svg", import.meta.url), "utf8");
const autumnBg = readFileSync(new URL("../web/assets/autumn-bg.jpg", import.meta.url));

const browser = await chromium.launch({ headless: true });

async function setupPage(viewport, theme = "light", initialConversations = [], activeId = null) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: "https://wit.test" });

  const convMap = new Map(initialConversations.map((c) => [c.id, c]));

  await page.route("**/vault/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("version.json")) {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ frontendSha: "abcdef0123456789" }) });
    }
    if (pathname.endsWith("autumn-bg.jpg")) {
      return route.fulfill({ contentType: "image/jpeg", body: autumnBg });
    }
    if (pathname.endsWith(".css")) {
      const name = pathname.split("/").pop();
      return route.fulfill({ contentType: "text/css", body: name === "katex.min.css" ? katexCss : (name === "xterm.css" ? xtermCss : (cssFiles.get(name) || "")) });
    }
    if (pathname.endsWith("xterm.js")) return route.fulfill({ contentType: "application/javascript", body: xtermJs });
    if (pathname.endsWith("addon-fit.js")) return route.fulfill({ contentType: "application/javascript", body: xtermFitJs });
    if (pathname.endsWith("addon-web-links.js")) return route.fulfill({ contentType: "application/javascript", body: xtermWebLinksJs });
    if (pathname.endsWith("profile-overview.js")) return route.fulfill({ contentType: "application/javascript", body: profileOverviewJs });
    if (pathname.endsWith("customer-devices.js")) return route.fulfill({ contentType: "application/javascript", body: customerDevicesJs });
    if (pathname.endsWith("browser-bridge.js")) return route.fulfill({ contentType: "application/javascript", body: browserBridgeJs });
    if (pathname.endsWith(".js")) return route.fulfill({ contentType: "application/javascript", body: pathname.endsWith("katex.min.js") ? katexJs : js });
    if (pathname.includes("/fonts/")) return route.fulfill({ status: 204 });
    if (pathname.endsWith(".svg")) return route.fulfill({ contentType: "image/svg+xml", body: icon });
    return route.fulfill({ contentType: "text/html", body: html });
  });

  const customerDeviceFixture = {
    devices: [
      { device_id: "PC-ONLINE", label: "林工的开发电脑", status: "online", hostname: "DEV-WIN11", agent_version: "0.2.0", last_seen: "2026-10-04T10:20:00Z", capabilities: ["system.hostname", "system.info", "filesystem.list", "filesystem.read", "screen.capture"], allowed_roots: ["workspace"] },
      { device_id: "PC-OFFLINE", label: "办公室电脑", status: "offline", hostname: "OFFICE-PC", agent_version: "0.2.0", last_seen: "2026-10-03T08:10:00Z", capabilities: ["system.hostname", "system.info", "filesystem.list", "filesystem.read", "screen.capture"], allowed_roots: ["workspace"] },
    ],
  };

  await page.route("**/vault-api/remote-workspaces/options", (route) => route.fulfill({
    contentType: "application/json", body: JSON.stringify({
      devices: customerDeviceFixture.devices.map((device) => ({
        device_id: device.device_id, device_label: device.label, customer_id: "customer-lin",
        status: device.status, roots: device.allowed_roots.map((root) => ({ root_alias: root, display_path: "林工 · 网站项目" })),
        ready: device.device_id === "PC-ONLINE"
      }))
    }),
  }));
  await page.route("**/vault-api/customer-devices", (route) => route.fulfill({
    contentType: "application/json", body: JSON.stringify(customerDeviceFixture),
  }));
  await page.route("**/vault-api/auth/status", (route) => route.fulfill({
    contentType: "application/json", body: JSON.stringify({ authenticated: true, admin: true, principal: { admin: true, label: "管理员" }, clientMode: "browser" }),
  }));
  await page.route("**/vault-api/chat/conversations**", (route) => {
    const url = route.request().url();
    if (url.includes("/chat/conversations/")) {
      const id = url.split("chat/conversations/")[1].split("?")[0].split("/")[0];
      const found = convMap.get(id);
      if (found) return route.fulfill({ contentType: "application/json", body: JSON.stringify(found) });
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ id, messages: [] }) });
    }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ conversations: initialConversations }) });
  });
  await page.route("**/vault-api/providers/cpa/quotas", (route) => route.fulfill({
    contentType: "application/json", body: JSON.stringify({ ok: true, models: [{ name: "grok-4.7-high", remaining: "100%", reset: "2h" }] }),
  }));
  await page.route("**/vault-api/providers/cpa/accounts", (route) => route.fulfill({
    contentType: "application/json", body: JSON.stringify({ accounts: [] }),
  }));
  await page.route("**/vault-api/chat/capabilities", (route) => route.fulfill({
    contentType: "application/json", body: JSON.stringify({
      models: [{ id: "grok-4.7-high", name: "Grok 4.7 High", harness: "grok-build", reasoning: ["low", "medium", "high", "ultra"] }],
      harnesses: [{ id: "grok-build", name: "Grok Build" }],
    }),
  }));

  await page.addInitScript(({ theme, activeId }) => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.themeMode = theme;
    localStorage.setItem("wit_theme", theme);
    if (activeId) {
      localStorage.setItem("wit_active_conversation", activeId);
    } else {
      localStorage.removeItem("wit_active_conversation");
    }
  }, { theme, activeId });

  await page.goto("https://wit.test/vault/index.html");
  await page.evaluate(() => {
    document.body.classList.add("web-browser");
    if (window.DropVault?.onAuthStatus) {
      window.DropVault.onAuthStatus(JSON.stringify({ authenticated: true, admin: true, principal: { admin: true, label: "管理员" }, clientMode: "browser" }));
    }
  });
  await page.waitForTimeout(800);
  return page;
}

const defaultConversations = [
  { id: "conv-1", title: "翻译对话", updatedAt: new Date().toISOString() },
  { id: "conv-2", title: "请尝试 luna_worker 创建一...", updatedAt: new Date(Date.now() - 3600000).toISOString() },
  { id: "conv-3", title: "部署服务的最佳实践", updatedAt: new Date(Date.now() - 86400000).toISOString() },
  { id: "conv-4", title: "数据库设计方案讨论", updatedAt: new Date(Date.now() - 86400000 * 1.2).toISOString() },
  { id: "conv-5", title: "前端性能优化建议", updatedAt: new Date(Date.now() - 86400000 * 1.5).toISOString() },
];

// 场景 0：设计稿原生尺寸 1672 × 941，首页（用于 1:1 绝对像素对比）
{
  const page = await setupPage({ width: 1672, height: 941 }, "light", defaultConversations);
  await page.evaluate(() => {
    const firstRow = document.querySelector(".conversation-row");
    if (firstRow) firstRow.classList.add("active");
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `tests/${prefix}-1-target-1672x941.png`, fullPage: false });
  await page.close();
}

// 场景 1：标准桌面 1440 × 900，首页
{
  const page = await setupPage({ width: 1440, height: 900 }, "light", defaultConversations);
  await page.screenshot({ path: `tests/${prefix}-1-desktop-home.png`, fullPage: false });
  await page.close();
}

// 场景 1b：宽屏桌面 1920 × 1080，首页
{
  const page = await setupPage({ width: 1920, height: 1080 }, "light", defaultConversations);
  await page.screenshot({ path: `tests/${prefix}-1-desktop-1080p.png`, fullPage: false });
  await page.close();
}

// 场景 2：桌面 1440 × 900，展开相关设置
{
  const page = await setupPage({ width: 1440, height: 900 }, "light", defaultConversations);
  await page.locator("#runtimeSettingsButton").click();
  await page.locator("#settingsSheet.open").waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `tests/${prefix}-2-desktop-settings.png`, fullPage: false });
  await page.close();
}

// 场景 3：手机 390 × 844，首页
{
  const page = await setupPage({ width: 390, height: 844 }, "light", defaultConversations);
  await page.screenshot({ path: `tests/${prefix}-3-mobile-home.png`, fullPage: false });
  await page.close();
}

// 场景 4：手机 390 × 844，侧边栏展开
{
  const page = await setupPage({ width: 390, height: 844 }, "light", defaultConversations);
  await page.locator("#menuButton").click();
  await page.locator("#drawer.open").waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `tests/${prefix}-4-mobile-drawer.png`, fullPage: false });
  await page.close();
}

// 场景 5：手机 390 × 844，模型选择展开
{
  const page = await setupPage({ width: 390, height: 844 }, "light");
  await page.locator("#modelButton").click();
  await page.locator("#quickModelMenu").waitFor({ state: "visible" });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `tests/${prefix}-5-mobile-model-picker.png`, fullPage: false });
  await page.close();
}

// 场景 6：手机 390 × 844，远程工作区已绑定
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
      { id: "m1", role: "assistant", text: "已连接远程设备 **林工电脑** 并绑定受控项目目录 `林工 · 网站项目`。可以开始执行代码分析与开发任务。" }
    ]
  };

  const page = await setupPage({ width: 390, height: 844 }, "light");
  await page.evaluate((c) => {
    window.DropVault?.onConversations?.(JSON.stringify({ conversations: [c] }));
    window.DropVault?.onConversation?.(JSON.stringify({ conversation: c }));
  }, remoteConv);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `tests/${prefix}-6-mobile-remote-bound.png`, fullPage: false });
  await page.close();
}

// 场景 7：手机 390 × 844，长对话
{
  const longConv = {
    id: "long-conv-1",
    title: "长对话滚动与输入测试",
    model: "grok-4.7-high",
    reasoning: "high",
    messages: Array.from({ length: 8 }, (_, i) => ({
      id: `msg-${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      text: i % 2 === 0
        ? `这是第 ${i + 1} 轮用户指令：请重构当前模块的前端布局，并确保各端兼容性与触控面积。
测试换行与消息气泡排版效果。`
        : `这是第 ${i + 1} 轮助手响应：已完成第 ${i + 1} 阶段的审查与测试，各项指标均已达到预期。输入框在页面底部保持浮动对齐，长消息列表滚动平滑无阻。`,
      createdAt: new Date(Date.now() - (8 - i) * 60000).toISOString()
    }))
  };

  const page = await setupPage({ width: 390, height: 844 }, "light");
  await page.evaluate((c) => {
    window.DropVault?.onConversations?.(JSON.stringify({ conversations: [c] }));
    window.DropVault?.onConversation?.(JSON.stringify({ conversation: c }));
  }, longConv);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `tests/${prefix}-7-mobile-long-chat.png`, fullPage: false });
  await page.close();
}

// 场景 8：手机 390 × 844，深色模式
{
  const page = await setupPage({ width: 390, height: 844 }, "dark");
  await page.screenshot({ path: `tests/${prefix}-8-mobile-dark-home.png`, fullPage: false });
  await page.close();
}

await browser.close();
console.log(`Captured all 8 scenes for prefix: ${prefix}`);
