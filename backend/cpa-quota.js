"use strict";
const fs = require("node:fs");

const FAMILY_IDS = ["grok", "gemini"];
const DEFAULT_QUOTA_CONCURRENCY = 4;
const MIN_QUOTA_CONCURRENCY = 1;
const MAX_QUOTA_CONCURRENCY = 32;
function quotaConcurrency(value) {
  if (value === undefined || value === null || String(value).trim() === "") return DEFAULT_QUOTA_CONCURRENCY;
  const raw = String(value).trim();
  if (!/^\d+$/.test(raw)) return DEFAULT_QUOTA_CONCURRENCY;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) return DEFAULT_QUOTA_CONCURRENCY;
  return Math.max(MIN_QUOTA_CONCURRENCY, Math.min(MAX_QUOTA_CONCURRENCY, parsed));
}
const numeric = (value) => {
  if (value && typeof value === "object") value = value.val;
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const percent = (value) => {
  const n = numeric(value);
  return n !== null && n <= 100 ? n : null;
};
const FULL_REMAINING_PERCENT = 99.999999;
const resetAt = (value) => {
  const n = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(n) ? new Date(n).toISOString() : null;
};
function grokRows(body, account) {
  const config = body?.config;
  if (!config || typeof config !== "object") return [];
  const rows = [];
  const monthlyTotal = numeric(config.monthlyLimit ?? config.monthly_limit);
  const monthlyUsed = numeric(config.used);
  if (monthlyTotal !== null && monthlyUsed !== null) {
    rows.push({
      account, label: "Grok 月度额度", window: "monthly", unit: "USD cents",
      total: monthlyTotal, used: monthlyUsed,
      remaining: Math.max(0, monthlyTotal - monthlyUsed),
      remainingPercent: monthlyTotal > 0 ? Math.max(0, 100 - monthlyUsed / monthlyTotal * 100) : null,
      resetAt: resetAt(config.billingPeriodEnd ?? config.billing_period_end),
    });
  }
  const period = config.currentPeriod ?? config.current_period ?? {};
  const window = /weekly/i.test(period.type ?? "") ? "weekly" : /monthly/i.test(period.type ?? "") ? "monthly" : "unknown";
  const periodStart = resetAt(period.start);
  const periodEnd = resetAt(period.end ?? config.billingPeriodEnd ?? config.billing_period_end);
  let used = percent(config.creditUsagePercent ?? config.credit_usage_percent);
  // Grok's protobuf JSON omits the scalar at an exact 0%. A valid weekly
  // period plus explicit zero spend fields is the observable zero-usage shape.
  if (used === null && window === "weekly" && periodStart && periodEnd &&
      numeric(config.onDemandCap ?? config.on_demand_cap) === 0 &&
      numeric(config.onDemandUsed ?? config.on_demand_used) === 0) used = 0;
  if (used !== null) rows.push({
    account, label: window === "weekly" ? "Grok 周额度" : "Grok Credits", window,
    unit: null, total: null, used: null, remaining: null,
    remainingPercent: 100 - used,
    resetAt: periodEnd,
  });
  return rows;
}
function geminiRows(body, account) {
  const rows = [];
  for (const group of Array.isArray(body?.groups) ? body.groups : []) {
    const label = String(group.displayName ?? group.display_name ?? "");
    if (!/gemini/i.test(label)) continue;
    for (const bucket of Array.isArray(group.buckets) ? group.buckets : []) {
      const raw = bucket.remainingFraction ?? bucket.remaining_fraction;
      const fraction = typeof raw === "string" && raw.trim().endsWith("%")
        ? ((n) => n === null ? null : n / 100)(numeric(raw.trim().slice(0, -1))) : numeric(raw);
      if (fraction === null || !Number.isFinite(fraction) || fraction > 1) continue;
      const window = String(bucket.window || "").toLowerCase();
      rows.push({
        account, label: "Gemini 模型组", window: ["daily", "weekly", "monthly", "five_hour"].includes(window) ? window : "unknown",
        unit: null, total: null, used: null, remaining: null,
        remainingPercent: fraction * 100,
        resetAt: resetAt(bucket.resetTime ?? bucket.reset_time),
      });
    }
  }
  return rows;
}
function summarize(rows) {
  const known = rows.filter((row) => row.remainingPercent !== null);
  if (!known.length) return { remainingPercent: null, basis: "unknown", total: null, used: null, remaining: null, unit: null };
  // Sum only comparable, complete absolute quotas in the same unit/window/reset.
  const comparable = rows.length === known.length && rows.every((row) =>
    row.total !== null && row.total > 0 && row.used !== null &&
    row.unit === rows[0].unit && row.window !== "unknown" && row.window === rows[0].window && row.resetAt !== null && row.resetAt === rows[0].resetAt);
  if (comparable) {
    const total = rows.reduce((sum, row) => sum + row.total, 0);
    const used = rows.reduce((sum, row) => sum + row.used, 0);
    const remaining = rows.reduce((sum, row) => sum + row.remaining, 0);
    return { total, used, remaining, unit: rows[0].unit, remainingPercent: Math.min(100, remaining / total * 100), basis: "total" };
  }
  return { remainingPercent: Math.min(...known.map((row) => row.remainingPercent)), basis: "lowest", total: null, used: null, remaining: null, unit: null };
}
function summarizeAccounts(rows, accountCount = null) {
  const accounts = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || (typeof row.account !== "number" && typeof row.account !== "string") || String(row.account).trim() === "") continue;
    const key = String(row.account);
    if (!accounts.has(key)) accounts.set(key, null);
    const remainingPercent = percent(row.remainingPercent);
    if (remainingPercent !== null) {
      const previous = accounts.get(key);
      accounts.set(key, previous === null ? remainingPercent : Math.min(previous, remainingPercent));
    }
  }
  const result = { full: 0, partial: 0, exhausted: 0, unknown: 0 };
  for (const remainingPercent of accounts.values()) {
    if (remainingPercent === null) result.unknown++;
    else if (remainingPercent >= FULL_REMAINING_PERCENT) result.full++;
    else if (remainingPercent <= 0) result.exhausted++;
    else result.partial++;
  }
  const total = Number.isSafeInteger(accountCount) && accountCount >= 0 ? accountCount : accounts.size;
  result.unknown += Math.max(0, total - accounts.size);
  return result;
}
class CpaQuotaService {
  constructor(options = {}) {
    this.env = options.env || process.env;
    this.fetch = options.fetchImpl || globalThis.fetch;
    this.now = options.now || Date.now;
    this.cache = null;
    this.pending = null;
  }
  key() {
    const file = this.env.WITT_CPA_MANAGEMENT_KEY_FILE;
    if (file) {
      try {
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size > 16384) return "";
        return fs.readFileSync(file, "utf8").trim();
      } catch { return ""; }
    }
    return String(this.env.WITT_CPA_MANAGEMENT_KEY || "").trim();
  }
  root() {
    const url = new URL(this.env.WITT_CPA_URL || "http://127.0.0.1:8317/v1");
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("invalid_endpoint");
    url.pathname = url.pathname.replace(/\/v1\/?$/, "").replace(/\/$/, "");
    return url.toString().replace(/\/$/, "");
  }
  async json(path, key, body) {
    const response = await this.fetch(this.root() + path, {
      method: body ? "POST" : "GET",
      headers: { ...(key ? { Authorization: "Bearer " + key } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5000), redirect: "error",
    });
    if (!response.ok) throw Object.assign(new Error("upstream_error"), { status: response.status });
    // Bound responses, including chunked bodies.
    const reader = response.body?.getReader();
    if (!reader) return response.json();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2 * 1024 * 1024) throw new Error("response_too_large");
        chunks.push(Buffer.from(value));
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  async proxy(key, account, url, data, extraHeaders = {}) {
    const response = await this.json("/v0/management/api-call", key, {
      authIndex: String(account.auth_index ?? account.authIndex),
      method: data ? "POST" : "GET", url,
      header: { Authorization: "Bearer $TOKEN$", ...extraHeaders, ...(data ? { "Content-Type": "application/json" } : {}) },
      ...(data ? { data: JSON.stringify(data) } : {}),
    });
    if (Number(response.status_code) < 200 || Number(response.status_code) >= 300) {
      throw Object.assign(new Error("quota_unavailable"), { status: Number(response.status_code) });
    }
    return typeof response.body === "string" ? JSON.parse(response.body) : response.body;
  }
  async collect() {
    const payload = {
      provider: "cpa", status: "unknown", checkedAt: new Date(this.now()).toISOString(), quotaCheckedAt: null,
      stale: false, cached: false,
      families: FAMILY_IDS.map((id) => ({ id, modelCount: null, status: "unknown", accounts: null, checkedAccounts: 0, failedAccounts: 0, skippedAccounts: 0, rows: [], accountCapacity: summarizeAccounts([]), ...summarize([]) })),
    };
    const discovery = this.json("/v1/models", this.env.WITT_CPA_API_KEY || "").then((body) => {
      if (!Array.isArray(body?.data)) return;
      for (const family of payload.families) family.modelCount = body.data.filter((model) => String(model.id || "").toLowerCase().startsWith(family.id)).length;
    }).catch(() => {});
    const key = this.key();
    if (!key) {
      payload.status = "management_auth_required";
      for (const family of payload.families) family.status = payload.status;
      await discovery;
      return payload;
    }
    let credentials;
    try {
      let body;
      try { body = await this.json("/v0/management/credentials", key); }
      catch (error) { if (error.status !== 404) throw error; body = await this.json("/v0/management/auth-files", key); }
      credentials = Array.isArray(body) ? body : body.files ?? body.credentials;
      if (!Array.isArray(credentials)) throw new Error("unsupported_schema");
    } catch (error) {
      payload.status = [401, 403].includes(error.status) ? "management_auth_required" : "quota_unavailable";
      for (const family of payload.families) family.status = payload.status;
      await discovery;
      return payload;
    }
    const jobs = [];
    for (const family of payload.families) family.accounts = 0;
    for (const account of credentials) {
      if (!account || typeof account !== "object" || Array.isArray(account)) continue;
      if (account.disabled === true || account.status === "disabled") continue;
      const provider = String(account.provider ?? account.type ?? "").toLowerCase();
      const family = payload.families.find((item) => item.id === (/^(xai|grok)$/.test(provider) ? "grok" : /^(antigravity|gemini|gemini-cli)$/.test(provider) ? "gemini" : ""));
      if (!family) continue;
      family.accounts++;
      jobs.push({ account, family, number: family.accounts });
    }
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(quotaConcurrency(this.env.WITT_CPA_QUOTA_CONCURRENCY), jobs.length) }, async () => {
      while (cursor < jobs.length) {
        const { account, family, number } = jobs[cursor++];
        try {
          if (!String(account.auth_index ?? account.authIndex ?? "").trim()) throw new Error("missing_account_index");
          let rows;
          if (family.id === "grok") {
            const header = { "x-xai-token-auth": "xai-grok-cli", "x-grok-client-version": "0.2.91", accept: "application/json" };
            const userId = account.sub ?? account.user_id ?? account.metadata?.sub;
            if (typeof userId === "string" && userId.length < 256) header["x-userid"] = userId;
            const body = await this.proxy(key, account, "https://cli-chat-proxy.grok.com/v1/billing?format=credits", null, header);
            rows = grokRows(body, number);
          } else {
            const project = account.project_id ?? account.projectId ?? account.metadata?.project_id ?? account.attributes?.project_id ?? account.attributes?.gemini_virtual_project;
            if (typeof project !== "string" || !project.trim()) throw new Error("missing_project");
            const body = await this.proxy(key, account, "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", { project }, {
              "User-Agent": "antigravity/cli/1.0.13 aidev_client (darwin; arm64)",
            });
            rows = geminiRows(body, number);
          }
          if (!rows.length) throw new Error("quota_not_reported");
          family.rows.push(...rows);
          family.checkedAccounts++;
        } catch { family.failedAccounts++; }
      }
    }));
    for (const family of payload.families) {
      Object.assign(family, summarize(family.rows), { accountCapacity: summarizeAccounts(family.rows, family.accounts) });
      family.status = family.accounts === 0 ? "no_accounts" : family.checkedAccounts === 0 ? "quota_unavailable" :
        family.failedAccounts || family.skippedAccounts ? "partial" : "ready";
    }
    payload.status = payload.families.some((item) => item.status === "ready" || item.status === "partial") ? "ready" : "quota_unavailable";
    if (payload.families.some((item) => item.checkedAccounts)) payload.quotaCheckedAt = payload.checkedAt;
    await discovery;
    return payload;
  }
  async read(options = {}) {
    const force = options && typeof options === "object" && options.force === true;
    if (this.pending) return this.pending;
    if (!force && this.cache && this.now() - this.cache.time < 30000) return { ...this.cache.value, cached: true };
    this.pending = this.collect().then((value) => {
      // Never replace previously known numbers with invented zeros on refresh failures.
      if (this.cache?.value.quotaCheckedAt && !value.quotaCheckedAt) {
        const old = this.cache.value;
        value = { ...old, status: value.status, checkedAt: value.checkedAt, stale: true, cached: false };
      }
      this.cache = { time: this.now(), value };
      return value;
    }).finally(() => { this.pending = null; });
    return this.pending;
  }
}
module.exports = { CpaQuotaService, grokRows, geminiRows, summarize, summarizeAccounts };
