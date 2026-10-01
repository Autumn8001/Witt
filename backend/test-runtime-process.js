"use strict";

// Process-level tests: crash isolation, timeouts, malformed output, provider
// protocol selection and Server Center health mapping. Runs offline.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { HarnessProcess } = require("./runtime/harness-process");
const { parseGrokEvent } = require("./runtime/event-parsers");
const { ProviderRegistry, PROTOCOLS } = require("./runtime/provider-registry");
const {
  classifyHttp, classifyContainer, probeHttp, overview,
  parseServiceConfig, DEFAULT_HTTP_SERVICES, wittPort, defaultHttpServices,
  DEFAULT_WITT_PORT,
} = require("./runtime/server-center");

const NODE_BIN = process.execPath;

function fakeHarness(source, options = {}) {
  const harnessProcess = new HarnessProcess({
    harness: "grok-build",
    bin: NODE_BIN,
    args: ["-e", source],
    env: options.env || {},
    parser: parseGrokEvent,
    timeoutMs: options.timeoutMs || 15000,
    terminateGraceMs: options.terminateGraceMs,
  });
  const events = [];
  const invalid = [];
  harnessProcess.on("event", (event) => events.push(event));
  harnessProcess.on("invalid", (line) => invalid.push(line));
  return { process: harnessProcess, events, invalid };
}

test("harness process maps a clean NDJSON stream and exits ok", async () => {
  const { process: harness, events, invalid } = fakeHarness(`
    process.stdout.write(JSON.stringify({type:"thought",data:"t"})+"\\n");
    process.stdout.write(JSON.stringify({type:"text",data:"Hello"})+"\\n");
    process.stdout.write(JSON.stringify({type:"end",sessionId:"s-42",stopReason:"end_turn"})+"\\n");
  `);
  harness.start();
  const result = await harness.whenDone();
  assert.equal(result.ok, true);
  assert.equal(result.code, 0);
  assert.equal(events.length, 3);
  assert.equal(events[1].text, "Hello");
  assert.equal(events[2].sessionId, "s-42");
  assert.equal(invalid.length, 0);
});

test("a crashing harness is reported, not thrown, and keeps partial output", async () => {
  const { process: harness, events } = fakeHarness(`
    process.stdout.write(JSON.stringify({type:"text",data:"partial"})+"\\n");
    process.stderr.write("simulated provider failure\\n");
    process.exit(7);
  `);
  harness.start();
  const result = await harness.whenDone();
  assert.equal(result.ok, false);
  assert.equal(result.code, 7);
  assert.equal(result.errorType, "exit_nonzero");
  assert.equal(events.length, 1);
  assert.equal(events[0].text, "partial");
  assert.match(result.stderr, /simulated provider failure/);
  // The backend process itself is untouched.
  assert.equal(typeof process.pid, "number");
});

test("malformed lines never crash the reader and are recorded", async () => {
  const { process: harness, events, invalid } = fakeHarness(`
    process.stdout.write("this is not json\\n");
    process.stdout.write(JSON.stringify({type:"text",data:"ok"})+"\\n");
    process.stdout.write("{broken json\\n");
  `);
  harness.start();
  const result = await harness.whenDone();
  assert.equal(result.ok, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].text, "ok");
  assert.equal(invalid.length, 2);
  assert.equal(result.invalidLines.length, 2);
});

test("a hung harness is killed by the timeout and reported", async () => {
  const harness = new HarnessProcess({
    harness: "grok-build",
    bin: process.execPath,
    args: ["-e", "setTimeout(()=>{}, 60000);"],
    env: {},
    parser: parseGrokEvent,
    timeoutMs: 1200,
  });
  let timedOut = false;
  harness.on("timeout", () => { timedOut = true; });
  harness.start();
  const result = await harness.whenDone();
  assert.equal(timedOut, true);
  assert.equal(result.timedOut, true);
  assert.equal(result.ok, false);
  assert.equal(result.errorType, "timeout");
});

test("a missing binary settles with a spawn error instead of throwing", async () => {
  const harness = new HarnessProcess({
    harness: "grok-build",
    bin: path.join(os.tmpdir(), "definitely-not-a-real-binary-xyz"),
    args: [],
    env: {},
    parser: parseGrokEvent,
    timeoutMs: 5000,
  });
  harness.start();
  const result = await harness.whenDone();
  assert.ok(result);
  assert.equal(result.ok, false);
  assert.equal(result.errorType, "spawn_error");
  assert.strictEqual(await harness.whenDone(), result);
});

