"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { CpaQuotaService, grokRows, geminiRows, summarize, summarizeAccounts } = require("./cpa-quota");
const { createCpaQuotaRoutes } = require("./routes/cpa-quota");
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
test("missing management authentication returns real model counts and unknown quotas", async () => {
  const calls = [];
  const service = new CpaQuotaService({ env: { WITT_CPA_API_KEY: "secret-sentinel" }, fetchImpl: async (url) => {
    calls.push(url); return reply({ data: [{ id: "grok-4.7-high" }, { id: "gemini-3-flash" }] });
  } });
  const body = await service.read();
  assert.equal(body.status, "management_auth_required");
  assert.deepEqual(body.families.map((item) => item.modelCount), [1, 1]);
  assert.ok(body.families.every((item) => item.total === null && item.remainingPercent === null));
  assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(body).includes("secret-sentinel"), false);
  assert.deepEqual(body.families.map((item) => item.accountCapacity), [
    { full: 0, partial: 0, exhausted: 0, unknown: 0 },
    { full: 0, partial: 0, exhausted: 0, unknown: 0 },
  ]);
});
test("quota units, unknown totals, malformed data and incompatible windows are not fabricated", () => {
  assert.deepEqual(grokRows({ config: { used: null, monthlyLimit: "", creditUsagePercent: "bad" } }, 1), []);
  const monthly = grokRows({ config: { monthlyLimit: { val: 10000 }, used: { val: 2500 }, billingPeriodEnd: "2026-11-01T00:00:00Z" } }, 1);
  assert.equal(monthly[0].remainingPercent, 75);
  assert.equal(summarize([...monthly, ...monthly]).total, 20000);
  const mixed = [...monthly, ...grokRows({ config: { creditUsagePercent: 20, currentPeriod: { type: "weekly" } } }, 2)];
  assert.equal(summarize(mixed).basis, "lowest");
  assert.equal(summarize(mixed).total, null);
  const rows = geminiRows({ groups: [
    { displayName: "Gemini", buckets: [{ remainingFraction: .6 }, { remaining_fraction: "20%" }, { remainingFraction: "invalid%" }, { remainingFraction: 2 }, { remainingFraction: null }] },
    { displayName: "Claude", buckets: [{ remainingFraction: .9 }] },
  ] }, 1);
  assert.equal(rows.length, 2);
  assert.equal(summarize(rows).remainingPercent, 20);
  assert.equal(summarize(rows).total, null);
});
test("Grok weekly protobuf zero shape reports a real unused window", () => {
  const rows = grokRows({ config: {
    currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-10-01T00:00:00Z", end: "2026-10-08T00:00:00Z" },
    onDemandCap: { val: 0 }, onDemandUsed: { val: 0 }, isUnifiedBillingUser: true,
  } }, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, "Grok 周额度");
  assert.equal(rows[0].window, "weekly");
  assert.equal(rows[0].remainingPercent, 100);
  assert.equal(rows[0].resetAt, "2026-10-08T00:00:00.000Z");
});
test("account capacity uses the lowest valid window without exposing account identities", () => {
  const rows = [
    { account: 1, remainingPercent: 100 },
    { account: 1, remainingPercent: 99.9999995 },
    { account: 2, remainingPercent: 100 },
    { account: 2, remainingPercent: 75 },
    { account: 3, remainingPercent: 0 },
    { account: 3, remainingPercent: null },
    { account: 4, remainingPercent: null },
    { account: 5, remainingPercent: 101 },
  ];
  assert.deepEqual(summarizeAccounts(rows, 9), { full: 1, partial: 1, exhausted: 1, unknown: 6 });
  assert.deepEqual(summarizeAccounts([], 0), { full: 0, partial: 0, exhausted: 0, unknown: 0 });
  assert.deepEqual(summarizeAccounts(null), { full: 0, partial: 0, exhausted: 0, unknown: 0 });
  assert.equal(JSON.stringify(summarizeAccounts(rows, 9)).includes("account"), false);
});
test("real-shaped CPA account responses aggregate without exposing identities or credentials", async () => {
  const calls = [];
  const service = new CpaQuotaService({
    env: { WITT_CPA_MANAGEMENT_KEY: "management-sentinel", WITT_CPA_API_KEY: "model-sentinel" },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/v1/models")) return reply({ data: [{ id: "grok-4.7-high" }, { id: "gemini-3-flash" }] });
      if (url.endsWith("/credentials")) return reply({ files: [
        { provider: "xai", auth_index: "private-index-one", email: "private-email", api_key: "private-secret" },
        { provider: "antigravity", auth_index: "private-index-two", project_id: "private-project" },
        { provider: "xai", auth_index: "disabled", disabled: true },
      ] });
      assert.ok(url.endsWith("/v0/management/api-call"));
      const request = JSON.parse(options.body);
      assert.equal(request.header.Authorization, "Bearer $TOKEN$");
      if (request.url.includes("grok.com")) {
        assert.equal(request.method, "GET");
        return reply({ status_code: 200, body: JSON.stringify({ config: { creditUsagePercent: 30, currentPeriod: { type: "weekly" } } }) });
      }
      assert.equal(request.method, "POST");
      assert.ok(request.url.endsWith(":retrieveUserQuotaSummary"));
      return reply({ status_code: 200, body: { groups: [{ displayName: "Gemini", buckets: [{ remainingFraction: .4, window: "weekly" }] }] } });
    },
  });
  const [first, second] = await Promise.all([service.read(), service.read()]);
  assert.deepEqual(first, second);
  assert.deepEqual(first.families.map((item) => item.remainingPercent), [70, 40]);
  assert.deepEqual(first.families.map((item) => item.accountCapacity), [
    { full: 0, partial: 1, exhausted: 0, unknown: 0 },
    { full: 0, partial: 1, exhausted: 0, unknown: 0 },
  ]);
  assert.equal(first.status, "ready");
  const serialized = JSON.stringify(first);
  for (const secret of ["management-sentinel", "model-sentinel", "private-index", "private-email", "private-secret", "private-project"]) assert.equal(serialized.includes(secret), false);
  assert.equal(calls.length, 4);
  assert.equal((await service.read()).cached, true);
  assert.equal(calls.length, 4);
});
test("all eligible accounts are checked with bounded concurrency", async () => {
  const credentials = Array.from({ length: 9 }, (_, index) => ({
    provider: "xai", auth_index: `private-index-${index}`,
  }));
  let active = 0;
  let maxActive = 0;
  let quotaCalls = 0;
  const service = new CpaQuotaService({
    env: { WITT_CPA_MANAGEMENT_KEY: "management-sentinel", WITT_CPA_QUOTA_CONCURRENCY: "2" },
    fetchImpl: async (url, options) => {
      if (url.endsWith("/v1/models")) return reply({ data: [] });
      if (url.endsWith("/credentials")) return reply({ files: credentials });
      const request = JSON.parse(options.body);
      assert.equal(request.url, "https://cli-chat-proxy.grok.com/v1/billing?format=credits");
      quotaCalls++;
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return reply({ status_code: 200, body: { config: { creditUsagePercent: 10 } } });
    },
  });
  const body = await service.read();
  const family = body.families.find((item) => item.id === "grok");
  assert.equal(family.accounts, credentials.length);
  assert.equal(family.checkedAccounts, credentials.length);
  assert.equal(family.failedAccounts, 0);
  assert.equal(family.skippedAccounts, 0);
  assert.equal(family.rows.length, credentials.length);
  assert.equal(quotaCalls, credentials.length);
  assert.equal(maxActive, 2);
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes("private-index-"), false);
});
test("ordinary reads use cache while force reads refresh and share pending work", async () => {
  let quotaCalls = 0;
  const service = new CpaQuotaService({
    env: { WITT_CPA_MANAGEMENT_KEY: "management-sentinel" },
    fetchImpl: async (url) => {
      if (url.endsWith("/v1/models")) return reply({ data: [] });
      if (url.endsWith("/credentials")) return reply({ files: [{ provider: "xai", auth_index: "private-index" }] });
      quotaCalls++;
      return reply({ status_code: 200, body: { config: { creditUsagePercent: 10 } } });
    },
  });
  await service.read();
  const cached = await service.read();
  assert.equal(cached.cached, true);
  assert.equal(quotaCalls, 1);
  const refreshed = await service.read({ force: true });
  assert.equal(refreshed.cached, false);
  assert.equal(quotaCalls, 2);
  const [first, second] = await Promise.all([service.read({ force: true }), service.read({ force: true })]);
  assert.strictEqual(first, second);
  assert.equal(quotaCalls, 3);
});
test("upstream authentication errors and partial account failures are explicit and sanitized", async () => {
  const service = new CpaQuotaService({ env: { WITT_CPA_MANAGEMENT_KEY: "secret" }, fetchImpl: async (url) =>
    url.endsWith("/v1/models") ? reply({ data: [] }) : reply({ error: "private-upstream-message" }, 401),
  });
  const body = await service.read();
  assert.equal(body.status, "management_auth_required");
  assert.equal(JSON.stringify(body).includes("private-upstream-message"), false);
});
test("refresh failure retains last successful quotas with an explicit stale timestamp", async () => {
  let now = Date.parse("2026-10-03T00:00:00Z");
  let fail = false;
  const service = new CpaQuotaService({ now: () => now, env: { WITT_CPA_MANAGEMENT_KEY: "secret" }, fetchImpl: async (url) => {
    if (url.endsWith("/v1/models")) return reply({ data: [] });
    if (fail) return reply({}, 503);
    if (url.endsWith("/credentials")) return reply({ files: [{ provider: "xai", auth_index: "one" }] });
    return reply({ status_code: 200, body: { config: { creditUsagePercent: 10 } } });
  } });
  const first = await service.read();
  now += 31000; fail = true;
  const after = await service.read();
  assert.equal(after.stale, true);
  assert.equal(after.families[0].remainingPercent, 90);
  assert.equal(after.quotaCheckedAt, first.quotaCheckedAt);
  assert.notEqual(after.checkedAt, first.checkedAt);
});
test("global CPA quotas require administrator authorization and reject writes", async () => {
  let called = false;
  const sent = [];
  const handler = createCpaQuotaRoutes({ service: { read() { called = true; return Promise.resolve({}); } }, sendJson: (_, status, body) => sent.push({ status, body }) });
  const url = new URL("http://localhost/providers/cpa/quotas");
  assert.equal(handler({ method: "GET" }, {}, url, null), true);
  assert.equal(sent.at(-1).status, 403);
  handler({ method: "GET" }, {}, url, { admin: false });
  assert.equal(sent.at(-1).status, 403);
  handler({ method: "POST" }, {}, url, { admin: true });
  assert.equal(sent.at(-1).status, 405);
  assert.equal(called, false);
  handler({ method: "GET" }, { setHeader() {} }, url, { admin: true });
  assert.equal(called, true);
  assert.equal(handler({}, {}, new URL("http://localhost/other"), { admin: true }), false);
});
test("quota route forwards refresh=1 as a forced administrator refresh", async () => {
  const calls = [];
  const sent = [];
  const handler = createCpaQuotaRoutes({
    service: { read(options) { calls.push(options); return Promise.resolve({}); } },
    sendJson: (_, status, body) => sent.push({ status, body }),
  });
  const response = { setHeader() {} };
  handler({ method: "GET" }, response, new URL("http://localhost/providers/cpa/quotas"), { admin: true });
  await new Promise((resolve) => setImmediate(resolve));
  handler({ method: "GET" }, response, new URL("http://localhost/providers/cpa/quotas?refresh=1"), { admin: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [{ force: false }, { force: true }]);
  assert.equal(sent.length, 2);
  assert.ok(sent.every((item) => item.status === 200));
});
test("endpoint credentials and redirects cannot be used to leak management keys", async () => {
  let calls = 0;
  const service = new CpaQuotaService({ env: { WITT_CPA_URL: "http://user:secret@localhost/v1", WITT_CPA_MANAGEMENT_KEY: "secret" }, fetchImpl: async () => { calls++; } });
  const body = await service.read();
  assert.equal(calls, 0);
  assert.equal(body.status, "quota_unavailable");
});
