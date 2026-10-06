"use strict";

// Unit tests for the runtime layer. No network, no real harness binaries needed.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  buildWorkDirRoots, normalizeRootList, isWithinRoots, grokPermissionMode,
} = require("./chat-service");
const {
  parseGrokEvent, parseAntigravityEvent, classifyProviderStatus, parseNdjsonLines,
} = require("./runtime/event-parsers");
const { scrub, scrubText } = require("./runtime/runtime-log");
const {
  CODEX_CAPABILITIES, GROK_BUILD_CAPABILITIES, ANTIGRAVITY_CAPABILITIES, capabilities,
} = require("./runtime/capabilities");
const { resolveHarness, harnessChanged } = require("./runtime/runtime-resolver");
const { RuntimeProfileStore } = require("./runtime/runtime-profiles");
const { describeBinary, DEFAULT_BINARIES } = require("./runtime/runtime-binaries");
const { GrokBuildAdapter, parseModelList } = require("./runtime/grok-build-adapter");
const { AntigravityAdapter, hostHasPclmul } = require("./runtime/antigravity-adapter");
const { HarnessRuntimeManager } = require("./runtime/harness-runtime-manager");

// --------------------------------------------------------------------------
// Grok structured event parser (schema verified against Grok Build 1.0.44)
// --------------------------------------------------------------------------
test("grok parser maps every documented event type", () => {
  assert.deepEqual(parseGrokEvent({ type: "text", data: "hi" }),
    { type: "text_delta", text: "hi" });
  assert.deepEqual(parseGrokEvent({ type: "thought", data: "hm" }),
    { type: "reasoning_delta", text: "hm" });

  const call = parseGrokEvent({
    type: "tool_call", toolCallId: "call_1", title: "Read", kind: "read",
    status: "in_progress", toolName: "read_file", rawInput: { target_file: "a.txt" },
    content: [], locations: [],
  });
  assert.equal(call.type, "tool_call");
  assert.equal(call.id, "call_1");
  assert.equal(call.tool, "read_file");
  assert.deepEqual(call.input, { target_file: "a.txt" });

  const update = parseGrokEvent({
    type: "tool_call_update", toolCallId: "call_1", status: "completed",
    rawOutput: { type: "ReadFile" },
  });
  assert.equal(update.type, "tool_call_update");
  assert.equal(update.status, "completed");

  const end = parseGrokEvent({
    type: "end", stopReason: "end_turn", sessionId: "s-1", requestId: "r-1",
    usage: { input_tokens: 10 }, num_turns: 2, total_cost_usd: 0.5,
    modelUsage: { "grok-4.7": { inputTokens: 10 } },
  });
  assert.equal(end.type, "end");
  assert.equal(end.sessionId, "s-1");
  assert.equal(end.numTurns, 2);
  assert.equal(end.costUsd, 0.5);

  assert.equal(parseGrokEvent({ type: "usage", usage: {} }).type, "usage");
  assert.equal(parseGrokEvent({ type: "plan", entries: [] }).type, "plan");
  assert.equal(parseGrokEvent({ type: "available_commands", tools: ["read_file"], commands: ["compact"] }).type, "commands");
  assert.equal(parseGrokEvent({ type: "error", message: "boom" }).error, "boom");
});

test("grok parser treats the documented non-exhaustive types as notices", () => {
  assert.equal(parseGrokEvent({ type: "max_turns_reached" }).type, "notice");
  assert.equal(parseGrokEvent({ type: "auto_compact_started" }).type, "notice");
  assert.equal(parseGrokEvent({}).type, "unknown");
});

test("grok model list parsing reads the real CLI output shape", () => {
  const stdout = [
    "Model 'witt-grok-high' is using its own API key.",
    "",
    "Default model: grok-4.6",
    "",
    "Available models:",
    "  * grok-4.6 (default)",
    "  - grok-4.5",
    "  - witt-grok-high",
    "",
  ].join("\n");
  assert.deepEqual(parseModelList(stdout), [
    { id: "grok-4.6", isDefault: true },
    { id: "grok-4.5", isDefault: false },
    { id: "witt-grok-high", isDefault: false },
  ]);
});