test("a synchronous spawn failure still resolves whenDone with a result", async () => {
  const harness = new HarnessProcess({
    harness: "grok-build",
    bin: null,
    args: [],
    env: {},
    parser: parseGrokEvent,
    timeoutMs: 5000,
  });
  harness.start();
  const result = await harness.whenDone();
  assert.ok(result);
  assert.equal(result.ok, false);
  assert.equal(result.errorType, "spawn_error");
});

test("child environment excludes inherited secrets but accepts explicit values", async () => {
  const inheritedKey = `HARNESS_PROCESS_SECRET_${process.pid}`;
  const explicitKey = `HARNESS_PROCESS_EXPLICIT_${process.pid}`;
  const inheritedValue = "sentinel-secret-must-not-cross";
  const explicitValue = "explicit-value-may-cross";
  process.env[inheritedKey] = inheritedValue;
  try {
    const { process: harness, events } = fakeHarness(`
      process.stdout.write(JSON.stringify({type:"text",data:JSON.stringify({
        inherited: process.env[${JSON.stringify(inheritedKey)}] || null,
        explicit: process.env[${JSON.stringify(explicitKey)}] || null,
        hasPath: Boolean(process.env.PATH),
      })})+"\\n");
    `, { env: { [explicitKey]: explicitValue } });
    harness.start();
    const result = await harness.whenDone();
    assert.equal(result.ok, true);
    assert.equal(events.length, 1);
    const observed = JSON.parse(events[0].text);
    assert.equal(observed.inherited, null);
    assert.equal(observed.explicit, explicitValue);
    assert.equal(observed.hasPath, true);
  } finally {
    delete process.env[inheritedKey];
  }
});

test("terminate escalates an ignored SIGTERM to SIGKILL", async () => {
  const { process: harness } = fakeHarness(`
    process.on("SIGTERM", () => {});
    process.stdout.write(JSON.stringify({type:"text",data:"ready"})+"\\n");
    setInterval(() => {}, 1000);
  `, { timeoutMs: 5000, terminateGraceMs: 100 });
  let terminateResult = null;
  harness.on("event", (event) => {
    if (event.text === "ready") terminateResult = harness.terminate();
  });
  harness.start();
  const result = await harness.whenDone();
  assert.equal(terminateResult, true);
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, false);
  assert.equal(harness.terminationTimer, null);
  if (process.platform !== "win32") assert.equal(result.signal, "SIGKILL");
});

test("the trailing line without a newline terminator is still parsed", async () => {
  const { process: harness, events } = fakeHarness(
    `process.stdout.write(JSON.stringify({type:"text",data:"tail"}));`);
  harness.start();
  await harness.whenDone();
  assert.equal(events.length, 1);
  assert.equal(events[0].text, "tail");
});

// --------------------------------------------------------------------------
// Provider protocol selection
// --------------------------------------------------------------------------
test("provider registry records protocol and refuses secrets in URLs", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "witt-prov-"));
  const registry = new ProviderRegistry({ file: path.join(directory, "providers.json") });
  for (const protocol of PROTOCOLS) {
    const created = registry.upsert({
      id: `p-${protocol}`, name: protocol, base_url: "http://127.0.0.1:9000/v1",
      protocol, secret_ref: "SECRET_ENV", secret: "value-should-not-surface",
    });
    assert.equal(created.protocol, protocol);
    assert.equal(created.secret, undefined);
    assert.equal(created.secret_display, "Configured");
  }
  assert.throws(() => registry.upsert({
    id: "bad-proto", name: "bad", base_url: "http://127.0.0.1:1/v1", protocol: "carrier-pigeon",
  }));
  assert.throws(() => registry.upsert({
    id: "bad-url", name: "bad",
    base_url: "http://127.0.0.1:1/v1?api_key=leaked", protocol: "openai-responses",
  }));
  assert.throws(() => registry.upsert({
    id: "Bad Id", name: "bad", base_url: "http://127.0.0.1:1/v1", protocol: "openai-responses",
  }));
  // Nothing secret may appear in a list response.
  assert.equal(JSON.stringify(registry.list()).includes("value-should-not-surface"), false);
  assert.equal(registry.secretFor("p-openai-responses"), "value-should-not-surface");
});

test("provider health check records discovery and maps failures", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "witt-prov2-"));
  const registry = new ProviderRegistry({ file: path.join(directory, "providers.json") });
  registry.upsert({
    id: "cpa", name: "CPA", base_url: "http://127.0.0.1:8317/v1",
    protocol: "openai-responses", model_discovery: "http://127.0.0.1:8317/v1/models",
  });
  const healthy = await registry.check("cpa", async () => ({
    ok: true, status: 200, json: async () => ({ data: [{ id: "grok-4.7-high" }, { id: "gemini-3.8-flash-high" }] }),
  }));
  assert.equal(healthy.health, "healthy");
  assert.deepEqual(healthy.discovered_models, ["grok-4.7-high", "gemini-3.8-flash-high"]);

  const down = await registry.check("cpa", async () => { throw new Error("ECONNREFUSED"); });
  assert.equal(down.health, "down");
  assert.match(down.last_error, /ECONNREFUSED/);
});

