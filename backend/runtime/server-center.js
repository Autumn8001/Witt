"use strict";

const { execFile } = require("node:child_process");
const os = require("node:os");

// Read-only overview of the host Witt runs on. No restart, reload, stop, or shell
// surface is exposed here: heavier operations stay with the Open WebUI ops expert.
//
// Service lists are configurable because the real inventory must drive the page,
// not a hardcoded guess. Defaults below match what was verified on the server:
//   open-webui  http://127.0.0.1:3000/health    -> 200 {"status":true}
//   cpa         http://127.0.0.1:8317/healthz   -> 200 {"status":"ok"}   (/health is 404)
//   sub2api     http://127.0.0.1:8080/health    -> 200 {"status":"ok"}
//   witt        http://127.0.0.1:3003/health    -> 200 {"ok":true}
// sub2api and open-webui return 200 HTML for unknown paths, so each service pins
// an exact known path rather than probing a catch-all root.

const DEFAULT_HTTP_SERVICES = [
  { name: "witt", url: "http://127.0.0.1:3003/health" },
  { name: "open-webui", url: "http://127.0.0.1:3000/health" },
  { name: "cpa", url: "http://127.0.0.1:8317/healthz" },
  { name: "sub2api", url: "http://127.0.0.1:8080/health" },
];

// Containers actually present, with the health signal each one supports.
const DEFAULT_CONTAINERS = [
  "open-webui", "cli-proxy-api", "sub2api", "sub2api-redis", "sub2api-postgres",
];

const DEFAULT_UNITS = ["nginx", "docker", "fail2ban", "ssh", "cron"];

function run(command, args, timeoutMs = 5000) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        resolve(error ? null : String(stdout || ""));
      });
  });
}

function classifyHttp(probe) {
  if (!probe || probe.skipped) return "unknown";
  if (probe.ok) return "healthy";
  const status = Number(probe.status);
  if (Number.isFinite(status) && status >= 200 && status < 500) return "degraded";
  return "down";
}

