import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(new URL("../backend/package.json", import.meta.url));
const { chromium } = require("playwright");

const html = readFileSync("web/index.html", "utf8");
const cssFiles = new Map([
  ["styles.css", readFileSync("web/styles.css", "utf8")],
  ["witt-white.css", readFileSync("web/witt-white.css", "utf8")],
  ["browser-chatgpt.css", readFileSync("web/browser-chatgpt.css", "utf8")],
  ["ui-system.css", readFileSync("web/ui-system.css", "utf8")],
  ["customer-devices.css", readFileSync("web/customer-devices.css", "utf8")],
]);
const js = readFileSync("web/app-workspace-20260916-r3.js", "utf8");
const customerDevicesJs = readFileSync("web/customer-devices.js", "utf8");
const browserBridgeJs = readFileSync("web/browser-bridge.js", "utf8");

const browser = await chromium.launch({ headless: true });

const fixture = {
  devices: [
    {
      device_id: "PC-ONLINE-1",
      label: "林工的开发电脑",
      status: "online",
      hostname: "DEV-WIN11",
      agent_version: "0.2.0",
      last_seen: "2026-10-09T08:30:00Z",
      capabilities: ["system.hostname", "system.info", "filesystem.list", "filesystem.read"],
      allowed_roots: ["workspace"],
    },
    {
      device_id: "PC-ONLINE-2",
      label: "前端构建工作站 (MacBook Pro)",
      status: "online",
      hostname: "BUILD-MAC-M3",
      agent_version: "0.2.0",
      last_seen: "2026-10-09T08:15:00Z",
      capabilities: ["system.hostname", "system.info", "filesystem.list", "filesystem.read"],
      allowed_roots: ["workspace"],
    },
    {
      device_id: "PC-OFFLINE-1",
      label: "办公室台式机",
      status: "offline",
      hostname: "OFFICE-DESK",
      agent_version: "0.1.9",
      last_seen: "2026-10-05T14:20:00Z",
      capabilities: ["system.hostname"],
      allowed_roots: ["workspace"],
    },
    {
      device_id: "PC-ONLINE-3",
      label: "边缘测试服务器 (Linux)",
      status: "online",
      hostname: "EDGE-NODE-01",
      agent_version: "0.2.0",
      last_seen: "2026-10-09T07:45:00Z",
      capabilities: ["system.hostname", "system.info", "filesystem.list", "filesystem.read"],
      allowed_roots: ["workspace"],
    },
    {
      device_id: "PC-ONLINE-4",
      label: "CI/CD 持续集成机 (Runner-02)",
      status: "online",
      hostname: "CI-RUNNER-02",
      agent_version: "0.2.0",
      last_seen: "2026-10-09T08:00:00Z",
      capabilities: ["system.hostname", "system.info", "filesystem.list", "filesystem.read"],
      allowed_roots: ["workspace"],
    },
    {
      device_id: "PC-NEED-UPDATE",
      label: "预发环境调试机",
      status: "online",
      hostname: "STAGING-DEBUG",
      agent_version: "0.1.2",
      last_seen: "2026-10-08T16:00:00Z",
      capabilities: ["system.hostname"],
      allowed_roots: ["workspace"],
    },
    {
      device_id: "PC-OFFLINE-2",
      label: "家庭备用笔记本 (ThinkPad)",
      status: "offline",
      hostname: "HOME-LAPTOP",
      agent_version: "0.1.8",
      last_seen: "2026-09-28T10:00:00Z",
      capabilities: ["system.hostname"],
      allowed_roots: ["workspace"],
    },
    {
      device_id: "PC-ONLINE-5",
      label: "GPU 训练实验机",
      status: "online",
      hostname: "GPU-LAB-4090",
      agent_version: "0.2.0",
      last_seen: "2026-10-09T08:22:00Z",
      capabilities: ["system.hostname", "system.info", "filesystem.list", "filesystem.read"],
      allowed_roots: ["workspace"],
    },
  ],
};