test("grok command arguments preserve the per-turn reasoning effort", () => {
  const adapter = new GrokBuildAdapter({ bin: "grok", model: "grok-4.7-high" });
  const args = adapter.buildArgs({
    prompt: "hello",
    cwd: process.cwd(),
    sessionId: "session-1",
    reasoningEffort: "medium",
  });
  const effortIndex = args.indexOf("--reasoning-effort");
  assert.notEqual(effortIndex, -1);
  assert.equal(args[effortIndex + 1], "medium");
});

test("grok permission mode follows the Witt access boundary", () => {
  assert.equal(grokPermissionMode("read-only"), "plan");
  assert.equal(grokPermissionMode("workspace-write"), "acceptEdits");
  assert.equal(grokPermissionMode("danger-full-access"), "bypassPermissions");
  assert.equal(grokPermissionMode("unexpected"), "plan");

  const adapter = new GrokBuildAdapter({ bin: "grok" });
  const args = adapter.buildArgs({ prompt: "hello", cwd: process.cwd() });
  const modeIndex = args.indexOf("--permission-mode");
  assert.equal(args[modeIndex + 1], "default");
});

test("remote device MCP authorization is explicit in every Grok child", () => {
  const disabled = new GrokBuildAdapter({ bin: "grok" });
  const enabled = new GrokBuildAdapter({
    bin: "grok", remoteDeviceMcpEnabled: true,
    remoteDeviceTokenFile: "/run/witt/api-token",
  });
  assert.equal(disabled.childEnv().WITT_REMOTE_DEVICE_MCP_ENABLED, "0");
  assert.equal(disabled.childEnv().WITT_BROWSER_MCP_ENABLED, "0");
  assert.equal(disabled.childEnv().DROP_VAULT_TOKEN_FILE, undefined);
  assert.equal(enabled.childEnv().WITT_REMOTE_DEVICE_MCP_ENABLED, "1");
  assert.equal(enabled.childEnv().DROP_VAULT_TOKEN_FILE, "/run/witt/api-token");
});

test("remote workspace MCP receives only its scoped credential", () => {
  const adapter = new GrokBuildAdapter({
    bin: "grok",
    remoteDeviceMcpEnabled: false,
    remoteDeviceTokenFile: "/run/witt/general-token",
    remoteWorkspace: {
      apiBase: "http://127.0.0.1:38123",
      credentialFile: "/run/witt/workspace-scoped-token",
    },
  });
  const env = adapter.childEnv();
  assert.equal(env.WITT_REMOTE_WORKSPACE_MCP_ENABLED, "1");
  assert.equal(env.WITT_REMOTE_WORKSPACE_MCP_API, "http://127.0.0.1:38123");
  assert.equal(env.WITT_REMOTE_WORKSPACE_CREDENTIAL_FILE, "/run/witt/workspace-scoped-token");
  assert.equal(env.WITT_REMOTE_DEVICE_MCP_ENABLED, "0");
  assert.equal(env.DROP_VAULT_TOKEN_FILE, undefined);
});

test("browser MCP authorization is explicit in every Grok child", () => {
  const disabled = new GrokBuildAdapter({ bin: "grok" });
  const enabled = new GrokBuildAdapter({ bin: "grok", browserMcpEnabled: true });
  assert.equal(disabled.childEnv().WITT_BROWSER_MCP_ENABLED, "0");
  assert.equal(enabled.childEnv().WITT_BROWSER_MCP_ENABLED, "1");
});

// --------------------------------------------------------------------------
// Antigravity NDJSON parser (schema taken from the official headless docs)
// --------------------------------------------------------------------------
test("antigravity parser maps init, step_update and result", () => {
  const init = parseAntigravityEvent({
    event: "init", init: { conversation_id: "c-1", cwd: "/repo", model: "gemini-3.8-flash" },
  });
  assert.equal(init.type, "init");
  assert.equal(init.sessionId, "c-1");
  assert.equal(init.model, "gemini-3.8-flash");

  const step = parseAntigravityEvent({
    event: "step_update",
    step_update: { conversation_id: "c-1", step_index: 3, state: "ACTIVE", text_delta: "Hello" },
  });
  assert.equal(step.type, "text_delta");
  assert.equal(step.text, "Hello");
  assert.equal(step.sessionId, "c-1");
  assert.equal(step.stepIndex, 3);

  const result = parseAntigravityEvent({
    event: "result",
    result: { conversation_id: "c-1", status: "SUCCESS", response: "done", num_turns: 1,
      duration_seconds: 2, usage: { input_tokens: 5, output_tokens: 2 } },
  });
  assert.equal(result.type, "result");
  assert.equal(result.text, "done");
  assert.equal(result.durationMs, 2000);
  assert.equal(result.error, undefined);
});

