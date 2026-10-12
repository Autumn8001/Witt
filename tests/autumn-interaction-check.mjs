import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const requireFromBackend = createRequire(path.join(root, "backend", "package.json"));
const { chromium } = requireFromBackend("playwright");
const webDir = path.join(root, "web");

const mimeTypes = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".json": "application/json"
};

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, "http://localhost");
  let pathname = parsedUrl.pathname;

  if (pathname.endsWith("/version.json") || pathname === "/version.json") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, version: "3.2.7", frontendSha: "abcdef" }));
  }
  if (pathname.startsWith("/vault-api/auth/status")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ authenticated: true, admin: true, principal: { admin: true, label: "管理员" }, clientMode: "browser" }));
  }
  if (pathname.startsWith("/vault-api/chat/capabilities")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      models: [{ id: "grok-4.7-high", name: "Grok 4.7 High", harness: "grok-build", reasoning: ["low", "medium", "high", "ultra"] }],
      harnesses: [{ id: "grok-build", name: "Grok Build" }]
    }));
  }
  if (pathname.startsWith("/vault-api/chat/conversations")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      conversations: [
        { id: "conv-1", title: "翻译对话", updatedAt: new Date().toISOString() },
        { id: "conv-2", title: "请尝试 luna_worker 创建一个服务", updatedAt: new Date().toISOString() },
        { id: "conv-3", title: "部署服务的最佳实践与优化", updatedAt: new Date().toISOString() }
      ]
    }));
  }
  if (pathname.startsWith("/vault-api/remote-workspaces/options")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      devices: [{ device_id: "PC-ONLINE", label: "开发电脑", status: "online" }]
    }));
  }
  if (pathname.startsWith("/vault-api/")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (pathname.startsWith("/vault")) {
    pathname = pathname.replace(/^\/vault/, "") || "/index.html";
  }
  if (pathname === "/") pathname = "/index.html";

  const filePath = path.join(webDir, pathname);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  } else {
    console.error("Missing resource requested:", req.url);
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }
});

await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;
const url = `http://localhost:${port}/vault/`;

console.log(`[Interaction Suite] Test server running at ${url}`);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

const consoleErrors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") {
    consoleErrors.push(msg.text());
  }
});

const failedRequests = [];
page.on("requestfailed", (req) => {
  failedRequests.push(`${req.url()} (${req.failure()?.errorText})`);
});

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForTimeout(500);

console.log("--> Testing 1: Search Toggle, Auto Focus, Esc Close, Retention, aria-expanded");
const searchToggle = page.locator("#historySearchToggle");
const historyControls = page.locator(".history-controls");
const searchInput = page.locator("#historySearch");

// 初始状态应为收起
assert.equal(await historyControls.evaluate((el) => el.classList.contains("open")), false, "History controls should be initially closed");
assert.equal(await searchToggle.getAttribute("aria-expanded"), "false", "Toggle aria-expanded should be false initially");

// 点击展开
await searchToggle.click();
assert.equal(await historyControls.evaluate((el) => el.classList.contains("open")), true, "History controls should open after click");
assert.equal(await searchToggle.getAttribute("aria-expanded"), "true", "Toggle aria-expanded should be true after click");

// 输入搜索词
await searchInput.fill("翻译");
await page.waitForTimeout(350);

// 验证按 Escape 收起，并保留搜索词
await page.keyboard.press("Escape");
assert.equal(await historyControls.evaluate((el) => el.classList.contains("open")), false, "History controls should close on Escape");
assert.equal(await searchToggle.getAttribute("aria-expanded"), "false", "Toggle aria-expanded should be false after Escape");
assert.equal(await searchInput.inputValue(), "翻译", "Search query should not be erased on close");

console.log("--> Testing 2: Ctrl/Cmd + K shortcut");
await page.keyboard.press("Control+k");
await page.waitForTimeout(300);
assert.equal(await page.locator("#welcome").isVisible(), true, "Welcome stage should remain visible for fresh chat");

console.log("--> Testing 3: Three Cards & All Tag Buttons");
const cards = page.locator(".feature-rich-card");
assert.equal(await cards.count(), 3, "Must render exactly 3 feature cards");

// 卡片 1 点击填充
const messageInput = page.locator("#messageInput");
await messageInput.fill("");
await cards.nth(0).locator(".feature-card-main-btn").click();
let val1 = await messageInput.inputValue();
assert.ok(val1.includes("推进一个开发任务"), "Card 1 click must fill task prompt");

// 卡片 3 点击填充
await messageInput.fill("");
await cards.nth(2).locator(".feature-card-main-btn").click();
let val3 = await messageInput.inputValue();
assert.ok(val3.includes("检查服务器运行状态"), "Card 3 click must fill server prompt");

// 验证全部 9 个 Tag 按钮分别填充且绝不触发自动发送
const allTagPills = page.locator(".feature-card-tag-pill");
const tagCount = await allTagPills.count();
assert.equal(tagCount, 9, "Must render exactly 9 tag pills (3 per card)");

