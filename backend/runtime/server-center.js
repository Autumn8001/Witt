"use strict";

const { execFile } = require("node:child_process");
const os = require("node:os");

function run(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 4000, windowsHide: true }, (error, stdout) => {
      resolve(error ? null : String(stdout || ""));
    });
  });
}

function statusFromProbe(probe) {
  if (!probe || probe.skipped) return "unknown";
  if (probe.ok) return "healthy";
  if (probe.status >= 200 && probe.status < 500) return "degraded";
  return "down";
}

async function probeHttp(url, fetchImpl) {
  if (!url) return { name: "http", skipped: true, status: "unknown" };
  const started = Date.now();
  try {
    const response = await fetchImpl(url, { method: "GET" });
    return {
      name: url,
      ok: response.ok,
      status: response.status,
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    return { name: url, ok: false, error: String(error.message || error).slice(0, 160) };
  }
}

async function overview(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const checkedAt = new Date().toISOString();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const disks = os.platform() === "win32"
    ? await run("wmic", ["logicaldisk", "get", "size,freespace,caption"])
    : await run("df", ["-kP", "/"]);
  const services = [];
  const targets = [
    ["nginx", options.nginxUrl],
    ["docker", options.dockerUrl],
    ["cpa", options.cpaUrl],
    ["sub2api", options.sub2apiUrl],
    ["postgresql", options.postgresUrl],
    ["redis", options.redisUrl],
    ["open-webui", options.openWebuiUrl],
    ["witt", options.wittUrl || "http://127.0.0.1:3003/health"],
  ];
  for (const [name, url] of targets) {
    const probe = await probeHttp(url, fetchImpl);
    services.push({
      name,
      status: url ? statusFromProbe(probe) : "unknown",
      lastChecked: checkedAt,
      detail: url ? probe : { skipped: true },
    });
  }
  return {
    host: os.hostname(),
    checkedAt,
    cpu: {
      count: os.cpus().length,
      load: os.loadavg(),
    },
    memory: {
      total: totalMem,
      free: freeMem,
      used: totalMem - freeMem,
    },
    disk: disks ? disks.trim().slice(0, 2000) : null,
    uptimeSeconds: os.uptime(),
    services,
    openWebuiUrl: options.openWebuiUrl || process.env.OPEN_WEBUI_URL || "",
  };
}

module.exports = { overview, probeHttp, statusFromProbe };
