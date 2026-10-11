"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AntigravityAdapter } = require("../backend/runtime/antigravity-adapter");
const { antigravityFailureReason } = require("../backend/worker-service");

const SECRET_PARENT_ENV = "WITT_ANTIGRAVITY_ENV_TEST_SECRET";
const FAKE_API_KEY = "fake-cpa-gemini-key-for-test-only";
const FAKE_BASE_URL = "http://127.0.0.1:8317/gemini";

function makeEnvProbe(t, expectations) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "witt-agy-env-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const script = path.join(directory, "probe-child-env.js");
  const expectedKey = expectations.key === null ? "undefined" : JSON.stringify(expectations.key);
  const expectedBase = expectations.baseUrl === null ? "undefined" : JSON.stringify(expectations.baseUrl);
  fs.writeFileSync(script, [
    `const expectedKey = ${expectedKey};`,
    `const expectedBase = ${expectedBase};`,
    `if (process.env.GEMINI_API_KEY !== expectedKey) process.exit(31);`,
    `if (process.env.GOOGLE_GEMINI_BASE_URL !== expectedBase) process.exit(32);`,
    `if (process.env.${SECRET_PARENT_ENV} !== undefined) process.exit(33);`,
  ].join("\n"), { mode: 0o600 });
  return script;
}

async function runProbe(t, options, expected) {
  const script = makeEnvProbe(t, expected);
  const adapter = new AntigravityAdapter({ bin: process.execPath, ...options });
  // Keep the real HarnessProcess.spawn path while replacing only CLI argument
  // parsing, since the probe is a Node script rather than the agy executable.
  adapter.buildArgs = () => [script];
  const handle = adapter.sendPrompt({ model: "gemini-test" });
  const result = await handle.done;
  assert.equal(result.ok, true, `environment probe child exited with ${result.code}`);
  assert.equal(handle.process.env.GEMINI_API_KEY, expected.key ?? undefined);
  assert.equal(handle.process.env.GOOGLE_GEMINI_BASE_URL, expected.baseUrl ?? undefined);
  assert.equal(handle.process.env[SECRET_PARENT_ENV], undefined);
}

test("explicit CPA Gemini key and base URL reach only the actual harness child", async (t) => {
  const old = process.env[SECRET_PARENT_ENV];
  process.env[SECRET_PARENT_ENV] = "parent-secret-must-not-inherit";
  t.after(() => {
    if (old === undefined) delete process.env[SECRET_PARENT_ENV];
    else process.env[SECRET_PARENT_ENV] = old;
  });

  await runProbe(t, {
    apiKeyEnv: "GEMINI_API_KEY",
    apiKeyValue: FAKE_API_KEY,
    baseUrl: FAKE_BASE_URL,
  }, { key: FAKE_API_KEY, baseUrl: FAKE_BASE_URL });
});

test("default account-login mode adds no API key or custom base URL", async (t) => {
  const old = process.env[SECRET_PARENT_ENV];
  process.env[SECRET_PARENT_ENV] = "parent-secret-must-not-inherit";
  t.after(() => {
    if (old === undefined) delete process.env[SECRET_PARENT_ENV];
    else process.env[SECRET_PARENT_ENV] = old;
  });

  const adapter = new AntigravityAdapter({ bin: process.execPath });
  assert.deepEqual(adapter.childEnv(), {});
  await runProbe(t, { bin: process.execPath }, { key: null, baseUrl: null });
});

test("Antigravity runtime error takes priority over the generic process exit label", () => {
  assert.equal(
    antigravityFailureReason("API_KEY=sk-12345678901234567890 rejected", { errorType: "exit_nonzero" }),
    "API_KEY=[REDACTED] rejected",
  );
  assert.equal(antigravityFailureReason("", { errorType: "exit_nonzero" }), "exit_nonzero");
});
