import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const require = createRequire(path.join(root, "backend", "package.json"));
const { chromium } = require("playwright");

const html = readFileSync(path.join(root, "web", "index.html"), "utf8");
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
  try { return [name, readFileSync(path.join(root, "web", name), "utf8")]; }
  catch { return [name, ""]; }
}));
const js = readFileSync(path.join(root, "web", "app-workspace-20260916-r3.js"), "utf8");
const profileOverviewJs = readFileSync(path.join(root, "web", "profile-overview.js"), "utf8");
const customerDevicesJs = readFileSync(path.join(root, "web", "customer-devices.js"), "utf8");
const browserBridgeJs = readFileSync(path.join(root, "web", "browser-bridge.js"), "utf8");

const autumnBg = readFileSync(path.join(root, "web", "assets", "autumn-bg.jpg"));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1672, height: 941 }, deviceScaleFactor: 1 });

await page.route("**/vault/**", async (route) => {
  const pathname = new URL(route.request().url()).pathname;
  if (pathname.endsWith("autumn-bg.jpg")) {
    return route.fulfill({ contentType: "image/jpeg", body: autumnBg });
  }
  if (pathname.endsWith(".css")) {
    const name = pathname.split("/").pop().split("?")[0];
    return route.fulfill({ contentType: "text/css", body: cssFiles.get(name) || "" });
  }
  if (pathname.endsWith("profile-overview.js")) return route.fulfill({ contentType: "application/javascript", body: profileOverviewJs });
  if (pathname.endsWith("customer-devices.js")) return route.fulfill({ contentType: "application/javascript", body: customerDevicesJs });
  if (pathname.endsWith("browser-bridge.js")) return route.fulfill({ contentType: "application/javascript", body: browserBridgeJs });
  if (pathname.endsWith(".js")) return route.fulfill({ contentType: "application/javascript", body: js });
  if (pathname.endsWith(".svg")) return route.fulfill({ contentType: "image/svg+xml", body: "<svg></svg>" });
  if (pathname.endsWith(".jpg") || pathname.endsWith(".png")) return route.fulfill({ status: 200, body: "" });
  return route.fulfill({ contentType: "text/html", body: html });
});

await page.route("**/vault-api/auth/status", (route) => route.fulfill({
  contentType: "application/json", body: JSON.stringify({ authenticated: true, admin: true, principal: { admin: true, label: "管理员" }, clientMode: "browser" })
}));
await page.route("**/vault-api/**", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) }));

await page.goto("http://localhost:9999/vault/", { waitUntil: "networkidle" });
await page.waitForTimeout(500);

const metrics = await page.evaluate(() => {
  const getBox = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return {
      selector: sel,
      width: Math.round(r.width),
      height: Math.round(r.height),
      top: Math.round(r.top),
      left: Math.round(r.left),
      fontSize: style.fontSize,
      padding: style.padding,
      margin: style.margin,
      display: style.display,
      flex: style.flex,
      gridTemplateRows: style.gridTemplateRows
    };
  };

  const drawerPanel = document.querySelector(".drawer-panel");
  const drawerCs = drawerPanel ? window.getComputedStyle(drawerPanel) : {};
  const drawerChildren = drawerPanel ? Array.from(drawerPanel.children).map(c => {
    const r = c.getBoundingClientRect();
    const cs = window.getComputedStyle(c);
    return {
      tag: c.tagName,
      id: c.id,
      className: c.className,
      rect: { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height), width: Math.round(r.width) },
      margin: cs.margin,
      flex: cs.flex,
      alignSelf: cs.alignSelf
    };
  }) : [];

  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    drawerPanelInfo: {
      display: drawerCs.display,
      flexDirection: drawerCs.flexDirection,
      justifyContent: drawerCs.justifyContent,
      alignItems: drawerCs.alignItems,
      gap: drawerCs.gap,
      padding: drawerCs.padding,
      children: drawerChildren
    },
    drawer: getBox(".drawer-panel"),
    drawerHead: getBox(".drawer-head"),
    drawerNew: getBox(".drawer-new"),
    drawerHistoryHead: getBox(".drawer-history-head"),
    drawerTools: getBox(".drawer-tools"),
    chatStage: getBox(".chat-stage"),
    welcome: getBox(".welcome"),
    heroTitle: getBox(".hero-greeting-title"),
    heroDesc: getBox(".hero-greeting-desc"),
    suggestions: getBox(".suggestions"),
    firstCard: getBox(".feature-rich-card"),
    composer: getBox(".composer")
  };
});

console.log(JSON.stringify(metrics, null, 2));
await browser.close();
