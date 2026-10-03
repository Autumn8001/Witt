"use strict";

// Milestone 1B-1 (repair round).
//
// Codex is intentionally absent in these tests (codexBin points at a path that
// does not exist), which is exactly the condition that used to make the whole
// capabilities endpoint return 503.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  ChatService, SELECTABLE_MODELS, SELECTABLE_HARNESS_MODELS, LEGACY_KNOWN_MODELS,
  PAUSED_RUNTIME_MODELS, PAUSED_RUNTIME_REASON, RETIRED_UNVERIFIED_MODELS,
  RETIRED_MODEL_REASON, BLOCK_REASON_CODES, providerForModel,
  DEFAULT_HARNESS_MODEL, DEFAULT_PROVIDER_ID, CODEX_REASON_CODES,
} = require("./chat-service");

const REPO = path.join(__dirname, "..");
const GEMINI = "gemini-3.8-flash-high";

// A stand-in that reports as an executable file, to prove the adapter honours the
// operator's configured binary instead of only the default install path.
const REAL_EXECUTABLE = process.execPath;

function makeService(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "witt-caps-"));
  const sent = [];
  const service = new ChatService({
    chatDir: path.join(root, "chat"),
    imageDir: path.join(root, "images"),
    dataDir: path.join(root, "files"),
    codexBin: overrides.codexBin || path.join(root, "definitely-missing-codex"),
    codexWorkDir: root,
    sendJson: (res, status, body) => sent.push({ status, body }),
    readJsonBody: (req, limit, callback) => callback(null, overrides.requestBody || {}),
    codexProfiles: {
      default: { id: "default", label: "test", codexHome: path.join(root, "codex"), workDir: root },
    },
    harnessOptions: overrides.harnessOptions || {
      grok: { providerId: "cpa", envKey: "WITT_CPA_KEY", envValue: "" },
    },
    // null == unrestricted policy, i.e. the administrator case.
    allowedModels: overrides.allowedModels === undefined ? null : overrides.allowedModels,
    defaultModel: overrides.defaultModel,
    defaultProviderId: overrides.defaultProviderId,
    runtimeLogger: { log() {} },
  });
  return { service, sent, root };
}

async function capabilities(service, sent) {
  await service.readCapabilities({});
  const last = sent.at(-1);
  return { status: last.status, payload: last.body, raw: JSON.stringify(last.body) };
}

test("the shared developer prompt is provider-neutral", (t) => {
  const { service, root } = makeService();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prompt = service.buildDeveloperInstructions({ workDir: root });
  assert.match(prompt, /通过 Witt 应用/);
  assert.doesNotMatch(prompt, /你是.*(?:Witt|Codex|Grok)/);
});

function queueTurn(service, conversationId, text = "hello") {
  const conversation = service.readConversation(conversationId);
  const userId = crypto.randomUUID();
  const assistantId = crypto.randomUUID();
  const now = new Date().toISOString();
  conversation.messages.push({
    id: userId, role: "user", text, status: "queued", attachments: [], createdAt: now,
  });
  // nextQueued pairs the assistant with its user message through `replyTo`.
  conversation.messages.push({
    id: assistantId, role: "assistant", text: "", status: "queued", stream: [],
    replyTo: userId, createdAt: now,
  });
  conversation.busy = true;
  service.writeConversation(conversation);
  return { userId, assistantId };
}

// ---------------------------------------------------------------- capabilities

test("T-CAP-01 capabilities still answers 200 when Codex is absent", async () => {
  const { service, sent } = makeService();
  const { status, payload } = await capabilities(service, sent);
  assert.equal(status, 200);
  assert.ok(Array.isArray(payload.models));
});

test("T-CAP-02 the selectable Grok model is offered with its harness and provider", async () => {
  const { service, sent } = makeService();
  const { payload } = await capabilities(service, sent);
  const ids = payload.models.map((model) => model.id);
  assert.ok(ids.includes("grok-4.7-high"), `models were ${ids.join(", ")}`);
  const grok = payload.models.find((model) => model.id === "grok-4.7-high");
  assert.equal(grok.harness, "grok-build");
  assert.equal(grok.provider, "cpa");
});

test("T-CAP-03 Gemini is not offered, for any role", async () => {
  for (const allowedModels of [null, new Set(["gpt-5.5"])]) {
    const { service, sent } = makeService({ allowedModels });
    const { raw, payload } = await capabilities(service, sent);
    assert.equal(payload.models.some((model) => String(model.id).startsWith("gemini")), false);
    assert.equal(raw.includes("gemini"), false);
  }
});

