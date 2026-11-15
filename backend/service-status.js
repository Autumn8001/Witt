"use strict";
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const run = promisify(execFile);

const names = {
  "drop-vault.service": "Chloe API",
  "witt.service": "Chloe API",
  "witt-worker.service": "Chloe 执行服务",
  "media-fetch.service": "拾片 · 视频与字幕",
  "nginx.service": "HTTPS 网页入口",
  "witt-open-enrollment.service": "设备注册",
};

// Enumerate both loaded units and installed unit files. A newly installed but
// not yet started service must be discoverable too. No process args or logs.
async function discoverServiceStatus(execute = run) {
  const commands = [
    ["list-units", "--type=service", "--all", "--output=json", "--no-pager"],
    ["list-unit-files", "--type=service", "--output=json", "--no-pager"],
  ];
  const results = await Promise.allSettled(commands.map(async args => {
    const { stdout } = await execute("systemctl", args, { timeout: 4500, maxBuffer: 4*1024*1024, env: { ...process.env, LC_ALL: "C" } });
    const rows = JSON.parse(stdout);
    if (!Array.isArray(rows)) throw Error("Invalid service inventory");
    return rows;
  }));
  const inventory = new Map();
  const valid = name => typeof name === "string" && /^[a-zA-Z0-9_.:@\\-]+\.service$/.test(name);
  if (results[1].status === "fulfilled") {
    for (const row of results[1].value) {
      const unit = String(row.unit_file || "").split("/").pop();
      if (!valid(unit)) continue;
      inventory.set(unit, { id: unit, unit, name: names[unit] || unit.replace(/\.service$/, ""),
        description: "已安装的服务配置", status: "inactive", subState: "dead", enabled: String(row.state || "unknown"), template: unit.includes("@.service") });
    }
  }
  if (results[0].status === "fulfilled") {
    for (const row of results[0].value) {
      if (!valid(row.unit)) continue;
      const previous = inventory.get(row.unit) || {};
      inventory.set(row.unit, { ...previous, id: row.unit, unit: row.unit,
        name: names[row.unit] || row.unit.replace(/\.service$/, ""), description: String(row.description || ""),
        status: ["active", "inactive", "failed", "activating", "deactivating", "reloading", "maintenance"].includes(row.active) ? row.active : "unknown",
        subState: String(row.sub || "unknown"), loadState: String(row.load || "unknown"), enabled: previous.enabled || "unknown" });
    }
  }
  const order = { failed: 0, activating: 1, deactivating: 1, active: 2, reloading: 2, inactive: 3, unknown: 4 };
  const services = [...inventory.values()].sort((a,b) => (order[a.status] ?? 4)-(order[b.status] ?? 4) || a.name.localeCompare(b.name));
  return { services, serviceCounts: { total: services.length, active: services.filter(s=>s.status==="active").length,
    failed: services.filter(s=>s.status==="failed").length, inactive: services.filter(s=>s.status==="inactive").length },
    serviceDiscovery: { available: results[0].status === "fulfilled", complete: results.every(r=>r.status==="fulfilled"), scope: "all" } };
}

module.exports = { discoverServiceStatus };