test("antigravity parser reports failure status as an error", () => {
  const failed = parseAntigravityEvent({
    event: "result",
    result: { conversation_id: "c-2", status: "ERROR", error: "quota exceeded" },
  });
  assert.equal(failed.error, "quota exceeded");
  assert.equal(parseAntigravityEvent({ event: "mystery" }).type, "notice");
  assert.equal(parseAntigravityEvent({}).type, "unknown");
});

test("antigravity does not bypass permissions unless explicitly configured", () => {
  const safe = new AntigravityAdapter({ bin: "agy", printTimeoutMs: 1000 });
  assert.equal(safe.buildArgs({ prompt: "hello" }).includes("--dangerously-skip-permissions"), false);
  const bypass = new AntigravityAdapter({
    bin: "agy", printTimeoutMs: 1000, skipPermissions: true,
  });
  assert.equal(bypass.buildArgs({ prompt: "hello" }).includes("--dangerously-skip-permissions"), true);
});

test("antigravity tool_info parsing is defensive and flagged unverified", () => {
  const call = parseAntigravityEvent({
    event: "step_update",
    step_update: { conversation_id: "c-3", step_index: 1, state: "ACTIVE",
      tool_info: { name: "read_file", input: { path: "a" }, status: "running" } },
  });
  assert.equal(call.type, "tool_call");
  assert.equal(call.tool, "read_file");
  assert.equal(call.unverifiedShape, true);
});

// --------------------------------------------------------------------------
// Session id mapping and provider error classification
// --------------------------------------------------------------------------
test("session id maps from harness event to conversation field", () => {
  const end = parseGrokEvent({ type: "end", sessionId: "harness-session-9", stopReason: "end_turn" });
  const conversation = { harnessSessionId: null };
  if (end.sessionId) conversation.harnessSessionId = end.sessionId;
  assert.equal(conversation.harnessSessionId, "harness-session-9");
});

test("provider status classification covers auth, timeout, rate limit and 5xx", () => {
  assert.equal(classifyProviderStatus(401).kind, "auth_error");
  assert.equal(classifyProviderStatus(403).kind, "auth_error");
  assert.equal(classifyProviderStatus(401).retryable, false);
  assert.equal(classifyProviderStatus(429).kind, "rate_limited");
  assert.equal(classifyProviderStatus(429).retryable, true);
  assert.equal(classifyProviderStatus(504).kind, "timeout");
  assert.equal(classifyProviderStatus(500).kind, "provider_error");
  assert.equal(classifyProviderStatus(503).retryable, true);
  assert.equal(classifyProviderStatus(400).kind, "request_error");
  assert.equal(classifyProviderStatus(200).kind, "ok");
});

test("ndjson parsing separates malformed lines from valid events", () => {
  const chunk = [
    JSON.stringify({ type: "text", data: "a" }),
    "not json at all",
    JSON.stringify({ type: "end", sessionId: "s" }),
    "",
  ].join("\n");
  const { events, invalid } = parseNdjsonLines(chunk, parseGrokEvent);
  assert.equal(events.length, 2);
  assert.equal(invalid.length, 1);
  assert.equal(events[1].sessionId, "s");
});

// --------------------------------------------------------------------------
// Secret redaction
// --------------------------------------------------------------------------
test("runtime logging redacts secrets and credential-shaped tokens", () => {
  const record = scrub({
    apiKey: "sk-abcdefghijklmnopqrstuvwxyz012345",
    nested: { Authorization: "Bearer abc", model: "grok-4.7" },
    note: "token=secret-value",
    safe: "grok-4.7-high",
  });
  assert.equal(record.apiKey, "REDACTED");
  assert.equal(record.nested.Authorization, "REDACTED");
  assert.equal(record.safe, "grok-4.7-high");
  assert.equal(JSON.stringify(record).includes("sk-abcdefghijklmnopqrstuvwxyz012345"), false);

  assert.equal(scrubText("xai-abcdefghijklmnopqrstuvwxyz"), "REDACTED");
  assert.equal(scrubText("ghp_abcdefghijklmnopqrstuvwx"), "REDACTED");
  assert.equal(scrubText("AIzaabcdefghijklmnopqrstuvwx"), "REDACTED");
  // A legitimate flag name must not be mangled.
  assert.equal(scrubText("--xai-api-base-url"), "--xai-api-base-url");
});