test("T-CAP-04 Codex failure does not remove Grok capability", async () => {
  const { service, sent } = makeService();
  const { status, payload } = await capabilities(service, sent);
  const runtime = payload.runtime;
  assert.equal(status, 200);
  assert.equal(runtime.codex.available, false);
  assert.equal(runtime.codex.status, "unavailable");
  assert.ok(CODEX_REASON_CODES.has(runtime.codex.reason), `reason=${runtime.codex.reason}`);
  const grokRuntime = runtime["grok-build"];
  assert.ok(["ready", "executable_not_found"].includes(grokRuntime.status),
    `unexpected grok status: ${grokRuntime.status}`);
  assert.equal(grokRuntime.provider, "cpa");
  assert.equal(runtime["google-antigravity"].status, PAUSED_RUNTIME_REASON);
  assert.deepEqual(payload.support, { fork: false, compact: false, review: false, plans: false });
  assert.ok(payload.models.some((model) => model.id === "grok-4.7-high"));
});

test("T-CAP-05 capability errors leak no host detail", async () => {
  const marker = "/tmp/secret-marker-should-not-appear/bin/codex";
  const { service, sent } = makeService({ codexBin: marker });
  const { raw, payload } = await capabilities(service, sent);
  for (const needle of [marker, "secret-marker-should-not-appear", "/bin/codex",
    "codexBin", "ENOENT", "spawn", "WITT_CPA_KEY", "password", "token"]) {
    assert.equal(raw.includes(needle), false, `capabilities leaked: ${needle}`);
  }
  assert.ok(CODEX_REASON_CODES.has(payload.runtime.codex.reason));
});

test("T-CAP-06 runtime status uses the configured Grok binary", async () => {
  const { service, sent } = makeService({
    harnessOptions: {
      grok: { bin: REAL_EXECUTABLE, providerId: "cpa", envKey: "WITT_CPA_KEY", envValue: "" },
    },
  });
  const { payload } = await capabilities(service, sent);
  assert.equal(payload.runtime["grok-build"].available, true,
    "configured binary was ignored; only the default install path was checked");
  assert.equal(payload.runtime["grok-build"].status, "ready");
});

test("T-CAP-07 Codex-reported paused and retired models are filtered out", async (t) => {
  const { service, sent, root } = makeService();
  // A local credential file gates the real CLI; this test uses a fake client and
  // only needs the file-presence signal. No credential is read or sent.
  fs.mkdirSync(path.join(root, "codex"), { recursive: true });
  fs.writeFileSync(path.join(root, "codex", "auth.json"), "{}");
  t.after(() => fs.rmSync(path.join(root, "codex", "auth.json"), { force: true }));
  // Simulate a reachable Codex that reports a mixed catalog.
  service.clientFor = () => ({
    async start() {},
    async request(method) {
      if (method === "model/list") {
        return { data: [
          { id: "gemini-3.8-flash-high" },
          { id: "gpt-5.6-sol" },
          { id: "grok-4.7-medium" },
        ] };
      }
      return { data: [] };
    },
  });
  const { status, payload, raw } = await capabilities(service, sent);
  const ids = payload.models.map((model) => model.id);
  assert.equal(status, 200);
  assert.equal(payload.runtime.codex.available, true, "Codex was expected to be reachable");
  // Allowed GPT survives.
  assert.ok(ids.includes("gpt-5.6-sol"), `expected gpt retained, got ${ids.join(", ")}`);
  // Paused and retired entries do not, even though Codex listed them.
  assert.equal(ids.some((id) => String(id).startsWith("gemini")), false);
  assert.equal(ids.includes("grok-4.7-medium"), false);
  assert.equal(raw.includes("gemini"), false);
  // No duplicate entries when both Codex and the harness catalog offer a model.
  assert.equal(new Set(ids).size, ids.length, `duplicate ids in ${ids.join(", ")}`);
});

