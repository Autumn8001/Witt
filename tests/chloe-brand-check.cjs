const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => readFileSync(path.join(root, file), "utf8");

test("web shell and chat defaults display Chloe", () => {
  const html = read("web/index.html");
  const app = read("web/app-workspace-20260916-r3.js");
  const legacyApp = read("web/app.js");
  const bridge = read("web/browser-bridge.js");

  assert.match(html, /<title>Chloe · 私人服务器助手<\/title>/);
  assert.match(html, /class="boot-wordmark">Chloe/);
  assert.match(html, /Chloe 开发工作台/);
  assert.match(html, /placeholder="回复 Chloe"/);
  assert.match(html, /<strong>Chloe<\/strong><small>Chloe 客户端与服务<\/small>/);
  assert.match(app, /state\.active\?\.title \|\| "Chloe"/);
  assert.match(app, /Chloe 正在处理/);
  assert.match(legacyApp, /state\.active\?\.title \|\| "Chloe"/);
  assert.match(bridge, /drawerTitle\.textContent = "Chloe"/);
  assert.match(bridge, /placeholder = "向 Chloe 发送消息"/);
});

test("homepage branding fits mobile and desktop browsers", async () => {
  let chromium;
  try {
    const requireFromBackend = createRequire(path.join(root, "backend", "package.json"));
    chromium = requireFromBackend("playwright").chromium;
  } catch {
    chromium = require(path.join(root, "..", "local-tools", "_witt-ui-harness", "node_modules", "playwright-core")).chromium;
  }
  const launchOptions = { headless: true };
  const chromePath = "C:/Users/星烛/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe";
  if (require("node:fs").existsSync(chromePath)) launchOptions.executablePath = chromePath;
  const browser = await chromium.launch(launchOptions);
  const webRoot = path.join(root, "web");

  try {
    for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
      const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
      await page.route("https://chloe.test/**", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.startsWith("/vault-api/")) {
          let body = {};
          if (url.pathname.endsWith("/auth/status")) {
            body = { authenticated: true, admin: true, principal: { admin: true }, clientMode: "browser" };
          } else if (url.pathname.endsWith("/chat/conversations")) {
            body = { conversations: [] };
          } else if (url.pathname.endsWith("/chat/capabilities")) {
            body = { models: [], harnesses: [] };
          } else if (url.pathname.endsWith("/version")) {
            body = { version: "test" };
          }
          return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
        }

        const relativePath = url.pathname === "/vault/index.html"
          ? "index.html"
          : decodeURIComponent(url.pathname.replace(/^\/vault\//, ""));
        const filePath = path.resolve(webRoot, relativePath);
        if (filePath !== webRoot && !filePath.startsWith(`${webRoot}${path.sep}`)) {
          return route.fulfill({ status: 403, body: "forbidden" });
        }
        try {
          const contentType = relativePath.endsWith(".css") ? "text/css"
            : relativePath.endsWith(".js") ? "application/javascript"
              : relativePath.endsWith(".svg") ? "image/svg+xml"
                : relativePath.endsWith(".json") ? "application/json"
                  : "text/html";
          return route.fulfill({ contentType, body: readFileSync(filePath) });
        } catch {
          return route.fulfill({ status: 404, body: "not found" });
        }
      });

      await page.goto("https://chloe.test/vault/index.html", { waitUntil: "networkidle" });
      await page.waitForTimeout(250);
      const branding = await page.evaluate(() => ({
        title: document.title,
        placeholder: document.querySelector("#messageInput")?.placeholder,
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
      }));
      assert.equal(branding.title, "Chloe · 私人服务器助手");
      assert.equal(branding.placeholder, "向 Chloe 发送消息");
      assert.ok(
        branding.documentWidth <= branding.viewportWidth,
        `${viewport.width}px homepage overflows horizontally: ${branding.documentWidth}px`,
      );
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test("branding preserves native bridge, storage, and protocol identifiers", () => {
  const html = read("web/index.html");
  const app = read("web/app-workspace-20260916-r3.js");
  const bridge = read("web/browser-bridge.js");

  assert.match(html, /window\.WittNative\?\.postMessage/);
  assert.match(app, /window\.WittNative\?\.postMessage/);
  assert.match(app, /localStorage\.getItem\("witt_completion_reminder"\)/);
  assert.match(app, /indexedDB\.open\("witt-local-conversations"/);
  assert.match(bridge, /"X-Witt-Client": "browser"/);
});
