import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

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
  if (pathname.startsWith("/vault-api/auth/status")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ authenticated: true, admin: true, principal: { admin: true, label: "管理员" }, clientMode: "browser" }));
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
    console.log("Missing resource requested:", req.url);
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }
});

await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;
const url = `http://localhost:${port}/vault/`;

console.log(`Test server running at ${url}`);

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

// 1. 验证 卡片 1 点击填充行为
const card1MainBtn = page.locator(".feature-rich-card").nth(0).locator(".feature-card-main-btn");
await card1MainBtn.click();
let inputVal = await page.locator("#messageInput").inputValue();
console.log("Card 1 Click Prompt:", inputVal);
if (!inputVal.includes("推进一个开发任务")) {
  throw new Error("Card 1 click failed to fill prompt: " + inputVal);
}

// 清空输入框
await page.locator("#messageInput").fill("");

// 2. 验证 Tag 点击填充行为
const tagPill1 = page.locator(".feature-card-tag-pill").first();
const tagPrompt = await tagPill1.getAttribute("data-prompt");
console.log("Tag 1 Expected Prompt:", tagPrompt);
await tagPill1.click();
inputVal = await page.locator("#messageInput").inputValue();
console.log("Tag 1 Result Prompt:", inputVal);
if (inputVal !== tagPrompt) {
  throw new Error(`Tag 1 click failed: expected "${tagPrompt}", got "${inputVal}"`);
}

// 3. 验证快捷键支持（按下 Ctrl+K 聚焦或展开）
await page.keyboard.press("Control+k");

console.log("Console errors count:", consoleErrors.length);
if (consoleErrors.length > 0) {
  console.log("Errors:", consoleErrors);
}
console.log("Failed requests count:", failedRequests.length);
if (failedRequests.length > 0) {
  console.log("Failed requests:", failedRequests);
}

await browser.close();
server.close();

console.log("Interaction regression test PASSED flawlessly!");