test("T-MODEL-03 unverified Grok models are retired, never silently downgraded", () => {
  for (const id of ["grok-4.7-medium", "grok-4.7-max", "grok-4.7-xhigh"]) {
    assert.equal(SELECTABLE_MODELS.has(id), false, `${id} must not be selectable`);
    assert.equal(LEGACY_KNOWN_MODELS.has(id), true, `${id} must stay recognisable`);
    assert.equal(RETIRED_UNVERIFIED_MODELS.has(id), true, `${id} must be retired`);
  }
  const { service } = makeService();
  for (const id of ["grok-4.7-medium", "grok-4.7-max", "grok-4.7-xhigh"]) {
    assert.equal(service.modelBlockReason(id), RETIRED_MODEL_REASON);
    assert.equal(service.modelAllowed(id), false, `${id} must be refused`);
    // The verified sibling must not silently stand in for it.
    assert.notEqual(service.modelBlockReason(id), null);
  }
  assert.ok(BLOCK_REASON_CODES.has(RETIRED_MODEL_REASON));
  assert.throws(() => service.createConversation("retired", "grok-4.7-medium"), (error) => {
    assert.equal(error.blockReason, RETIRED_MODEL_REASON);
    return true;
  });
});

test("T-MODEL-04 a retired-model turn fails without calling the Grok runtime", async () => {
  const { service, sent } = makeService({
    allowedModels: null, requestBody: { model: "grok-4.7-max" },
  });
  const now = new Date().toISOString();
  const legacy = {
    id: crypto.randomUUID(), title: "legacy grok", createdAt: now, updatedAt: now,
    archived: false, codexThreadId: null, codexProfile: "default",
    model: "grok-4.7-max", harnessId: "grok-build", providerId: "cpa",
    reasoning: "high", accessMode: "danger-full-access", workDir: "", messages: [],
  };
  service.writeConversation(legacy);

  let grokTurnCalled = false;
  service.runGrokTurn = async () => { grokTurnCalled = true; };

  // The stored binding is reported verbatim and flagged, never rewritten to high.
  const stored = service.readConversation(legacy.id);
  assert.equal(service.publicConversation(stored).model, "grok-4.7-max");
  assert.notEqual(service.publicConversation(stored).model, "grok-4.7-high");
  assert.equal(service.publicConversation(stored).modelBlockedReason, RETIRED_MODEL_REASON);

  // PATCH onto a retired model is refused.
  service.updateConversationSettings({}, {}, legacy.id);
  assert.equal(sent.at(-1).status, 409);
  assert.equal(sent.at(-1).body.blockReason, RETIRED_MODEL_REASON);

  // A turn fails explicitly and the runtime is never invoked.
  const { assistantId } = queueTurn(service, legacy.id);
  await service.runNext();
  const after = service.readConversation(legacy.id);
  const assistant = after.messages.find((message) => message.id === assistantId);
  assert.equal(grokTurnCalled, false, "runGrokTurn must not run for a retired model");
  assert.equal(assistant.status, "failed");
  assert.match(assistant.text, /不可用于新回合/);
  assert.match(assistant.text, new RegExp(RETIRED_MODEL_REASON));
  assert.equal(after.model, "grok-4.7-max", "the stored model was rewritten");
  assert.equal(after.harnessId, "grok-build", "the stored harness was rewritten");
});

// ------------------------------------------------------------ catalog split

test("T-MODEL-01 selectable and legacy catalogs are separate", () => {
  assert.equal(SELECTABLE_MODELS.has(GEMINI), false, "Gemini must not be selectable");
  assert.equal(LEGACY_KNOWN_MODELS.has(GEMINI), true, "Gemini must stay recognisable");
  assert.equal(SELECTABLE_HARNESS_MODELS.has(GEMINI), false);
  assert.equal(SELECTABLE_MODELS.has("grok-4.7-high"), true);
  assert.equal(PAUSED_RUNTIME_MODELS.has(GEMINI), true);
  assert.equal(PAUSED_RUNTIME_REASON, "blocked_runtime_incompatible");
});

test("T-MODEL-02 provider mapping is explicit and never defaults to cpa", () => {
  assert.equal(providerForModel("grok-4.7-high"), "cpa");
  assert.equal(providerForModel("grok-anything"), "cpa");
  assert.equal(providerForModel("gpt-5.6-sol"), "codex");
  assert.equal(providerForModel("gpt-6-astra"), "codex");
  assert.equal(providerForModel("deepseek-v4-pro"), "deepseek");
  assert.equal(providerForModel("gemini-3.8-flash-high"), "sub2api");
  assert.equal(providerForModel("who-knows-this-model"), null);
  assert.notEqual(providerForModel("who-knows-this-model"), "cpa");
});