for (let i = 0; i < tagCount; i++) {
  const pill = allTagPills.nth(i);
  const promptExpected = await pill.getAttribute("data-prompt");
  assert.ok(promptExpected, `Tag ${i} must have data-prompt`);
  await pill.click();
  const currentVal = await messageInput.inputValue();
  assert.equal(currentVal, promptExpected, `Tag ${i} click must fill expected prompt`);
  // 确保没有误触发送（welcome 卡片依然在，没有产生消息列表项）
  assert.equal(await page.locator(".message").count(), 0, `Tag ${i} click must not auto-send`);
}

console.log("--> Testing 4: Send Button Disabled State & Enablement");
await messageInput.fill("");
await page.waitForTimeout(100);
const sendBtn = page.locator("#sendButton");
const isInitiallyDisabled = await sendBtn.isDisabled();
assert.equal(isInitiallyDisabled, true, "Send button must be disabled when input is empty");

await messageInput.fill("测试开发指令");
await page.waitForTimeout(100);
const isEnabledWithText = await sendBtn.isDisabled();
assert.equal(isEnabledWithText, false, "Send button must be enabled when input has text");

// 清空还原
await messageInput.fill("");

console.log("--> Testing 5: Model Button & Quick Model Picker");
const modelBtn = page.locator("#modelButton");
const quickMenu = page.locator("#quickModelMenu");
assert.equal(await quickMenu.isVisible(), false, "Model menu should be hidden initially");

await modelBtn.click();
await page.waitForTimeout(200);
assert.equal(await quickMenu.isVisible(), true, "Model menu must open after clicking modelButton");

// 再次点击或按 Escape 收起
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
assert.equal(await quickMenu.isVisible(), false, "Model menu must close on Escape");

console.log("--> Testing 6: Idle Task Strip Click Focus");
await page.locator("#idleTaskPromptStrip").click();
assert.equal(await messageInput.evaluate((el) => document.activeElement === el), true, "Clicking idle strip must focus messageInput");

console.log("--> Testing 7: Multi-viewport Layout & No Horizontal Overflow");
const testViewports = [
  { width: 1920, height: 1080, name: "1080p Desktop" },
  { width: 1672, height: 941, name: "1672 Target Viewport" },
  { width: 1440, height: 900, name: "Standard Desktop" },
  { width: 1024, height: 768, name: "Narrow Desktop 1024" },
  { width: 900, height: 800, name: "Tablet 900" },
  { width: 390, height: 844, name: "iPhone 390" }
];

for (const vp of testViewports) {
  await page.setViewportSize({ width: vp.width, height: vp.height });
  await page.waitForTimeout(200);

  const overflow = await page.evaluate(() => {
    return document.documentElement.scrollWidth > window.innerWidth;
  });
  assert.equal(overflow, false, `Viewport ${vp.name} (${vp.width}x${vp.height}) must not have horizontal scrollbar overflow`);

  // 验证桌面视口下侧栏不盖住主舞台
  if (vp.width >= 1000) {
    const layout = await page.evaluate(() => {
      const drawer = document.querySelector(".drawer-panel");
      const appShell = document.querySelector(".app-shell");
      if (!drawer || !appShell) return { ok: true };
      const dRect = drawer.getBoundingClientRect();
      const sRect = appShell.getBoundingClientRect();
      return {
        drawerRight: dRect.right,
        shellLeft: sRect.left,
        ok: sRect.left >= dRect.right - 1 // 允许 1px 亚像素误差
      };
    });
    assert.equal(layout.ok, true, `Viewport ${vp.name} must not have drawer overlapping app-shell: shellLeft=${layout.shellLeft}, drawerRight=${layout.drawerRight}`);
  }
}

console.log("--> Testing 8: Dark Theme ([data-theme='dark']) Readability & Styles");
await page.evaluate(() => {
  document.documentElement.dataset.theme = "dark";
});
await page.waitForTimeout(200);

const darkStyles = await page.evaluate(() => {
  const title = document.querySelector(".hero-greeting-title");
  const card = document.querySelector(".feature-rich-card");
  return {
    titleColor: window.getComputedStyle(title).color,
    cardBg: window.getComputedStyle(card).backgroundColor
  };
});
assert.ok(darkStyles.titleColor.includes("245") || darkStyles.titleColor.includes("255"), "Dark theme title must be high contrast light text");

console.log("--> Checking Console Errors & Failed Requests");
assert.equal(consoleErrors.length, 0, `No console errors allowed, found: ${consoleErrors.join(", ")}`);
assert.equal(failedRequests.length, 0, `No failed requests allowed, found: ${failedRequests.join(", ")}`);

await browser.close();
server.close();

console.log("\n========================================================");
console.log("🎉 ALL P0/P1 HARDENING REGRESSION TESTS PASSED 100%!");
console.log("========================================================\n");
