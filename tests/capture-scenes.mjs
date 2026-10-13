import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../backend/package.json", import.meta.url));
const { chromium } = require("playwright");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const mode = args.includes("--audit") ? "audit" : args.includes("--baseline") ? "baseline" : "legacy";
const prefix = args.find((value) => !value.startsWith("--")) || "current";
const sceneFilter = args.find((value) => value.startsWith("--scene="))?.slice("--scene=".length) || "";
const artifactRoot = path.join(root, "tests", "artifacts", "chloe-system", prefix);
const screenshotRoot = path.join(artifactRoot, "screenshots");
const telemetryByPage = new WeakMap();
const missingStaticFiles = new Set();

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
const cssFiles = new Map(cssNames.map((name) => [name, readFileSync(new URL(`../web/${name}`, import.meta.url), "utf8")]));
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
const requestedBackgroundPath = "assets/chloe-autumn-landscape.webp";

const browser = await chromium.launch({ headless: true });

async function setupPage(viewport, theme = "light", initialConversations = [], activeId = null, settle = true, delayedApi = []) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  const telemetry = { pageErrors: [], failedStatic: [], consoleErrors: [], apiMocks: [] };
  telemetryByPage.set(page, telemetry);
  page.setDefaultTimeout(1800);
  page.on("pageerror", (error) => telemetry.pageErrors.push({ message: error.message, stack: error.stack }));
  page.on("console", (message) => { if (message.type() === "error") telemetry.consoleErrors.push(message.text()); });
  page.on("requestfailed", (request) => {
    if (new URL(request.url()).pathname.startsWith("/vault/")) telemetry.failedStatic.push({ url: request.url(), error: request.failure()?.errorText || "request failed" });
  });
  page.on("response", (response) => {
    const pathname = new URL(response.url()).pathname;
    if (pathname.startsWith("/vault/") && response.status() >= 400) telemetry.failedStatic.push({ url: response.url(), error: `HTTP ${response.status()}` });
  });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: "https://wit.test" });

  const convMap = new Map(initialConversations.map((c) => [c.id, c]));

  await page.route("**/vault-api/**", async (route) => {
    telemetry.apiMocks.push({ method: route.request().method(), path: new URL(route.request().url()).pathname, fixture: "generic-empty" });
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.route("**/vault-api/chat-images/**", (route) => route.fulfill({ contentType: "image/svg+xml", body: icon }));
  await page.route("**/vault/**", async (route) => {
    const pathname = decodeURIComponent(new URL(route.request().url()).pathname);
    if (pathname.endsWith("/version.json")) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ frontendSha: "abcdef0123456789abcdef0123456789abcdef01" }) });
    const relative = (pathname === "/vault" || pathname === "/vault/" ? "index.html" : pathname.replace(/^\/vault\//, "")).replaceAll("/", path.sep);
    const file = path.resolve(root, "web", relative);
    if (!file.startsWith(path.resolve(root, "web") + path.sep) && file !== path.resolve(root, "web", "index.html")) {
      telemetry.failedStatic.push({ url: route.request().url(), error: "path outside web root" });
      return route.fulfill({ status: 404, body: "not found" });
    }
    if (!existsSync(file)) {
      missingStaticFiles.add(relative.replaceAll(path.sep, "/"));
      telemetry.failedStatic.push({ url: route.request().url(), error: "missing local file" });
      return route.fulfill({ status: 404, body: "missing local asset" });
    }
    const ext = path.extname(file).toLowerCase();
    const contentType = ({ ".html": "text/html", ".css": "text/css", ".js": "application/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".json": "application/json" })[ext] || "application/octet-stream";
    return route.fulfill({ contentType, body: readFileSync(file) });
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
    if (delayedApi.includes("conversation-list") && !url.includes("/chat/conversations/")) {
      return new Promise((resolve) => setTimeout(() => resolve(route.fulfill({ contentType: "application/json", body: JSON.stringify({ conversations: initialConversations }) })), 8000));
    }
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
    if (window.top !== window) return;
    localStorage.setItem("wit_theme", theme);
    if (activeId) {
      localStorage.setItem("wit_active_conversation", activeId);
    } else {
      localStorage.removeItem("wit_active_conversation");
    }
  }, { theme, activeId });

  await page.goto("https://wit.test/vault/index.html");
  await page.evaluate(({ theme }) => {
    document.body.classList.add("web-browser");
    if (theme) {
      document.documentElement.dataset.theme = theme;
      document.documentElement.dataset.themeMode = theme;
    }
    if (window.DropVault?.onAuthStatus) {
      window.DropVault.onAuthStatus(JSON.stringify({ authenticated: true, admin: true, principal: { admin: true, label: "管理员" }, clientMode: "browser" }));
    }
  }, { theme });
  await page.evaluate(async (backgroundPath) => {
    await document.fonts.ready;
    const background = new Image();
    background.src = `/vault/${backgroundPath}`;
    try { await background.decode(); window.__auditBackground = { ok: true, width: background.naturalWidth, height: background.naturalHeight }; }
    catch (error) { window.__auditBackground = { ok: false, error: error.message, src: background.src }; }
  }, requestedBackgroundPath);
  if (settle) await page.waitForTimeout(800);
  return page;
}

const defaultConversations = [
  { id: "conv-1", title: "翻译对话", updatedAt: new Date().toISOString() },
  { id: "conv-2", title: "请尝试 luna_worker 创建一...", updatedAt: new Date(Date.now() - 3600000).toISOString() },
  { id: "conv-3", title: "部署服务的最佳实践", updatedAt: new Date(Date.now() - 86400000).toISOString() },
  { id: "conv-4", title: "数据库设计方案讨论", updatedAt: new Date(Date.now() - 86400000 * 1.2).toISOString() },
  { id: "conv-5", title: "前端性能优化建议", updatedAt: new Date(Date.now() - 86400000 * 1.5).toISOString() },
];

if (mode === "legacy") {
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

// 场景 1c：中窄屏桌面 1024 × 768，首页
{
  const page = await setupPage({ width: 1024, height: 768 }, "light", defaultConversations);
  await page.screenshot({ path: `tests/${prefix}-1-desktop-1024x768.png`, fullPage: false });
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
}

const auditResults = [];
const fixtureLabel = "MOCK: local Playwright fixtures and DropVault callbacks; no production API or credentials";
const primaryCombinations = [
  { label: "desktop-light", viewport: { width: 1440, height: 900 }, theme: "light" },
  { label: "desktop-dark", viewport: { width: 1440, height: 900 }, theme: "dark" },
  { label: "mobile-light", viewport: { width: 390, height: 844 }, theme: "light" },
  { label: "mobile-dark", viewport: { width: 390, height: 844 }, theme: "dark" },
];
const staticHtmlCssOrder = [...html.matchAll(/<link\b(?=[^>]*rel=["']stylesheet["'])[^>]*href=["']([^"']+)["'][^>]*>/gi)].map((match) => match[1]);

async function openDrawerEntry(page, id) {
  const mobileMenuVisible = await page.locator("#menuButton").isVisible().catch(() => false);
  if (mobileMenuVisible && !(await page.locator("#drawer").evaluate((node) => node.classList.contains("open")))) {
    await page.locator("#menuButton").click();
    await page.locator("#drawer.open").waitFor();
  }
  await page.locator(`#${id}`).click();
}

async function inspectPage(page, scene, category, viewport, theme, status) {
  await page.waitForTimeout(180);
  const background = await page.evaluate(() => window.__auditBackground || null);
  const metrics = await page.evaluate(() => {
    const viewport = { width: innerWidth, height: innerHeight };
    const overflow = { documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, viewportWidth: innerWidth };
    const clipped = [];
    const occluded = [];
    const targets = [...document.querySelectorAll("button, input, textarea, select, [role=button], a[href]")];
    for (const node of targets) {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      if (node.closest('[aria-hidden="true"], [hidden]') || style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0 || rect.width < 1 || rect.height < 1) continue;
      const insideViewport = rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight;
      if (!insideViewport) continue;
      let ancestor = node.parentElement;
      while (ancestor && ancestor !== document.body) {
        const cs = getComputedStyle(ancestor);
        const ar = ancestor.getBoundingClientRect();
        if (/(hidden|clip|auto|scroll)/.test(`${cs.overflow} ${cs.overflowX} ${cs.overflowY}`) &&
            (rect.left < ar.left - 1 || rect.right > ar.right + 1 || rect.top < ar.top - 1 || rect.bottom > ar.bottom + 1)) {
          clipped.push({ target: node.id || node.getAttribute("aria-label") || node.textContent.trim().slice(0, 36), ancestor: ancestor.id || ancestor.className?.toString().slice(0, 50) });
          break;
        }
        ancestor = ancestor.parentElement;
      }
      const x = Math.min(innerWidth - 1, Math.max(0, rect.left + rect.width / 2));
      const y = Math.min(innerHeight - 1, Math.max(0, rect.top + rect.height / 2));
      const hit = document.elementFromPoint(x, y);
      if (hit && hit !== node && !node.contains(hit) && !hit.contains(node)) {
        occluded.push({ target: node.id || node.getAttribute("aria-label") || node.textContent.trim().slice(0, 36), by: hit.id || hit.className?.toString().slice(0, 50) || hit.tagName });
      }
    }
    const parse = (color) => {
      const values = color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
      return values ? color.startsWith("color(srgb ") ? values.map((v) => v * 255) : values : null;
    };
    const luminance = (rgb) => rgb.map((value) => { const c = value / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
    const contrast = [];
    const textNodes = [...document.querySelectorAll("h1,h2,h3,h4,p,label,button,strong,.conversation-row,.workspace-entry,.composer-hint,.sheet-head small,.settings-section-head small")];
    for (const node of textNodes) {
      const text = node.textContent.trim();
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      if (!text || rect.width < 2 || rect.height < 2 || rect.bottom < 0 || rect.top > innerHeight || Number(style.opacity) < .45 || parseFloat(style.fontSize) < 12) continue;
      if (node.closest("svg,[aria-hidden=true],button:disabled,[disabled]")) continue;
      const hit = document.elementFromPoint(Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2)), Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2)));
      if (hit && hit !== node && !node.contains(hit) && !hit.contains(node)) continue;
      let surface = node;
      let bg = null;
      while (surface && surface !== document.documentElement) {
        const cs = getComputedStyle(surface);
        if (cs.backgroundImage !== "none") { bg = null; break; }
        const candidate = parse(cs.backgroundColor);
        if (candidate && cs.backgroundColor !== "rgba(0, 0, 0, 0)") { bg = candidate; break; }
        surface = surface.parentElement;
      }
      if (!bg) continue;
      const fg = parse(style.color);
      if (!fg) continue;
      const ratio = (Math.max(luminance(fg), luminance(bg)) + .05) / (Math.min(luminance(fg), luminance(bg)) + .05);
      if (ratio < 4.5 && !(parseFloat(style.fontSize) >= 18 || parseFloat(style.fontSize) >= 14 && Number(style.fontWeight) >= 700)) {
        contrast.push({ text: text.slice(0, 64), ratio: Number(ratio.toFixed(2)), selector: node.id ? `#${node.id}` : node.tagName.toLowerCase() });
      }
    }
    const stylesheets = [...document.querySelectorAll('link[rel="stylesheet"]')].map((link) => ({ href: link.getAttribute("href"), loaded: Boolean(link.sheet) }));
    return { viewport, overflow, clipped, occluded: occluded.slice(0, 40), contrast: contrast.slice(0, 60), stylesheets };
  });
  const telemetry = telemetryByPage.get(page);
  const result = { scene, category, viewport, theme, status, fixture: fixtureLabel, screenshot: `${scene}--${viewport.width}x${viewport.height}--${theme}--${status}.png`, background, metrics, ...telemetry };
  await page.screenshot({ path: path.join(screenshotRoot, result.screenshot), fullPage: false });
  auditResults.push(result);
  return result;
}

if (mode !== "legacy") {
  mkdirSync(screenshotRoot, { recursive: true });
  const runScene = async ({ scene, category, status = "ready", combos = [primaryCombinations[0]], conversations = [], delayedApi = [], setup }) => {
    if (sceneFilter && !scene.includes(sceneFilter)) return;
    for (const combo of combos) {
      const page = await setupPage(combo.viewport, combo.theme, conversations, conversations[0]?.id || null, true, delayedApi);
      try {
        if (setup) await setup(page);
        await inspectPage(page, scene, category, combo.viewport, combo.theme, status);
      } catch (error) {
        auditResults.push({ scene, category, viewport: combo.viewport, theme: combo.theme, status: "blocked", fixture: fixtureLabel, error: error.message, ...telemetryByPage.get(page) });
      } finally { await page.close(); }
    }
  };

  const homeSizes = [
    [1672, 941], [1440, 900], [1920, 1080], [1024, 768], [390, 844],
  ];
  for (const [width, height] of homeSizes) {
    const combo = { viewport: { width, height }, theme: "light" };
    await runScene({ scene: `home-${width}`, category: "home", combos: [combo] });
  }
  await runScene({ scene: "conversation-empty", category: "conversation", status: "no conversations fixture", combos: [primaryCombinations[0], primaryCombinations[2]], conversations: [] });
  await runScene({ scene: "boot-loading", category: "loading", status: "conversation-list API held for 8s by fixture", combos: [primaryCombinations[0], primaryCombinations[2]], delayedApi: ["conversation-list"] });
  for (const combo of primaryCombinations) await runScene({ scene: "home-theme-matrix", category: "home", combos: [combo] });
  await runScene({ scene: "settings-runtime-harness-provider", category: "model-runtime", combos: primaryCombinations, setup: (page) => openDrawerEntry(page, "runtimeSettingsButton") });
  await runScene({ scene: "profile-quota", category: "usage", combos: primaryCombinations, setup: (page) => openDrawerEntry(page, "profileButton") });
  await runScene({ scene: "workspace-projects-servers", category: "workspace", combos: primaryCombinations, setup: async (page) => {
    await openDrawerEntry(page, "workspaceOverviewButton");
    await page.evaluate(() => window.DropVault?.onWorkspaceOverview?.(JSON.stringify({
      projects: [{ name: "审计项目", workDir: "/fixtures/audit-project", status: "available", description: "Playwright 隔离 fixture" }],
      servers: [{ name: "测试服务器", status: "active", role: "fixture only" }],
      services: [{ name: "Provider fixture", status: "connected", description: "模拟状态" }], connections: [], checkedAt: "2026-10-13T00:00:00Z",
    })));
  } });
  await runScene({ scene: "remote-devices", category: "remote", combos: primaryCombinations, setup: (page) => openDrawerEntry(page, "customerDevicesButton") });
  await runScene({ scene: "device-management", category: "admin", combos: [primaryCombinations[0], primaryCombinations[3]], setup: (page) => openDrawerEntry(page, "adminSettingsButton") });
  await runScene({ scene: "codex-accounts", category: "accounts", combos: [primaryCombinations[0], primaryCombinations[2]], setup: (page) => openDrawerEntry(page, "codexAccountsButton") });
  await runScene({ scene: "login-activation", category: "auth", status: "signed-out fixture", combos: [primaryCombinations[0], primaryCombinations[2]], setup: async (page) => page.evaluate(() => window.DropVault?.onAuthStatus?.(JSON.stringify({ initialized: true, authenticated: false }))) });
  await runScene({ scene: "attachment-menu", category: "composer", combos: primaryCombinations, setup: (page) => page.locator("#attachButton").click() });
  await runScene({ scene: "project-picker", category: "workspace", combos: [primaryCombinations[0], primaryCombinations[3]], setup: async (page) => { await page.locator("#attachButton").click(); await page.locator("#projectButton").click(); } });
  await runScene({ scene: "model-runtime-picker", category: "model-runtime", combos: primaryCombinations, setup: (page) => page.locator("#modelButton").click() });
  await runScene({ scene: "conversation-menu", category: "conversation", combos: primaryCombinations, conversations: defaultConversations, setup: (page) => page.locator("#chatMoreButton").click() });
  await runScene({ scene: "archive-confirmation", category: "conversation", status: "confirmation only; not submitted", combos: [primaryCombinations[0], primaryCombinations[2]], conversations: defaultConversations, setup: async (page) => { await page.locator("#chatMoreButton").click(); await page.locator("#moreArchiveButton").click(); } });
  const contentConversation = {
    id: "audit-rich-conversation", title: "审计 Markdown 与任务状态", model: "grok-4.7-high", reasoning: "high", busy: false,
    messages: [
      { id: "u-long", role: "user", text: "长内容布局校验。".repeat(160), status: "completed", attachments: [] },
      { id: "a-rich", role: "assistant", text: "Markdown、表格、代码块和行内代码：\n\n| 状态 | 结果 |\n| --- | --- |\n| Mock API | 隔离 |\n\n```js\nconst audit = true;\n```", status: "completed", attachments: [], stream: [{ id: "rich-final", kind: "message", phase: "final_answer", text: "Markdown、表格、代码块和行内代码：\n\n| 状态 | 结果 |\n| --- | --- |\n| Mock API | 隔离 |\n\n```js\nconst audit = true;\n```", status: "completed" }] },
    ],
  };
  await runScene({ scene: "chat-markdown-code-long", category: "chat", combos: primaryCombinations, conversations: [contentConversation], setup: async (page) => page.evaluate((c) => window.DropVault?.onConversation?.(JSON.stringify({ conversation: c })), contentConversation) });
  const pendingConversation = {
    id: "audit-pending-conversation", title: "任务等待确认", model: "grok-4.7-high", reasoning: "high", busy: true,
    messages: [{ id: "pending-msg", role: "assistant", text: "任务正在等待本地确认。", status: "running", attachments: [], stream: [{ id: "pending-approval", kind: "approval", approvalId: "audit-approval", approvalType: "command", status: "pending", title: "确认测试命令？", reason: "只显示审批 UI，不提交选择。", command: "printf 'fixture'", cwd: "/fixtures", approvalOptions: [{ id: "once", label: "允许一次", description: "mock", tone: "accepted" }, { id: "deny", label: "拒绝", description: "mock", tone: "declined" }] }] }],
  };
  await runScene({ scene: "task-pending-approval", category: "task-status", status: "pending; decision not submitted", combos: primaryCombinations, conversations: [pendingConversation], setup: async (page) => page.evaluate((c) => window.DropVault?.onConversation?.(JSON.stringify({ conversation: c })), pendingConversation) });
  await runScene({ scene: "task-error-toast", category: "task-status", status: "error callback fixture", combos: [primaryCombinations[0], primaryCombinations[2]], setup: async (page) => page.evaluate(() => window.DropVault?.onMessageSendError?.("审计模拟错误：服务暂不可用")) });
  const imageConversation = { id: "audit-image", title: "附件预览", messages: [{ id: "image-msg", role: "assistant", text: "测试图片附件。", attachments: [], images: [{ id: "11111111-1111-4111-8111-111111111111", name: "fixture.png", mimeType: "image/png", size: 64, createdAt: new Date().toISOString() }], stream: [{ id: "image-entry", kind: "image", imageId: "11111111-1111-4111-8111-111111111111", name: "fixture.png", mimeType: "image/png", status: "completed" }] }] };
  await runScene({ scene: "attachment-preview", category: "attachments", status: "fixture image; preview only", combos: [primaryCombinations[0], primaryCombinations[2]], conversations: [imageConversation], setup: async (page) => {
    await page.evaluate((c) => window.DropVault?.onConversation?.(JSON.stringify({ conversation: c })), imageConversation);
    const preview = page.locator(".inline-image").first();
    await preview.waitFor({ state: "visible", timeout: 1500 });
    await preview.click();
  } });
  const artifactConversation = { id: "audit-artifact", title: "Artifact fixture", messages: [{ id: "artifact-msg", role: "assistant", text: "已生成隔离预览。", status: "completed", attachments: [], artifacts: [{ id: "audit-artifact-id", name: "审计预览.html", mimeType: "text/html", previewToken: "audit-preview-token" }], stream: [{ id: "artifact-handoff", kind: "artifact", artifactId: "audit-artifact-id", name: "审计预览.html", previewToken: "audit-preview-token", status: "completed" }] }] };
  await runScene({ scene: "artifact-workspace", category: "artifact", status: "fixture artifact; no external source", combos: [primaryCombinations[0], primaryCombinations[2]], conversations: [artifactConversation], setup: async (page) => {
    await page.route("**/vault-api/chat/artifact-previews/**", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ url: "data:text/html,%3Cmain%3EAudit%20fixture%3C%2Fmain%3E" }) }));
    await page.evaluate((c) => window.DropVault?.onConversation?.(JSON.stringify({ conversation: c })), artifactConversation);
    const handoff = page.locator(".artifact-handoff, [data-artifact='audit-artifact-id']").first();
    await handoff.waitFor({ state: "visible", timeout: 1500 });
    await handoff.click();
  } });

  for (const [width, height] of homeSizes) {
    const result = auditResults.find((entry) => entry.scene === `home-${width}`);
    if (result) result.viewportName = `${width}x${height}`;
  }
  const cssOrder = staticHtmlCssOrder.map((href) => {
    const relative = decodeURIComponent(new URL(href, "https://wit.test").pathname).replace(/^\/vault\//, "");
    return { href, file: relative, exists: existsSync(path.join(root, "web", relative)) };
  });
  const payload = {
    generatedAt: new Date().toISOString(), mode, prefix, fixture: fixtureLabel,
    requestedBackground: { path: requestedBackgroundPath, exists: existsSync(path.join(root, "web", requestedBackgroundPath)) },
    cssOrder, missingStaticFiles: [...missingStaticFiles].sort(), scenes: auditResults,
    summary: { captures: auditResults.filter((entry) => entry.screenshot).length, blocked: auditResults.filter((entry) => entry.status === "blocked").length, pageErrors: auditResults.flatMap((entry) => entry.pageErrors || []), staticFailures: auditResults.flatMap((entry) => entry.failedStatic || []), lowContrastSamples: auditResults.reduce((sum, entry) => sum + (entry.metrics?.contrast?.length || 0), 0) },
  };
  writeFileSync(path.join(artifactRoot, "audit.json"), `${JSON.stringify(payload, null, 2)}\n`);
  const galleryItems = auditResults.filter((entry) => entry.screenshot).map((entry) => `<article data-category="${entry.category}" data-viewport="${entry.viewport.width}x${entry.viewport.height}" data-theme="${entry.theme}" data-status="${entry.status}"><a href="screenshots/${entry.screenshot}"><img loading="lazy" src="screenshots/${entry.screenshot}" alt="${entry.scene} ${entry.viewport.width}x${entry.viewport.height} ${entry.theme}"></a><p><strong>${entry.scene}</strong><span>${entry.category} · ${entry.viewport.width}×${entry.viewport.height} · ${entry.theme} · ${entry.status}</span></p></article>`).join("\n");
  writeFileSync(path.join(artifactRoot, "gallery.html"), `<!doctype html><meta charset="utf-8"><title>Chloe UI audit · ${prefix}</title><style>body{font:14px system-ui;margin:24px;background:#f4f1e8;color:#25251f}header{position:sticky;top:0;background:#fff;padding:16px;z-index:1;border:1px solid #ddd}select{margin-right:12px;padding:8px}main{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px;margin-top:20px}article{background:#fff;border:1px solid #dedbd2;border-radius:8px;overflow:hidden}img{display:block;width:100%;aspect-ratio:16/9;object-fit:cover}article p{display:flex;justify-content:space-between;gap:12px;padding:0 12px}article span{color:#62645b;text-align:right} @media(max-width:600px){body{margin:10px}main{grid-template-columns:1fr}}</style><header><label>类别 <select data-filter="category"><option value="">全部</option>${[...new Set(auditResults.map((item)=>item.category))].map((v)=>`<option>${v}</option>`).join("")}</select></label><label>视口 <select data-filter="viewport"><option value="">全部</option>${[...new Set(auditResults.filter((x)=>x.screenshot).map((item)=>`${item.viewport.width}x${item.viewport.height}`))].map((v)=>`<option>${v}</option>`).join("")}</select></label><label>主题 <select data-filter="theme"><option value="">全部</option><option>light</option><option>dark</option></select></label><label>状态 <select data-filter="status"><option value="">全部</option>${[...new Set(auditResults.map((item)=>item.status))].map((v)=>`<option>${v}</option>`).join("")}</select></label><span>${payload.summary.captures} captures · fixtures only</span></header><main>${galleryItems}</main><script>document.querySelectorAll('[data-filter]').forEach(s=>s.addEventListener('change',()=>document.querySelectorAll('article').forEach(a=>a.hidden=[...document.querySelectorAll('[data-filter]')].some(f=>f.value&&a.dataset[f.dataset.filter]!==f.value))))</script>`);
  const describeErrors = (entry) => (entry.pageErrors || []).map((error) => error.message || error).join("; ");
  const report = `# Chloe UI audit report\n\n- Run: \`${prefix}\` (${mode}), ${payload.generatedAt}.\n- Evidence: [gallery](../tests/artifacts/chloe-system/${prefix}/gallery.html), [machine JSON](../tests/artifacts/chloe-system/${prefix}/audit.json). All API/UI records are local mock fixtures; no production endpoint, credential, deletion, push, or deployment was exercised.\n- Captures: ${payload.summary.captures}; blocked scenes: ${payload.summary.blocked}; page errors: ${payload.summary.pageErrors.length}; static asset failures: ${payload.summary.staticFailures.length}; sampled low-contrast text findings: ${payload.summary.lowContrastSamples}.\n- Required background: \`/vault/${requestedBackgroundPath}\` ${payload.requestedBackground.exists ? "exists on disk" : "MISSING on disk; background decode is recorded as failed"}.\n- Home viewports: 1672×941, 1440×900, 1920×1080, 1024×768, 390×844; theme matrix: desktop/mobile × light/dark.\n- Known access gaps: local SSH/terminal depends on native device integration and is not invoked; provider OAuth/login is not completed; archive confirmation is opened but not submitted; approval decisions and remote workspace creation are not submitted; credentials and destructive actions remain untested.\n- Contrast samples skip text under 12px, disabled/transparent/icon content, and surfaces with image/gradient backgrounds; remaining findings are review signals, not an automatic WCAG verdict.\n\n## Scene results\n\n| Scene | Category | View | Theme | Status | Errors / findings |\n|---|---|---:|---|---|---|\n${auditResults.map((entry)=>`| ${entry.scene} | ${entry.category} | ${entry.viewport.width}×${entry.viewport.height} | ${entry.theme} | ${entry.status} | ${(entry.error || describeErrors(entry) || entry.failedStatic?.map((item)=>item.error).join("; ") || `overflow ${entry.metrics?.overflow?.documentWidth}/${entry.viewport.width}; clipped ${entry.metrics?.clipped?.length || 0}; occluded ${entry.metrics?.occluded?.length || 0}; contrast ${entry.metrics?.contrast?.length || 0}`).replaceAll("|", "\\|")} |`).join("\n")}\n\n## CSS load order\n\n${cssOrder.map((item, index)=>`${index+1}. ${item.exists ? "loaded locally" : "MISSING"}: \`${item.file}\``).join("\n")}\n`;
  writeFileSync(path.join(root, "docs", "ui-audit-report.md"), report);
  console.log(`Chloe ${mode} complete: ${payload.summary.captures} captures; ${payload.summary.blocked} blocked; assets missing ${payload.summary.staticFailures.length}. Gallery: ${path.relative(root, path.join(artifactRoot, "gallery.html"))}`);
}

await browser.close();
if (mode === "legacy") console.log(`Captured all 8 scenes for prefix: ${prefix}`);