// ------------------------------------------------- defaults and paused runtime

test("T-DEF-01 a new session defaults to Grok on CPA with an auto harness", () => {
  const { service } = makeService();
  const conversation = service.createConversation();
  assert.equal(conversation.model, DEFAULT_HARNESS_MODEL);
  assert.equal(conversation.harnessId, "grok-build");
  assert.equal(conversation.providerId, DEFAULT_PROVIDER_ID);
});

test("T-DEF-02 an administrator cannot create a session on a paused runtime", () => {
  const { service } = makeService({ allowedModels: null });
  assert.throws(() => service.createConversation("gemini", GEMINI), (error) => {
    assert.equal(error.blockReason, PAUSED_RUNTIME_REASON);
    return true;
  });
});

test("T-DEF-03 an administrator cannot PATCH a session onto a paused runtime", () => {
  const { service, sent } = makeService({ allowedModels: null, requestBody: { model: GEMINI } });
  const conversation = service.createConversation("target");
  service.updateConversationSettings({}, {}, conversation.id);
  const last = sent.at(-1);
  assert.equal(last.status, 409);
  assert.equal(last.body.blockReason, PAUSED_RUNTIME_REASON);
  // The stored binding is untouched by the refused request.
  assert.equal(service.readConversation(conversation.id).model, DEFAULT_HARNESS_MODEL);
});

test("T-DEF-04 an explicitly created GPT session is not labelled as CPA", () => {
  const { service } = makeService();
  const conversation = service.createConversation("gpt session", "gpt-5.6-sol");
  assert.equal(conversation.model, "gpt-5.6-sol");
  assert.equal(conversation.providerId, "codex");
  assert.notEqual(conversation.providerId, "cpa");
  assert.equal(conversation.harnessId, "codex");
  // And the API reports the same thing.
  assert.equal(service.publicConversation(service.readConversation(conversation.id)).providerId, "codex");
});

test("T-DEF-05 an existing paused-runtime session is preserved and reports the pause", async () => {
  const { service } = makeService();
  const now = new Date().toISOString();
  const legacy = {
    id: crypto.randomUUID(), title: "legacy gemini", createdAt: now, updatedAt: now,
    archived: false, codexThreadId: null, codexProfile: "default",
    model: GEMINI, harnessId: "google-antigravity", providerId: "sub2api",
    reasoning: "medium", accessMode: "danger-full-access", workDir: "", messages: [],
  };
  service.writeConversation(legacy);

  // Display is not rewritten to the default.
  const stored = service.readConversation(legacy.id);
  assert.equal(stored.model, GEMINI);
  assert.equal(service.publicConversation(stored).model, GEMINI);
  assert.equal(service.publicConversation(stored).providerId, "sub2api");
  assert.equal(service.publicConversation(stored).modelBlockedReason, PAUSED_RUNTIME_REASON);

  // Running it reports the pause instead of silently switching harness.
  const { assistantId } = queueTurn(service, legacy.id);
  await service.runNext();
  const after = service.readConversation(legacy.id);
  const assistant = after.messages.find((message) => message.id === assistantId);
  assert.equal(assistant.status, "failed");
  assert.match(assistant.text, /不可用于新回合/);
  assert.match(assistant.text, new RegExp(PAUSED_RUNTIME_REASON));
  assert.equal(after.model, GEMINI, "the stored model was rewritten");
  assert.equal(after.harnessId, "google-antigravity");
});

test("T-DEF-06 an existing GPT session binding is never rewritten", async () => {
  const { service } = makeService();
  const now = new Date().toISOString();
  const existing = {
    id: crypto.randomUUID(), title: "existing", createdAt: now, updatedAt: now,
    archived: false, codexThreadId: "thread-legacy", codexProfile: "default",
    model: "gpt-5.6-sol", reasoning: "medium", accessMode: "danger-full-access",
    workDir: "", messages: [],
  };
  service.writeConversation(existing);
  await service.readCapabilities({});
  service.createConversation("brand new");
  const after = service.readConversation(existing.id);
  assert.equal(after.model, "gpt-5.6-sol");
  assert.equal(after.codexThreadId, "thread-legacy");
  assert.equal(service.publicConversation(after).model, "gpt-5.6-sol");
});

// ------------------------------------------------------------ script safety

const readScript = (name) => fs.readFileSync(path.join(REPO, "scripts", name), "utf8");