// --------------------------------------------------------------------------
// Server Center
// --------------------------------------------------------------------------
test("http health classification distinguishes healthy, degraded, down", () => {
  assert.equal(classifyHttp({ ok: true, status: 200 }), "healthy");
  assert.equal(classifyHttp({ ok: false, status: 401 }), "degraded");
  assert.equal(classifyHttp({ ok: false, status: 404 }), "degraded");
  assert.equal(classifyHttp({ ok: false, status: 502 }), "down");
  assert.equal(classifyHttp({ ok: false, errorType: "timeout" }), "down");
  assert.equal(classifyHttp({ skipped: true }), "unknown");
  assert.equal(classifyHttp(null), "unknown");
});

test("container classification prefers healthcheck then running state", () => {
  assert.equal(classifyContainer({ State: { Running: true, Health: { Status: "healthy" } } }), "healthy");
  assert.equal(classifyContainer({ State: { Running: true, Health: { Status: "unhealthy" } } }), "degraded");
  assert.equal(classifyContainer({ State: { Running: true, Health: { Status: "starting" } } }), "degraded");
  assert.equal(classifyContainer({ State: { Running: true } }), "healthy");
  assert.equal(classifyContainer({ State: { Running: false, Exited: true } }), "down");
  assert.equal(classifyContainer({ skipped: true }), "unknown");
});

test("health probes time out and report unreachable without throwing", async () => {
  const timeout = await probeHttp({ name: "x", url: "http://127.0.0.1:1" },
    async () => { throw new Error("connect ECONNREFUSED"); });
  assert.equal(timeout.ok, false);
  assert.equal(timeout.errorType, "unreachable");
  const ok = await probeHttp({ name: "y", url: "http://127.0.0.1:2" },
    async () => ({ ok: true, status: 200 }));
  assert.equal(ok.ok, true);
  assert.equal(ok.status, 200);
});

test("server center reports real resources, services and the Open WebUI config", async () => {
  const env = { OPEN_WEBUI_URL: "" };
  const report = await overview({
    env,
    fetchImpl: async (url) => ({
      ok: url.endsWith("/healthz") || url.endsWith("/health"),
      status: url.endsWith("/healthz") || url.endsWith("/health") ? 200 : 404,
    }),
  });
  assert.ok(report.host.length > 0);
  assert.ok(report.cpu.count >= 1);
  assert.ok(report.memory.totalBytes > 0);
  assert.equal(typeof report.uptimeSeconds, "number");
  assert.ok(Array.isArray(report.containers) && report.containers.length > 0);
  assert.ok(Array.isArray(report.units) && report.units.length > 0);
  assert.equal(report.readOnly, true);
  assert.equal(report.openWebuiUrl, "");
  assert.equal(report.openWebuiTls, false);
  // Every entry must carry a status from the agreed vocabulary.
  const allowed = new Set(["healthy", "degraded", "down", "unknown"]);
  for (const entry of [...report.http, ...report.containers, ...report.units]) {
    assert.ok(allowed.has(entry.status), `${entry.name} had ${entry.status}`);
  }
  // The page is read-only: no action surface may be present.
  assert.equal(Object.hasOwn(report, "actions"), false);
  assert.equal(JSON.stringify(report.containers).includes('"actions"'), false);
  assert.equal(JSON.stringify(report.units).includes('"actions"'), false);
});

test("server center surfaces a configured Open WebUI URL and flags plaintext", async () => {
  const plain = await overview({
    env: { OPEN_WEBUI_URL: "http://186.244.203.27:3000/" },
    fetchImpl: async () => ({ ok: true, status: 200 }),
  });
  assert.equal(plain.openWebuiUrl, "http://186.244.203.27:3000/");
  assert.equal(plain.openWebuiTls, false);
  const secure = await overview({
    env: { OPEN_WEBUI_URL: "https://ops.example.test/" },
    fetchImpl: async () => ({ ok: true, status: 200 }),
  });
  assert.equal(secure.openWebuiTls, true);
});