async function setupPageRoutes(page) {
  // 静态资源拦截
  await page.route("**/vault/**", (route) => {
    const url = route.request().url();
    const filename = url.split("?")[0].split("/").pop();
    if (filename === "index.html") return route.fulfill({ contentType: "text/html", body: html });
    if (filename === "version.json") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ frontendSha: "dcb6d1181816d968f4f7d43d676a02a494eed889" }) });
    if (filename === "customer-devices.js") return route.fulfill({ contentType: "application/javascript", body: customerDevicesJs });
    if (filename === "browser-bridge.js") return route.fulfill({ contentType: "application/javascript", body: browserBridgeJs });
    if (filename === "app-workspace-20260916-r3.js") return route.fulfill({ contentType: "application/javascript", body: js });
    if (cssFiles.has(filename)) return route.fulfill({ contentType: "text/css", body: cssFiles.get(filename) });
    return route.fulfill({ status: 204 });
  });

  // API 路由统一调度拦截：确保所有接口 100% 返回正确结构，无 Failed to fetch 或 Toast 报错
  await page.route("**/vault-api/**", (route) => {
    const url = route.request().url();
    if (url.includes("/vault-api/remote-workspaces/options")) {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          devices: fixture.devices.map((device) => ({
            device_id: device.device_id,
            device_label: device.label,
            status: device.status,
            roots: [{ id: "workspace", label: "林工 · 网站项目 (D:/Coding/Web)" }],
            ready: device.device_id !== "PC-NEED-UPDATE" && device.status === "online",
          })),
          capabilities: {},
          roots: [],
        }),
      });
    }
    if (url.includes("/vault-api/customer-devices")) {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(fixture) });
    }
    if (url.includes("/vault-api/version")) {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ backendSha: "dcb6d1181816d968f4f7d43d676a02a494eed889" }) });
    }
    if (url.includes("/vault-api/runtime/profiles")) {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ profiles: [{ id: "default", label: "默认配置" }] }) });
    }
    if (url.includes("/vault-api/servers/overview")) {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ servers: [], total: 0 }) });
    }
    if (url.includes("/vault-api/providers/cpa/quotas")) {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ quotas: [] }) });
    }
    if (url.includes("/vault-api/chat/capabilities")) {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ models: [] }) });
    }
    if (url.includes("/vault-api/runtime/harnesses")) {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ harnesses: [] }) });
    }
    if (url.includes("/vault-api/auth/status")) {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ authenticated: true, admin: true, principal: { admin: true } }) });
    }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
}

// 1. 移动端首屏（390×844）：确认标题固定、工具栏刷新按钮触控高度（>=44px）、前部设备列表与选中状态
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await setupPageRoutes(page);
  await page.goto("https://wit.test/vault/index.html");
  await page.evaluate(() => {
    document.body.classList.add("web-browser");
    window.WittCustomerDevices?.open();
  });
  await page.waitForTimeout(400);

  // 选中第一台在线设备
  await page.locator('[data-select-customer-device="PC-ONLINE-1"]').click();
  await page.waitForTimeout(150);

  // 保持在首屏顶部视角，确保清晰展示标题区、44px 刷新按钮与前部设备卡片
  await page.locator("#customerDevices").evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.waitForTimeout(200);

  // 确保页面内没有浮动 Toast
  await page.evaluate(() => {
    document.querySelectorAll(".toast").forEach((el) => el.remove());
  });

  await page.screenshot({ path: "tests/preview-customer-mobile.png", fullPage: false });
  await page.close();
}

// 2. 移动端独立滚动后（390×844）：确认标题区完全固定、设备列表独立滚动、底部创建表单与开始按钮完全到达
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await setupPageRoutes(page);
  await page.goto("https://wit.test/vault/index.html");
  await page.evaluate(() => {
    document.body.classList.add("web-browser");
    window.WittCustomerDevices?.open();
  });
  await page.waitForTimeout(400);

  // 选中第一台在线设备
  await page.locator('[data-select-customer-device="PC-ONLINE-1"]').click();
  await page.waitForTimeout(150);

  // 在内部滚动容器 #customerDevices 中向下滚动到底部，验证创建表单完全到达与标题固定
  await page.locator("#customerDevices").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await page.waitForTimeout(300);

  // 确保页面内没有浮动 Toast
  await page.evaluate(() => {
    document.querySelectorAll(".toast").forEach((el) => el.remove());
  });

  await page.screenshot({ path: "tests/preview-customer-mobile-scrolled.png", fullPage: false });
  await page.close();
}

// 3. 桌面端居中首屏（1440×900）：确认桌面端 44px 刷新按钮、标题区与设备卡片排版
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await setupPageRoutes(page);
  await page.goto("https://wit.test/vault/index.html");
  await page.evaluate(() => {
    document.body.classList.add("web-browser");
    window.WittCustomerDevices?.open();
  });
  await page.waitForTimeout(400);

  // 选中第一台在线设备
  await page.locator('[data-select-customer-device="PC-ONLINE-1"]').click();
  await page.waitForTimeout(150);

  // 保持在桌面首屏顶部视角
  await page.locator("#customerDevices").evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.waitForTimeout(200);

  // 确保页面内没有浮动 Toast
  await page.evaluate(() => {
    document.querySelectorAll(".toast").forEach((el) => el.remove());
  });

  await page.screenshot({ path: "tests/preview-customer-desktop.png", fullPage: false });
  await page.close();
}

await browser.close();
console.log("All 3 customer sheet previews captured successfully!");