// --------------------------------------------------------------------------
// Executable detection
// --------------------------------------------------------------------------
test("binary detection describes each harness with an install hint", () => {
  assert.deepEqual(Object.keys(DEFAULT_BINARIES).sort(),
    ["codex", "google-antigravity", "grok-build"]);
  for (const id of Object.keys(DEFAULT_BINARIES)) {
    const described = describeBinary(id);
    assert.equal(described.harness, id);
    assert.ok(typeof described.bin === "string" && described.bin.length > 0);
    assert.ok(described.install.length > 0);
    assert.equal(typeof described.exists, "boolean");
  }
  const grok = describeBinary("grok-build", { bin: "/root/.local/bin/grok" });
  assert.equal(grok.bin, "/root/.local/bin/grok");
  assert.equal(describeBinary("nope"), null);
});

// --------------------------------------------------------------------------
// Capabilities are honest
// --------------------------------------------------------------------------
test("capabilities reflect verified reality, not aspiration", () => {
  assert.equal(CODEX_CAPABILITIES.review, true);
  assert.equal(GROK_BUILD_CAPABILITIES.cancel, true);
  assert.equal(GROK_BUILD_CAPABILITIES.mcp, true);
  assert.equal(GROK_BUILD_CAPABILITIES.approvals, false);
  assert.equal(GROK_BUILD_CAPABILITIES.review, false);
  // Unverified values must never be true.
  assert.equal(ANTIGRAVITY_CAPABILITIES.sessions, "unknown");
  assert.notEqual(ANTIGRAVITY_CAPABILITIES.streaming, true);
  const blank = capabilities();
  assert.equal(blank.tools, false);
});

test("pclmul detection does not throw off Linux", () => {
  const value = hostHasPclmul();
  assert.ok(value === true || value === false || value === null);
});

// --------------------------------------------------------------------------
// Runtime resolver and profiles
// --------------------------------------------------------------------------
test("resolver keeps harness separate from provider and model", () => {
  assert.equal(resolveHarness("gpt-5.5"), "codex");
  assert.equal(resolveHarness("grok-4.7-high"), "grok-build");
  assert.equal(resolveHarness("gemini-3.8-flash-high"), "google-antigravity");
  assert.equal(resolveHarness("deepseek-v4-pro"), "codex");
  assert.equal(resolveHarness("who-knows"), "codex");
  assert.equal(resolveHarness("gemini-3.8-flash-high", "codex"), "codex");
  assert.equal(harnessChanged("codex", "grok-4.7-high", "auto"), true);
  assert.equal(harnessChanged("grok-build", "grok-4.7-high", "auto"), false);
  assert.throws(() => resolveHarness("grok-4.7", "nonsense-harness"));
});

test("runtime profiles resolve to the documented harness and provider", () => {
  const profiles = new RuntimeProfileStore().list();
  const byId = Object.fromEntries(profiles.map((profile) => [profile.id, profile]));
  assert.deepEqual(Object.keys(byId).sort(), ["codex-default", "gemini-fast", "grok-main"]);
  assert.equal(byId["grok-main"].harness, "grok-build");
  assert.equal(byId["grok-main"].provider, "cpa");
  assert.equal(byId["grok-main"].model, "grok-4.7-high");
  assert.equal(resolveHarness(byId["grok-main"].model), "grok-build");
  assert.equal(byId["gemini-fast"].harness, "google-antigravity");
  assert.equal(byId["gemini-fast"].model, "gemini-3.8-flash-high");
  assert.equal(resolveHarness(byId["gemini-fast"].model), "google-antigravity");
  assert.equal(byId["codex-default"].harness, "codex");
});

