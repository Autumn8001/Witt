"use strict";

const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { overview } = require("./runtime/server-center");
const run = promisify(execFile);
const cache = new Map();

async function terminalState() {
  try {
    const { stdout } = await run("systemctl", ["show", "open-terminal.service", "--property=LoadState", "--property=ActiveState"], { timeout: 3000, maxBuffer: 2048, windowsHide: true });
    const properties = Object.fromEntries(stdout.trim().split(/\r?\n/).map(line => line.split("=")));
    const status = properties.LoadState === "not-found" ? "missing" : properties.ActiveState === "active" ? "active" : properties.ActiveState === "failed" ? "failed" : properties.ActiveState === "inactive" ? "inactive" : "unknown";
    return { id: "open-terminal", name: "Open Terminal", status, detail: "独立终端服务；尚未接入 Chloe 网页终端。" };
  } catch { return { id: "open-terminal", name: "Open Terminal", status: "unknown", detail: "无法读取终端进程状态；尚未接入 Chloe 网页终端。" }; }
}

// Status checks are read-only and demand-driven. Never return credential contents or
// infer that a present file means authentication succeeded. Cache per user directory.
async function workspaceOverview({ workDir = "", projects = [], admin = false } = {}) {
  if (!admin) return { checkedAt: new Date().toISOString(), projects, services: [], connections: [], notice: "当前账号仅展示自己的工作区；服务器服务状态仅管理员可查看。" };
  let previous = cache.get("host");
  if (!previous || Date.now() - previous.at >= 15000) { previous = { at: Date.now(), promise: Promise.all([overview(), terminalState()]) }; cache.set("host", previous); }
  const [server, terminal] = await previous.promise;
  const label = (name) => ({ witt: "Chloe API", "open-webui": "Open WebUI（已卸载）", cpa: "CPA 模型路由", sub2api: "Sub2API 模型路由", nginx: "网页入口" }[name] || name);
  const services = [...server.http.map(row => ({ name: label(row.name), status: row.status, detail: "HTTP 健康检查" })), ...server.units.map(row => ({ name: label(row.name), status: row.status, detail: "系统服务进程状态" })), ...server.containers.map(row => ({ name: label(row.name), status: row.status, detail: "容器状态" }))];
  return { checkedAt: server.checkedAt, workDir, projects, resources: { cpuCount: server.cpu.count, load: server.cpu.load[0], memoryUsedPercent: server.memory.usedPercent, diskUsedPercent: server.disk?.usedPercent ?? null }, services, connections: [terminal], notice: "打开面板时检查，结果最多缓存 15 秒。Open WebUI 已卸载；Open Terminal 为独立服务，此处不提供终端执行入口。" };
}

module.exports = { workspaceOverview };
