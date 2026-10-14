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
const outputDir = path.join(__dirname, "artifacts", "chloe-autumn");
const mimeTypes = {
  ".html": "text/html", ".css": "text/css", ".js": "application/javascript",
  ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".png": "image/png",
  ".webp": "image/webp", ".json": "application/json",
};

const ids = {
  one: "00000000-0000-4000-8000-000000000001",
  two: "00000000-0000-4000-8000-000000000002",
  three: "00000000-0000-4000-8000-000000000003",
};
const now = new Date().toISOString();
const makeConversation = (id, title, project, lastMessage, hasAttachments = false) => ({
  id, title, project, lastMessage, hasAttachments, updatedAt: now,
  model: "grok-4.7-high", reasoning: "medium", accessMode: "danger-full-access",
  harness: "grok-build", workDir: "", messages: [], taskStatus: { state: "idle", label: "已完成" },
});
let conversations = [];
let nextId = 10;
const eventStreams = new Map();

function sendJson(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, "http://localhost");
  const pathname = requestUrl.pathname;

  if (pathname === "/__test/seed" && req.method === "POST") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    conversations = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return sendJson(res, { ok: true });
  }
  if (pathname === "/vault-api/version.json" || pathname === "/vault/version.json" || pathname === "/version.json") {
    return sendJson(res, { ok: true, version: "3.2.7", frontendSha: "abcdef" });
  }
  if (pathname === "/vault-api/auth/status") {
    return sendJson(res, { authenticated: true, admin: true, principal: { admin: true, label: "管理员" }, clientMode: "browser" });
  }
  if (pathname === "/vault-api/chat/capabilities") {
    return sendJson(res, {
      models: [
        { id: "grok-4.7-high", name: "Grok 4.7 High", harness: "grok-build", reasoning: ["low", "medium", "high", "ultra"] },
        { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", harness: "codex", reasoning: ["low", "medium", "high", "ultra"] },
      ],
      harnesses: [{ id: "grok-build", name: "Grok Build" }, { id: "codex", name: "Codex" }],
      runtime: {},
    });
  }
  if (/^\/vault-api\/chat\/conversations\/[^/]+\/events$/.test(pathname)) {
    const id = pathname.split("/")[4];
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": ready\n\n");
    const streams = eventStreams.get(id) || new Set();
    streams.add(res);
    eventStreams.set(id, streams);
    req.on("close", () => {
      streams.delete(res);
      if (!streams.size) eventStreams.delete(id);
    });
    return;
  }
  if (pathname === "/vault-api/chat/conversations" && req.method === "POST") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const id = `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`;
    const conversation = {
      ...makeConversation(id, "新对话", "未分组", ""),
      model: body.model || "grok-4.7-high",
      reasoning: body.reasoning || "medium",
      accessMode: body.accessMode || "danger-full-access",
      workDir: body.workDir || "",
      codexProfile: body.codexProfile || "default",
    };
    conversations.unshift(conversation);
    return sendJson(res, { conversation });
  }
  if (pathname === "/vault-api/chat/conversations" && req.method === "GET") {
    const query = (requestUrl.searchParams.get("q") || "").trim().toLocaleLowerCase();
    const project = requestUrl.searchParams.get("project") || "";
    const attachments = requestUrl.searchParams.get("attachments") === "1";
    const results = conversations.filter((item) =>
      (!query || `${item.title} ${item.lastMessage || ""}`.toLocaleLowerCase().includes(query)) &&
      (!project || item.project === project) && (!attachments || item.hasAttachments));
    return sendJson(res, { conversations: results });
  }
  if (/^\/vault-api\/chat\/conversations\/[^/]+\/messages$/.test(pathname) && req.method === "POST") {
    const id = pathname.split("/")[4];
    const conversation = conversations.find((item) => item.id === id);
    if (!conversation) return sendJson(res, { error: "Conversation not found" }, 404);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const createdAt = new Date().toISOString();
    conversation.messages = [
      ...(conversation.messages || []),
      { id: `user-${Date.now()}`, role: "user", text: body.text || "", createdAt, status: "completed" },
      { id: `assistant-${Date.now()}`, role: "assistant", text: "Mock assistant 已收到并完成这条消息。", createdAt, status: "completed" },
    ];
    conversation.lastMessage = "Mock assistant 已收到并完成这条消息。";
    conversation.taskStatus = { state: "completed", label: "执行完成" };
    conversation.updatedAt = createdAt;
    const result = { conversation, clientRequestId: body.clientRequestId || "" };
    for (const stream of eventStreams.get(id) || []) {
      stream.write(`event: snapshot\ndata: ${JSON.stringify({ conversation })}\n\n`);
    }
    return sendJson(res, result);
  }
  if (pathname.startsWith("/vault-api/chat/conversations/")) {
    const id = pathname.split("/")[4];
    const conversation = conversations.find((item) => item.id === id);
    return conversation
      ? sendJson(res, { conversation })
      : sendJson(res, { error: "Conversation not found" }, 404);
  }
  if (pathname.startsWith("/vault-api/")) return sendJson(res, { ok: true });

  let filePath = pathname.replace(/^\/vault/, "") || "/index.html";
  if (filePath === "/") filePath = "/index.html";
  filePath = path.join(webDir, filePath);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    res.writeHead(200, { "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
    return;
  }
  console.error("Missing resource requested:", req.url);
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

await fs.promises.mkdir(outputDir, { recursive: true });
await new Promise((resolve) => server.listen(0, resolve));
const url = `http://localhost:${server.address().port}/vault/`;
console.log(`[Interaction Suite] Test server running at ${url}`);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];
const notFoundResponses = [];
page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
page.on("pageerror", (error) => pageErrors.push(error.message));
page.on("requestfailed", (request) => {
  const reason = request.failure()?.errorText || "unknown";
  if (/\/events$/.test(new URL(request.url()).pathname) && reason === "net::ERR_ABORTED") return;
  failedRequests.push(`${request.url()} (${reason})`);
});
page.on("response", (response) => {
  if (response.status() === 404) notFoundResponses.push(response.url());
});

