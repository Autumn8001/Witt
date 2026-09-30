"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { resolveHarness, harnessChanged } = require("./runtime/runtime-resolver");
const { HarnessRuntimeManager } = require("./runtime/harness-runtime-manager");
const { ProviderRegistry } = require("./runtime/provider-registry");
const { RuntimeProfileStore } = require("./runtime/runtime-profiles");
const { CodexHarnessAdapter } = require("./runtime/codex-harness-adapter");
const { createHarness } = require("./runtime");

test("resolver keeps harness separate from model family", () => {
  assert.equal(resolveHarness("gpt-5.5"), "codex");
  assert.equal(resolveHarness("grok-4.7"), "grok-build");
  assert.equal(resolveHarness("gemini-3.8-flash"), "google-antigravity");
  assert.equal(resolveHarness("deepseek-v4-pro"), "codex");
  assert.equal(resolveHarness("unknown-model"), "codex");
  assert.equal(resolveHarness("grok-4.7", "codex"), "codex");
  assert.equal(harnessChanged("codex", "grok-4.7", "auto"), true);
  assert.equal(harnessChanged("grok-build", "grok-4.7", "auto"), false);
});

test("runtime manager starts lazily and shuts idle runtimes down", async () => {
  let now = 0;
  let stopped = 0;
  const manager = new HarnessRuntimeManager({ idleMs: 30, now: () => now });
  const adapter = {
    async startRuntime() {},
    stopRuntime() { stopped += 1; },
  };
  await manager.start("codex", "user", adapter);
  manager.bindSession("codex", "user", "session-1");
  now = 100;
  assert.deepEqual(manager.reapIdle(), []);
  manager.releaseSession("codex", "user", "session-1");
  now = 131;
  assert.deepEqual(manager.reapIdle(), ["codex:user"]);
  assert.equal(stopped, 1);
});

test("provider registry hides secrets and records protocol", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "witt-providers-"));
  const registry = new ProviderRegistry({ file: path.join(directory, "providers.json") });
  const created = registry.upsert({
    id: "cpa",
    name: "CPA",
    type: "gateway",
    base_url: "http://127.0.0.1:8317/v1",
    protocol: "openai-responses",
    secret_ref: "CPA_API_KEY",
    secret: "secret-value",
  });
  assert.equal(created.secret, undefined);
  assert.equal(created.secret_display, "Configured");
  assert.equal(created.protocol, "openai-responses");
  assert.equal(JSON.stringify(registry.list()).includes("secret-value"), false);
  assert.throws(() => registry.upsert({
    id: "bad", name: "Bad", base_url: "http://127.0.0.1/v1?token=abc", protocol: "openai-responses",
  }));
});

test("profiles and adapters do not pretend missing runtimes are live", () => {
  const profiles = new RuntimeProfileStore().list();
  assert.deepEqual(profiles.map((profile) => profile.id), ["grok-main", "gemini-fast", "codex-default"]);
  const codex = new CodexHarnessAdapter({ codexBin: "codex" });
  assert.equal(codex.getCapabilities().review, true);
  const grok = createHarness("grok-build");
  assert.equal(grok.getCapabilities().tools, false);
  assert.rejects(() => grok.startRuntime());
  const gemini = createHarness("google-antigravity");
  assert.equal(gemini.displayName, "Gemini");
  assert.equal(gemini.getCapabilities().sessions, false);
});