test("T-SCRIPT-01 the E2E script never kills a non-owned process", () => {
  const script = readScript("live-e2e-remote.sh");

  assert.equal(script.includes("OLD_PID"), false, "port-holder lookup still present");

  // The port-derived PID may only be used to VERIFY ownership, never to kill.
  // A PID taken from `ss` output must never be the argument of a kill.
  assert.equal(/kill[^\n]*port_owner_pid/.test(script), false,
    "the port-derived PID is passed to kill");
  assert.equal(/kill[^\n]*\$owner/.test(script), false,
    "the port owner variable is passed to kill");
  assert.equal(/kill[^\n]*\$OLD_PID/.test(script), false, "stale port-holder kill present");

  // Every shell kill must target the recorded $pid. `kill -0` is a liveness probe,
  // not a termination, so it is examined separately below.
  const killTargets = [...script.matchAll(/\bkill\s+(?:-(?!0)\w+\s+)?"?\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)]
    .map((match) => match[1]);
  assert.ok(killTargets.length > 0, "expected the script to stop its own backend");
  for (const target of killTargets) {
    assert.equal(target, "pid", `kill targeted unexpected variable: ${target}`);
  }
  // Termination signals must never be aimed at the PID discovered from the port,
  // nor at the pre-existing PID file value. Signal 0 (probing) is excluded.
  for (const forbidden of ["owner", "EXISTING", "OLD_PID"]) {
    const pattern = new RegExp(`kill\\s+-(?!0)\\w+\\s+"?\\$${forbidden}`);
    assert.equal(pattern.test(script), false, `termination signal aimed at $${forbidden}`);
  }
  // Liveness probing is expected and must use signal 0.
  assert.ok(/kill -0 "\$pid"/.test(script), "no signal-0 liveness probe for our own pid");
  assert.ok(/kill -0 "\$EXISTING"/.test(script), "no signal-0 probe of the existing pid");
  // Ownership verification is still required.
  assert.ok(/port_owner_pid\(\)\s*\{/.test(script), "no port ownership helper");
  assert.ok(/"\$owner" = "\$pid"/.test(script), "port ownership is not compared");

  assert.ok(/mktemp -d \/tmp\/witt-e2e-/.test(script), "no private run directory");
  assert.ok(/bind\(\('127\.0\.0\.1',0\)\)/.test(script), "no OS-assigned free port");
  assert.ok(script.includes("/proc/$pid/cmdline"), "no cmdline verification");
  assert.ok(script.includes('readlink "/proc/$pid/cwd"'), "no cwd verification");
  assert.ok(script.includes("refusing to stop"), "no refusal path for foreign PIDs");
  assert.ok(script.includes("refusing to SIGKILL"), "no refusal path before SIGKILL");
  assert.ok(script.includes("/tmp/witt-e2e-*"), "cleanup is not scoped to its own directory");
});

test("T-SCRIPT-02 the deploy script never deletes the live directory", () => {
  const script = readScript("deploy-live.py");

  assert.equal(/rm -rf \{TARGET\}/.test(script), false, "live directory is still deleted");
  assert.equal(/\brm -rf \/root\/witt-app\b/.test(script), false, "hardcoded live delete present");
  assert.equal(/shutil\.rmtree/.test(script), false, "rmtree is not whitelisted");

  assert.ok(script.includes("ALLOWED_TARGETS"), "no target whitelist");
  assert.ok(script.includes("def require_safe"), "no path validator");
  assert.ok(script.includes("allow_derived=True"), "derived paths are not validated");
  assert.ok(script.includes("def make_archive_path"), "no single archive-path source");
  assert.ok(script.includes("ARCHIVE_RE"), "archive path is not whitelisted");
  assert.ok(script.includes("DERIVED"), "derived directory shape is not validated");

  // Any rm -rf must be limited to a path this run created.
  const removals = [...script.matchAll(/rm -rf ([^\s"']+)/g)].map((match) => match[1]);
  for (const target of removals) {
    assert.ok(["{path}"].includes(target), `unexpected removal target: ${target}`);
  }
});

test("T-SCRIPT-03 no wildcard or piped mass deletion in either script", () => {
  for (const name of ["live-e2e-remote.sh", "deploy-live.py"]) {
    const script = readScript(name);
    assert.equal(/xargs[^\n]*rm\s+-rf/.test(script), false, `${name}: piped rm -rf via xargs`);
    assert.equal(/rm\s+-rf[^\n]*\*/.test(script), false, `${name}: wildcard rm -rf`);
    assert.equal(/rm\s+-rf\s+\/root\/witt-app\./.test(script), false,
      `${name}: wildcard removal of sibling directories`);
    assert.equal(/shutil\.rmtree/.test(script), false, `${name}: rmtree is not whitelisted`);
  }
});

test("T-SCRIPT-04 a failed check makes the E2E script exit non-zero", () => {
  const script = readScript("live-e2e-remote.sh");
  // Python must compute a failure set and exit accordingly.
  assert.ok(/failed = \[t for t, _n, r in RESULTS if r != "PASS"\]/.test(script),
    "no failure aggregation");
  assert.ok(/raise SystemExit\(0 if not failed else 1\)/.test(script),
    "python does not exit non-zero on failure");
  // The shell must propagate that code, and a failing cleanup must upgrade it.
  assert.ok(/E2E_EXIT=\$\?/.test(script), "shell does not capture the python exit code");
  assert.ok(/finish_with_cleanup "\$E2E_EXIT"/.test(script), "cleanup is not run explicitly");
  assert.ok(/exit "\$FINAL_EXIT"/.test(script), "shell does not propagate the final code");
  assert.ok(/verify_started \|\| fatal/.test(script), "startup failure is not fatal");
  // Lifecycle behaviour lives in one shared, separately tested library.
  assert.ok(/e2e-lifecycle\.sh/.test(script), "shared lifecycle library is not sourced");
  assert.ok(/install_lifecycle_traps/.test(script), "lifecycle traps are not installed");
  assert.equal(/trap cleanup EXIT/.test(script), false, "old combined trap still present");
});

test("T-SCRIPT-05 a failed stop aborts and never overwrites a live PID file", () => {
  const script = readScript("live-e2e-remote.sh");
  // Refuse to clobber a PID file that still refers to a live process.
  assert.ok(/PID file already tracks live process/.test(script),
    "no guard against overwriting a live PID file");
  assert.ok(/refusing to overwrite/.test(script), "no refusal message for the PID file");
  // A restart must not silently proceed when the stop failed.
  assert.ok(/if not stopped:/.test(script) || /stopped = stop_own_backend\(\)/.test(script),
    "restart does not branch on the stop result");
  assert.ok(/could not stop the running backend/.test(script),
    "restart does not report a failed stop");
  // The new process must be verified alive and owning the port.
  assert.ok(/def start_and_verify\(\)/.test(script), "no verified restart helper");
  assert.ok(/port_owner_pid\(PORT\) == process\.pid/.test(script),
    "restart does not confirm port ownership");
  assert.ok(/process\.poll\(\) is not None/.test(script),
    "restart does not confirm the process is still alive");
  // Cleanup must confirm the port was released.
  assert.ok(/test port \$PORT released/.test(script), "cleanup does not verify port release");
});

test("T-SCRIPT-06 the deploy script checks exit codes and reports rollback honestly", () => {
  const script = readScript("deploy-live.py");
  assert.ok(/recv_exit_status\(\)/.test(script), "remote exit status is never read");
  assert.ok(/class StepFailed/.test(script), "no failure type for a non-zero step");
  assert.ok(/def require\(/.test(script), "no non-zero step guard");
  assert.ok(/def recover\(/.test(script), "no recovery routine");
  assert.ok(/nothing-to-restore/.test(script), "missing-previous-release case not handled");
  assert.ok(/restore-unverified/.test(script), "a restore is not verified before being claimed");
  assert.ok(/RESTORE FAILED/.test(script), "a failed restore is not reported as failed");
  // Swap must be two separately labelled, separately checked steps.
  assert.ok(/move old release aside/.test(script), "moving the old release is not its own step");
  assert.ok(/publish new release/.test(script), "publishing is not its own step");
  // Unique names, and a single archive-path source.
  assert.ok(/def make_release_suffix/.test(script), "no unique release suffix helper");
  assert.ok(/def make_archive_path/.test(script), "no archive path helper");
  assert.ok(/uuid\.uuid4\(\)/.test(script), "names are not randomised");
  // No automatic pruning.
  assert.equal(/xargs/.test(script), false, "xargs based pruning is still present");
  assert.ok(/Nothing is auto-pruned/.test(script), "pruning policy is not documented");
});

test("T-SCRIPT-07 cleanup and signal handling have an executable test", () => {
  const lib = fs.readFileSync(path.join(REPO, "scripts", "lib", "e2e-lifecycle.sh"), "utf8");
  const driver = fs.readFileSync(path.join(REPO, "scripts", "test_lifecycle_exit.sh"), "utf8");

  // Library guarantees.
  assert.ok(/LIFECYCLE_CLEANUP_DONE/.test(lib), "cleanup is not idempotence-guarded");
  assert.ok(/exit 143/.test(lib), "SIGTERM does not exit non-zero");
  assert.ok(/exit 130/.test(lib), "SIGINT does not exit non-zero");
  assert.ok(/finish_with_cleanup/.test(lib), "no explicit normal-path cleanup");
  assert.ok(/LIFECYCLE_CLEANUP_RC/.test(lib), "cleanup status is not tracked");
  assert.ok(/lifecycle_exit_handler/.test(lib), "no exit handler");
  assert.ok(/rc=1/.test(lib), "a failing cleanup cannot upgrade the exit code");

  // The test must execute real fixtures rather than search for strings.
  assert.ok(/mktemp -d/.test(driver), "test does not build a fixture directory");
  assert.ok(/bash "\$script"/.test(driver), "test does not execute a fixture");
  assert.ok(/actual_exit/.test(driver), "test does not assert the exit code");
  assert.ok(/actual_count/.test(driver), "test does not count cleanup executions");
  assert.ok(/exit 143/.test(driver) || /sigterm_cleans_up/.test(driver),
    "SIGTERM behaviour is not exercised");
  assert.ok(/exit 1/.test(driver), "test does not fail when an assertion fails");
});

test("model selection rejects cross-family harness overrides without changing the session", () => {
  for (const [model, harness] of [["gpt-5.6-sol", "grok-build"], ["grok-4.7-high", "codex"]]) {
    const { service, sent } = makeService({ requestBody: { model, harness } });
    const conversation = service.createConversation("routing", model);
    service.updateConversationSettings({}, {}, conversation.id);
    assert.equal(sent.at(-1).status, 400);
    assert.equal(sent.at(-1).body.blockReason, "model_harness_mismatch");
    assert.equal(service.readConversation(conversation.id).harnessId, conversation.harnessId);
  }
});

test("Grok turns dispatch only to Grok Build; GPT turns use Codex app-server", async () => {
  for (const model of ["grok-4.7-high", "gpt-5.6-sol", "gpt-6-astra"]) {
    const { service } = makeService();
    const conversation = service.createConversation("routing", model);
    const calls = [];
    service.runGrokTurn = async (...args) => { calls.push(["grok-build", args[3]]); };
    service.clientFor = () => ({
      async start() { calls.push(["codex-start"]); },
      async request(method, params) {
        calls.push([method, params.model]);
        if (method === "thread/start") return { thread: { id: "routing-thread" } };
        if (method === "turn/start") return { turn: { id: "routing-turn" } };
        throw new Error(`Unexpected request ${method}`);
      },
    });
    queueTurn(service, conversation.id);
    await service.runNext();
    assert.deepEqual(calls, model.startsWith("grok")
      ? [["grok-build", model]]
      : [["codex-start"], ["thread/start", model], ["turn/start", model]]);
    service.active = null;
  }
});

test("a persisted mismatched binding fails without launching either runtime or rewriting history", async () => {
  for (const [model, harness] of [["gpt-5.6-sol", "grok-build"], ["grok-4.7-high", "codex"]]) {
    const { service } = makeService();
    const conversation = service.createConversation("legacy routing", model);
    conversation.harnessId = harness;
    conversation.harnessSessionId = "existing-context";
    service.writeConversation(conversation);
    let launched = false;
    service.runGrokTurn = async () => { launched = true; };
    service.clientFor = () => { launched = true; throw new Error("wrong runtime"); };
    const { assistantId } = queueTurn(service, conversation.id);
    await service.runNext();
    const after = service.readConversation(conversation.id);
    assert.equal(launched, false);
    assert.equal(after.harnessId, harness);
    assert.equal(after.harnessSessionId, "existing-context");
    const assistant = after.messages.find((message) => message.id === assistantId);
    assert.equal(assistant.status, "failed");
    assert.match(assistant.text, /模型与 Harness 不匹配/);
  }
});