test("service configuration is overridable and falls back safely", () => {
  const custom = parseServiceConfig({
    WITT_SERVER_SERVICES: JSON.stringify({
      http: [{ name: "custom", url: "http://127.0.0.1:9/health" }],
      containers: ["only-me"], units: ["nginx"],
    }),
  });
  assert.equal(custom.http[0].name, "custom");
  assert.deepEqual(custom.containers, ["only-me"]);
  const broken = parseServiceConfig({ WITT_SERVER_SERVICES: "{not json" });
  // Compared by content: the defaults are now built per environment so that the
  // witt probe can follow the bound port.
  assert.deepEqual(broken.http, defaultHttpServices({}));
  const empty = parseServiceConfig({});
  assert.deepEqual(empty.http, defaultHttpServices({}));
  assert.equal(empty.http.find((entry) => entry.name === "witt").url,
    "http://127.0.0.1:3003/health");
  // The pinned paths must match the verified reality, not a guessed root.
  const names = DEFAULT_HTTP_SERVICES.map((entry) => `${entry.name}=${entry.url}`);
  assert.ok(names.includes("cpa=http://127.0.0.1:8317/healthz"));
  assert.ok(names.includes("open-webui=http://127.0.0.1:3000/health"));
  assert.ok(names.includes("sub2api=http://127.0.0.1:8080/health"));
});

// --------------------------------------------------------------------------
// Witt's own health probe must follow the port the server actually bound.
// The live E2E starts the backend on an OS-assigned port, so a hardcoded 3003
// made the witt entry report "down" even though the backend was healthy.
// --------------------------------------------------------------------------
test("T-WITT-08a the witt self-probe follows DROP_VAULT_PORT", () => {
  assert.equal(wittPort({ DROP_VAULT_PORT: "58103" }), 58103);
  const witt = defaultHttpServices({ DROP_VAULT_PORT: "58103" })
    .find((entry) => entry.name === "witt");
  assert.equal(witt.url, "http://127.0.0.1:58103/health");
});

test("T-WITT-08b the witt self-probe defaults to 3003 when unset", () => {
  assert.equal(wittPort({}), DEFAULT_WITT_PORT);
  assert.equal(wittPort({ DROP_VAULT_PORT: undefined }), DEFAULT_WITT_PORT);
  const witt = defaultHttpServices({}).find((entry) => entry.name === "witt");
  assert.equal(witt.url, "http://127.0.0.1:3003/health");
});

test("T-WITT-08c invalid ports fall back to 3003", () => {
  const invalid = ["0", "-1", "65536", "abc", "58103.5", "", "   ", "12a", "1e3",
    "NaN", "Infinity", "-0", "99999999999999999999", "0x10"];
  for (const raw of invalid) {
    assert.equal(wittPort({ DROP_VAULT_PORT: raw }), DEFAULT_WITT_PORT,
      `expected fallback for ${JSON.stringify(raw)}`);
  }
  // The valid range boundaries are honoured.
  assert.equal(wittPort({ DROP_VAULT_PORT: "1" }), 1);
  assert.equal(wittPort({ DROP_VAULT_PORT: "65535" }), 65535);
  assert.equal(wittPort({ DROP_VAULT_PORT: 58103 }), 58103);
});

test("T-WITT-08d an explicit service list is never overridden by the default", () => {
  const custom = parseServiceConfig({
    DROP_VAULT_PORT: "58103",
    WITT_SERVER_SERVICES: JSON.stringify({
      http: [{ name: "witt", url: "http://127.0.0.1:9999/health" }],
    }),
  });
  assert.equal(custom.http.length, 1);
  assert.equal(custom.http[0].url, "http://127.0.0.1:9999/health");

  // A malformed explicit list falls back to the port-aware default, not to 3003.
  const broken = parseServiceConfig({ DROP_VAULT_PORT: "58103", WITT_SERVER_SERVICES: "{nope" });
  assert.equal(broken.http.find((entry) => entry.name === "witt").url,
    "http://127.0.0.1:58103/health");
});

test("T-WITT-08e the witt entry on a random port is judged healthy", async () => {
  const seen = [];
  const report = await overview({
    env: { DROP_VAULT_PORT: "58103" },
    fetchImpl: async (url) => {
      seen.push(url);
      const alive = url === "http://127.0.0.1:58103/health";
      return { ok: alive, status: alive ? 200 : 503 };
    },
  });
  const witt = report.http.find((entry) => entry.name === "witt");
  assert.equal(witt.url, "http://127.0.0.1:58103/health");
  assert.equal(witt.status, "healthy");
  assert.ok(seen.includes("http://127.0.0.1:58103/health"), "the bound port was not probed");
  // The old hardcoded address must not be probed at all.
  assert.equal(seen.some((url) => url.includes(":3003/")), false,
    "the hardcoded 3003 address is still probed");
});
