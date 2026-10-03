"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { CpaQuotaService, grokRows, geminiRows, summarize } = require("./cpa-quota");
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
  assert.equal(first.status, "ready");
  const serialized = JSON.stringify(first);
  for (const secret of ["management-sentinel", "model-sentinel", "private-index", "private-email", "private-secret", "private-project"]) assert.equal(serialized.includes(secret), false);
  assert.equal(calls.length, 4);
  assert.equal((await service.read()).cached, true);
  assert.equal(calls.length, 4);
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
test("endpoint credentials and redirects cannot be used to leak management keys", async () => {
  let calls = 0;
  const service = new CpaQuotaService({ env: { WITT_CPA_URL: "http://user:secret@localhost/v1", WITT_CPA_MANAGEMENT_KEY: "secret" }, fetchImpl: async () => { calls++; } });
  const body = await service.read();
  assert.equal(calls, 0);
  assert.equal(body.status, "quota_unavailable");
});