// --------------------------------------------------------------------------
// Working-directory allowlist (upstream hardcoded this and ignored the
// configured work dir, which blocked every deployment outside /home/ubuntu)
// --------------------------------------------------------------------------
test("work dir roots honour the configured work dir and extra configured roots", () => {
  const saved = process.env.WITT_WORKDIR_ROOTS;
  // Roots are stored as absolute native paths, so compare resolved forms.
  const abs = (value) => path.resolve(value);
  try {
    delete process.env.WITT_WORKDIR_ROOTS;
    const defaults = buildWorkDirRoots({}, "/srv/witt/project");
    assert.ok(defaults.includes(abs("/home/ubuntu")));
    assert.ok(defaults.includes(abs("/data/drop-vault")));
    assert.ok(defaults.includes(abs("/data/xuanyu-build-console")));
    // The operator's configured project directory must be usable.
    assert.ok(defaults.includes(abs("/srv/witt/project")));

    process.env.WITT_WORKDIR_ROOTS = "/opt/a,/opt/b;/opt/c";
    const withEnv = buildWorkDirRoots({}, "/srv/witt/project");
    assert.ok(withEnv.includes(abs("/opt/a")) && withEnv.includes(abs("/opt/b")) && withEnv.includes(abs("/opt/c")));

    const explicit = buildWorkDirRoots({ workDirRoots: ["/explicit/root"] }, null);
    assert.ok(explicit.includes(abs("/explicit/root")));
    // Relative entries are ignored rather than silently matching everything.
    const relative = buildWorkDirRoots({ workDirRoots: ["relative/path", ""] }, null);
    assert.equal(relative.some((root) => root.includes("relative")), false);
  } finally {
    if (saved === undefined) delete process.env.WITT_WORKDIR_ROOTS;
    else process.env.WITT_WORKDIR_ROOTS = saved;
  }
});

test("work dir membership rejects sibling prefix traps", () => {
  const roots = ["/home/ubuntu", "/srv/witt"];
  assert.equal(isWithinRoots(["/home/ubuntu/project"], roots), true);
  assert.equal(isWithinRoots(["/home/ubuntu"], roots), true);
  assert.equal(isWithinRoots(["/srv/witt/app"], roots), true);
  // The classic prefix bug: /home/ubuntu-evil must not pass.
  assert.equal(isWithinRoots(["/home/ubuntu-evil"], roots), false);
  assert.equal(isWithinRoots(["/srv/witt-evil"], roots), false);
  assert.equal(isWithinRoots(["/etc"], roots), false);
  assert.equal(isWithinRoots(["/home/other"], roots), false);
});

test("work dir roots resolve symlinks so a linked project still matches", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "witt-roots-"));
  const real = path.join(base, "real-project");
  fs.mkdirSync(real);
  const roots = normalizeRootList([real]);
  assert.ok(roots.includes(real));
  const resolved = fs.realpathSync(real);
  assert.ok(roots.includes(resolved));
});

// --------------------------------------------------------------------------
// Lazy runtime lifecycle
// --------------------------------------------------------------------------
test("runtime manager is lazy, tracks sessions and reaps idle runtimes", async () => {
  let now = 0;
  let starts = 0;
  let stops = 0;
  const manager = new HarnessRuntimeManager({ idleMs: 100, now: () => now });
  const adapter = {
    async startRuntime() { starts += 1; },
    stopRuntime() { stops += 1; },
  };
  assert.equal(manager.status().length, 0);
  await manager.start("grok-build", "user-1", adapter);
  assert.equal(starts, 1);
  manager.bindSession("grok-build", "user-1", "session-a");
  now = 500;
  assert.deepEqual(manager.reapIdle(), []);
  manager.releaseSession("grok-build", "user-1", "session-a");
  now = 700;
  assert.deepEqual(manager.reapIdle(), ["grok-build:user-1"]);
  assert.equal(stops, 1);
  assert.equal(manager.status()[0].stopped, true);
});


test("Grok tool events expose command results without leaking credentials", () => {
  const adapter = new GrokBuildAdapter({ bin: "grok" });
  const command = adapter.formatToolCall({
    tool: "shell_command",
    input: { command: "node --version", authorization: "example-only" },
  }, "/tmp/project");
  assert.equal(command.kind, "command");
  assert.equal(command.details.command, "node --version");
  assert.equal(command.details.input.authorization, "[REDACTED]");
  const failed = adapter.formatToolUpdate({
    status: "failed",
    output: { exitCode: 2, error: "test failed", secret: "example-only" },
  }, { kind: command.kind });
  assert.equal(failed.status, "failed");
  assert.equal(failed.exitCode, 2);
  assert.equal(failed.details.exitCode, 2);
  assert.equal(failed.details.output.includes("example-only"), false);
  const read = adapter.formatToolCall({
    tool: "read_file", input: { target_file: "README.md" },
  }, "/tmp/project");
  assert.equal(read.kind, "tool");
  assert.deepEqual(read.details.input, { target_file: "README.md" });
});