try {
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  assert.equal(await page.locator(".suggestions").count(), 0, "Removed suggestion cards must stay absent");
  assert.equal(await page.locator("#idleTaskPromptStrip").count(), 0, "Removed idle prompt strip must stay absent");
  assert.equal(await page.locator("#taskStatusStrip").count(), 1, "The live task status strip must remain in the DOM");

  const screenshots = [
    { width: 1672, height: 941, name: "1672x941" },
    { width: 1440, height: 900, name: "1440x900" },
    { width: 1024, height: 768, name: "1024x768" },
    { width: 390, height: 844, name: "390x844" },
  ];
  await page.evaluate(async () => {
    await document.fonts.ready;
    const backgroundUrl = getComputedStyle(document.querySelector(".chloe-bg-layer")).backgroundImage
      .match(/url\(["']?(.*?)["']?\)/)?.[1];
    if (backgroundUrl) {
      const image = new Image();
      image.src = backgroundUrl;
      await image.decode();
    }
    await Promise.all([...document.images].map((image) => image.decode().catch(() => {})));
  });
  for (const viewport of screenshots) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(150);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(overflow, false, `${viewport.name} must not overflow horizontally`);
    if (viewport.width >= 1000) {
      const geometry = await page.evaluate(() => {
        const drawer = document.querySelector(".drawer-panel").getBoundingClientRect();
        const shell = document.querySelector(".app-shell").getBoundingClientRect();
        return { drawerRight: drawer.right, shellLeft: shell.left };
      });
      assert.ok(geometry.shellLeft >= geometry.drawerRight - 1,
        `${viewport.name} desktop shell must start after sidebar (${geometry.shellLeft} < ${geometry.drawerRight})`);
    }
    await page.screenshot({ path: path.join(outputDir, `home-${viewport.name}.png`), fullPage: false });
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('[data-theme-choice="colorful"]').click();
  await page.waitForTimeout(100);
  assert.equal(await page.locator("html").getAttribute("data-theme"), "colorful", "Warm color theme must apply");
  const readableComposerColor = await page.locator("#messageInput").evaluate((el) => getComputedStyle(el).color);
  assert.ok(readableComposerColor && readableComposerColor !== "rgba(0, 0, 0, 0)", "Composer text must remain visible in the color theme");
  await page.locator('[data-theme-choice="dark"]').click();
  await page.waitForTimeout(100);
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark", "Dark theme must apply");
  const darkComposerColor = await page.locator("#messageInput").evaluate((el) => getComputedStyle(el).color);
  assert.ok(darkComposerColor && darkComposerColor !== "rgba(0, 0, 0, 0)", "Composer text must remain visible in dark theme");
  await page.locator('[data-theme-choice="light"]').click();

  console.log("--> Desktop sidebar collapse and restore");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator("#closeDrawer").click();
  assert.equal(await page.locator("body").evaluate((el) => el.classList.contains("sidebar-collapsed")), true, "Desktop close button must collapse sidebar");
  assert.equal(await page.locator("#drawer").getAttribute("aria-hidden"), "true", "Collapsed desktop sidebar must be hidden from assistive technology");
  await page.locator("#menuButton").click();
  assert.equal(await page.locator("body").evaluate((el) => el.classList.contains("sidebar-collapsed")), false, "Menu button must restore collapsed sidebar");
  assert.equal(await page.locator("#drawer").getAttribute("aria-hidden"), "false", "Restored desktop sidebar must be exposed to assistive technology");
  await page.locator("#runtimeSettingsButton").click();
  await page.locator("#closeSettings").click();
  assert.equal(await page.locator("#drawer").getAttribute("aria-hidden"), "false", "Business closeDrawer calls must leave the desktop sidebar exposed");
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.locator("#closeDrawer").click();
  assert.equal(await page.locator("body").evaluate((el) => el.classList.contains("sidebar-collapsed")), true, "Sidebar collapse must use the 1000px desktop breakpoint");
  await page.locator("#menuButton").click();

  console.log("--> Composer model, settings entry, and multiline input");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator("#modelButton").click();
  await page.locator("#quickModelExpand").click();
  const solOption = page.locator('[data-quick-model="gpt-6.1-sol"]');
  await solOption.click();
  assert.match(await page.locator("#modelLabel").textContent(), /GPT-6\.1 Sol/, "Selecting a model must update composer label");
  await page.locator("#runtimeSettingsButton").click();
  assert.equal(await page.locator("#settingsSheet").evaluate((el) => el.classList.contains("open")), true, "Settings entry must open settings sheet");
  await page.locator("#closeSettings").click();
  const messageInput = page.locator("#messageInput");
  const baseHeight = await messageInput.evaluate((el) => el.clientHeight);
  await messageInput.fill("第一行内容\n第二行内容\n第三行内容\n第四行内容");
  const grownHeight = await messageInput.evaluate((el) => el.clientHeight);
  assert.ok(grownHeight > baseHeight, `Textarea must grow for multiline input (${baseHeight} -> ${grownHeight})`);
  await messageInput.fill("");

  console.log("--> Real history filtering and conversation switching");
  const seeded = [
    makeConversation(ids.one, "翻译对话", "语言工具", "请翻译这段英文内容"),
    makeConversation(ids.two, "服务端搜索", "工作台", "搜索分页与历史查询", true),
    {
      ...makeConversation(ids.three, "数据库迁移方案", "平台", "检查数据库迁移与索引"),
      taskStatus: { state: "completed", label: "执行完成" },
      messages: [
        { id: "history-user-three", role: "user", text: "检查数据库迁移与索引", createdAt: now, status: "completed" },
        { id: "history-assistant-three", role: "assistant", text: "已完成数据库迁移方案检查。", createdAt: now, status: "completed" },
      ],
    },
  ];
  const seedResponse = await fetch(new URL("/__test/seed", url), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(seeded),
  });
  assert.equal(seedResponse.status, 200, "Test server must accept history fixtures");
  await page.locator("#historySearchToggle").click();
  await page.locator("#historySearch").fill("迁移");
  await page.waitForFunction(() => document.querySelectorAll(".conversation-row").length === 1, null, { timeout: 3000 });
  assert.equal(await page.locator(".conversation-row strong").first().textContent(), "数据库迁移方案", "Search query must filter to matching history");
  assert.equal(await page.locator(".conversation-row").count(), 1, "Search must exclude nonmatching conversations");
  await page.locator(`[data-open="${ids.three}"]`).click();
  await page.waitForFunction(() => document.querySelector("#taskStatusStrip")?.hidden === false, null, { timeout: 3000 });
  assert.equal(await page.locator(".conversation-row.active").getAttribute("data-id"), ids.three, "Opening a search result must select its conversation");
  await page.locator("#taskStatusStrip").getByText("执行完成").waitFor({ state: "visible" });
  assert.equal(await page.locator("#taskStatusStrip").isVisible(), true, "A completed conversation with messages must show its real status strip");
  assert.equal(await page.locator(".message").count(), 2, "Opening history must render its user and assistant messages");

  console.log("--> New conversation and attachment preview");
  await page.locator("#newChatButton").click();
  await page.waitForFunction(() => document.querySelector("#messageInput")?.disabled === false && document.querySelector("#taskStatusStrip")?.hidden, null, { timeout: 3000 });
  assert.equal(await page.locator("#taskStatusStrip").isVisible(), false, "An empty idle conversation must hide its status strip");
  await page.evaluate(() => {
    const click = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () {
      if (this.type === "file") {
        this.style.cssText = "position:fixed;left:-10000px;top:0";
        document.body.append(this);
        return;
      }
      click.call(this);
    };
  });
  await page.locator("#attachButton").click();
  await page.locator("#attachPhotoButton").click();
  await page.locator('input[type="file"]').setInputFiles({
    name: "preview-check.txt", mimeType: "text/plain", buffer: Buffer.from("preview attachment"),
  });
  await page.locator('.attachment-chip strong').waitFor({ state: "visible" });
  assert.equal(await page.locator(".attachment-chip strong").textContent(), "preview-check.txt", "Selected attachment must appear in the composer preview");
  await page.locator(".attachment-chip [data-remove-file]").click();
  await page.locator("#messageInput").fill("请回复并验证 mock 消息流");
  await page.locator("#sendButton").click();
  await page.getByText("Mock assistant 已收到并完成这条消息。", { exact: true }).waitFor({ state: "visible", timeout: 5000 });
  await page.locator("#taskStatusStrip").getByText("执行完成").waitFor({ state: "visible", timeout: 5000 });
  assert.equal(await page.locator(".message.user").count(), 1, "Sent input must render as a user message");
  assert.equal(await page.locator(".message.assistant").count(), 1, "Mock response must render as an assistant message");
  assert.equal(await page.locator("#taskStatusStrip").isVisible(), true, "A completed response must show the real task status");

  console.log("--> Verify final layout and errors");
  for (const viewport of screenshots) {
    await page.setViewportSize(viewport);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(overflow, false, `${viewport.name} must remain free of horizontal overflow after interactions`);
    if (viewport.width === 390) {
      const modelControl = await page.locator("#modelButton").evaluate((button) => {
        const label = button.querySelector("#modelLabel");
        const rect = label.getBoundingClientRect();
        const buttonRect = button.getBoundingClientRect();
        return {
          visible: getComputedStyle(label).display !== "none" && rect.width > 0 && rect.height > 0,
          inViewport: rect.left >= 0 && rect.right <= window.innerWidth,
          contained: rect.left >= buttonRect.left && rect.right <= buttonRect.right,
          text: label.textContent.trim(),
        };
      });
      assert.ok(modelControl.visible && modelControl.inViewport && modelControl.contained && modelControl.text,
        `390px model label must remain visible within model button: ${JSON.stringify(modelControl)}`);
    }
  }
  assert.deepEqual(pageErrors, [], `No uncaught page errors allowed: ${pageErrors.join(" | ")}`);
  assert.deepEqual(consoleErrors, [], `No console errors allowed: ${consoleErrors.join(" | ")}`);
  assert.deepEqual(failedRequests, [], `No failed requests allowed: ${failedRequests.join(" | ")}`);
  assert.deepEqual(notFoundResponses, [], `No 404 responses allowed: ${notFoundResponses.join(" | ")}`);
  console.log(`Screenshots saved under ${path.relative(root, outputDir)}`);
  console.log("Autumn interaction checks passed.");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