async function probeHttp(entry, fetchImpl) {
  const started = Date.now();
  const canTimeout = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function";
  try {
    const response = await fetchImpl(entry.url, {
      method: "GET",
      signal: canTimeout ? AbortSignal.timeout(4000) : undefined,
    });
    return {
      name: entry.name, url: entry.url, ok: response.ok, status: response.status,
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    return {
      name: entry.name, url: entry.url, ok: false, latencyMs: Date.now() - started,
      errorType: error?.name === "TimeoutError" || error?.name === "AbortError" ? "timeout" : "unreachable",
      error: String(error?.message || error).slice(0, 160),
    };
  }
}

// docker inspect gives State.Health.Status when a healthcheck exists; otherwise
// fall back to the container state so "running without healthcheck" is not
// reported as unhealthy.
function classifyContainer(inspect) {
  if (!inspect || inspect.skipped) return "unknown";
  const state = inspect.State || {};
  const health = state.Health && state.Health.Status;
  if (health === "healthy") return "healthy";
  if (health === "unhealthy") return "degraded";
  if (health === "starting") return "degraded";
  if (state.Running) return "healthy";
  if (state.Restarting || state.Paused) return "degraded";
  if (state.Dead || state.Exited) return "down";
  return "unknown";
}

async function probeContainers(names) {
  const raw = await run("docker", ["inspect", ...names], 6000);
  if (raw === null) {
    return names.map((name) => ({ name, status: "unknown", detail: { skipped: true, reason: "docker unavailable" } }));
  }
  let parsed = [];
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = [];
  }
  const byName = new Map(parsed.map((item) => [String(item.Name || "").replace(/^\//, ""), item]));
  return names.map((name) => {
    const inspect = byName.get(name);
    if (!inspect) return { name, status: "down", detail: { reason: "container not found" } };
    const state = inspect.State || {};
    return {
      name,
      status: classifyContainer(inspect),
      detail: {
        image: inspect.Config?.Image || null,
        running: Boolean(state.Running),
        health: state.Health?.Status || null,
        startedAt: state.StartedAt || null,
        restartPolicy: inspect.HostConfig?.RestartPolicy?.Name || null,
      },
    };
  });
}

async function probeUnits(units) {
  const results = [];
  for (const unit of units) {
    const active = await run("systemctl", ["is-active", unit], 4000);
    const enabled = await run("systemctl", ["is-enabled", unit], 4000);
    const activeState = active ? active.trim() : "unknown";
    results.push({
      name: unit,
      status: activeState === "active" ? "healthy"
        : activeState === "activating" || activeState === "reloading" ? "degraded"
        : activeState === "unknown" ? "unknown" : "down",
      detail: { active: activeState, enabled: enabled ? enabled.trim() : "unknown" },
    });
  }
  return results;
}

async function probeDisk() {
  const raw = await run("df", ["-kP", "/"], 4000);
  if (!raw) return null;
  const line = raw.trim().split("\n").at(-1) || "";
  const parts = line.split(/\s+/);
  if (parts.length < 6) return { raw: line.trim() };
  const totalKb = Number(parts[1]);
  const usedKb = Number(parts[2]);
  const availKb = Number(parts[3]);
  return {
    filesystem: parts[0],
    totalBytes: Number.isFinite(totalKb) ? totalKb * 1024 : null,
    usedBytes: Number.isFinite(usedKb) ? usedKb * 1024 : null,
    availableBytes: Number.isFinite(availKb) ? availKb * 1024 : null,
    usedPercent: Number.isFinite(totalKb) && totalKb > 0 ? Math.round((usedKb / totalKb) * 100) : null,
    mount: parts[5],
  };
}

function parseServiceConfig(env) {
  const raw = env.WITT_SERVER_SERVICES;
  if (!raw) return { http: DEFAULT_HTTP_SERVICES, containers: DEFAULT_CONTAINERS, units: DEFAULT_UNITS };
  try {
    const parsed = JSON.parse(raw);
    return {
      http: Array.isArray(parsed.http) ? parsed.http : DEFAULT_HTTP_SERVICES,
      containers: Array.isArray(parsed.containers) ? parsed.containers : DEFAULT_CONTAINERS,
      units: Array.isArray(parsed.units) ? parsed.units : DEFAULT_UNITS,
    };
  } catch {
    return { http: DEFAULT_HTTP_SERVICES, containers: DEFAULT_CONTAINERS, units: DEFAULT_UNITS };
  }
}

async function overview(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const config = parseServiceConfig(env);
  const checkedAt = new Date().toISOString();

  const http = [];
  for (const entry of config.http) {
    const probe = await probeHttp(entry, fetchImpl);
    http.push({ name: probe.name, url: probe.url, status: classifyHttp(probe), lastChecked: checkedAt, detail: probe });
  }

  const [containers, units, disk] = await Promise.all([
    probeContainers(config.containers),
    probeUnits(config.units),
    probeDisk(),
  ]);

  const totalMem = os.totalmem();
  const freeMem = os.freemem();

  return {
    host: os.hostname(),
    platform: `${os.platform()} ${os.release()}`,
    checkedAt,
    cpu: { count: os.cpus().length, load: os.loadavg(), model: os.cpus()[0]?.model || null },
    memory: {
      totalBytes: totalMem,
      freeBytes: freeMem,
      usedBytes: totalMem - freeMem,
      usedPercent: totalMem > 0 ? Math.round(((totalMem - freeMem) / totalMem) * 100) : null,
    },
    disk,
    uptimeSeconds: os.uptime(),
    http,
    containers,
    units,
    // Reported honestly: Open WebUI currently has no HTTPS hostname on this host.
    openWebuiUrl: options.openWebuiUrl || env.OPEN_WEBUI_URL || "",
    openWebuiTls: Boolean(options.openWebuiTls ?? (env.OPEN_WEBUI_URL || "").startsWith("https://")),
    readOnly: true,
  };
}

module.exports = {
  overview,
  probeHttp,
  probeContainers,
  probeUnits,
  probeDisk,
  classifyHttp,
  classifyContainer,
  parseServiceConfig,
  DEFAULT_HTTP_SERVICES,
  DEFAULT_CONTAINERS,
  DEFAULT_UNITS,
};
