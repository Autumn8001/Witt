import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const require = createRequire(path.join(root, "backend", "package.json"));
const { chromium } = require("playwright");

const html = readFileSync(path.join(root, "web", "index.html"), "utf8");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1672, height: 941 }, deviceScaleFactor: 1 });

await page.route("**/vault/**", async (route) => {
  const pathname = new URL(route.request().url()).pathname;
  if (pathname.endsWith("/version.json")) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ frontendSha: "abcdef0123456789abcdef0123456789abcdef01" }) });
  const relative = (pathname === "/vault" || pathname === "/vault/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/vault\//, "")).replaceAll("/", path.sep);
  const webRoot = path.join(root, "web");
  const file = path.resolve(webRoot, relative);
  if (!file.startsWith(webRoot + path.sep) || !existsSync(file)) return route.fulfill({ status: 404, body: `Missing local UI asset: ${relative}` });
  const ext = path.extname(file).toLowerCase();
  const contentType = ({ ".html": "text/html", ".css": "text/css", ".js": "application/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".json": "application/json" })[ext] || "application/octet-stream";
  return route.fulfill({ contentType, body: readFileSync(file) });
});

await page.route("**/vault-api/auth/status", (route) => route.fulfill({
  contentType: "application/json", body: JSON.stringify({ authenticated: true, admin: true, principal: { admin: true, label: "管理员" }, clientMode: "browser" })
}));
await page.route("**/vault-api/**", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) }));

await page.goto("http://localhost:9999/vault/", { waitUntil: "networkidle" });
await page.waitForTimeout(500);
await page.evaluate(async () => {
  await document.fonts.ready;
  const image = new Image();
  image.src = "/vault/assets/chloe-autumn-landscape.webp";
  await image.decode();
});

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
    composer: getBox(".composer")
  };
});

console.log(JSON.stringify(metrics, null, 2));
await browser.close();
