"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { AppServerClient, sharedAppServer } = require("../backend/app-server-client");
const { ChatService } = require("../backend/chat-service");
const { SUB2API_CODEX_MODELS, createSub2ApiRoute } = require("../backend/sub2api-routing");

const timeout = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const keyPlus = "test-plus-secret-never-in-argv";
const keyFree = "test-free-secret-never-in-argv";

function serviceFixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chloe-sub2api-routing-"));
  const service = new ChatService({
    chatDir: path.join(root, "chat"),
    dataDir: path.join(root, "data"),
    codexBin: process.execPath,
    codexWorkDir: root,
    allowedModels: null,
    sub2api: {
      baseUrl: "http://127.0.0.1:8080/v1",
      plusKey: keyPlus,
      freeKey: keyFree,
      codexHomeRoot: path.join(root, "codex-home"),
    },
    sendJson(_res, status, payload) { _res.status = status; _res.payload = payload; },
    readJsonBody(req, _limit, callback) { callback(null, req.body || {}); },
    ...overrides,
  });
  service.runNext = () => {};
  t.after(async () => {
    await service.recovery;
    for (const entry of service.jsonCheckpoints.values()) clearTimeout(entry.timer);
    for (const timer of service.eventBroadcasts.values()) clearTimeout(timer);
    service.store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, service };
}

test("Sub2API catalog maps only the explicit models to Plus or Free", () => {
  assert.deepEqual(SUB2API_CODEX_MODELS, {
    "gpt-6.1-sol": "plus",
    "gpt-6-luna": "free",
    "gpt-5.6-terra": "free",
    "gpt-5.6-luna": "free",
  });
  const root = path.join(os.tmpdir(), "chloe-codex-home");
  const plus = createSub2ApiRoute({ model: "gpt-6.1-sol", sub2api: {
    baseUrl: "http://127.0.0.1:8080/v1/", plusKey: keyPlus, freeKey: keyFree,
    codexHomeRoot: root,
  } });
  const free = createSub2ApiRoute({ model: "gpt-5.6-terra", sub2api: {
    baseUrl: "http://127.0.0.1:8080/v1", plusKey: keyPlus, freeKey: keyFree,
    codexHomeRoot: root,
  } });
  assert.equal(plus.group, "plus");
  assert.equal(free.group, "free");
  assert.notEqual(plus.codexHome, free.codexHome);
  assert.ok(plus.configOverrides.includes('model_providers.chloe-sub2api-plus.wire_api="responses"'));
  assert.ok(plus.configOverrides.includes('model_providers.chloe-sub2api-plus.requires_openai_auth=false'));
  assert.ok(plus.configOverrides.includes('model_providers.chloe-sub2api-plus.env_key="CHLOE_SUB2API_KEY"'));
  assert.ok(plus.configOverrides.every((entry) => !entry.includes(keyPlus) && !entry.includes(keyFree)));
  assert.deepEqual(plus.envOverrides, { CHLOE_SUB2API_KEY: keyPlus });
  assert.deepEqual(free.envOverrides, { CHLOE_SUB2API_KEY: keyFree });
  assert.throws(() => createSub2ApiRoute({ model: "gpt-6-astra", sub2api: {
    baseUrl: "http://127.0.0.1:8080/v1", plusKey: keyPlus, freeKey: keyFree,
    codexHomeRoot: root,
  } }), { code: "unsupported_sub2api_model_route" });
  assert.throws(() => createSub2ApiRoute({ model: "gpt-6.1-sol", sub2api: {
    baseUrl: "http://127.0.0.1:8080/v1", freeKey: keyFree, codexHomeRoot: root,
  } }), { code: "sub2api_group_key_missing" });
});

test("Codex child gets only the selected Sub2API key and keeps credentials off argv", async (t) => {
  const previousPlus = process.env.CHLOE_SUB2API_PLUS_KEY;
  const previousFree = process.env.CHLOE_SUB2API_FREE_KEY;
  process.env.CHLOE_SUB2API_PLUS_KEY = keyPlus;
  process.env.CHLOE_SUB2API_FREE_KEY = keyFree;
  t.after(() => {
    if (previousPlus === undefined) delete process.env.CHLOE_SUB2API_PLUS_KEY;
    else process.env.CHLOE_SUB2API_PLUS_KEY = previousPlus;
    if (previousFree === undefined) delete process.env.CHLOE_SUB2API_FREE_KEY;
    else process.env.CHLOE_SUB2API_FREE_KEY = previousFree;
  });

  let spawnOptions;
  const childCode = [
    'process.stderr.write(JSON.stringify({key:process.env.CHLOE_SUB2API_KEY,plus:Boolean(process.env.CHLOE_SUB2API_PLUS_KEY),free:Boolean(process.env.CHLOE_SUB2API_FREE_KEY),argv:process.argv.slice(1)})+"\\n");',
    'const readline=require("node:readline");',
    'readline.createInterface({input:process.stdin}).on("line",line=>{const m=JSON.parse(line);if(m.id)process.stdout.write(JSON.stringify({id:m.id,result:{}})+"\\n")});',
  ].join("");
  const client = new AppServerClient({
    codexBin: "codex-test-shim",
    cwd: process.cwd(),
    home: os.homedir(),
    codexHome: path.join(os.tmpdir(), "chloe-codex-plus-home"),
    configOverrides: ['model_provider="chloe-sub2api-plus"'],
    envOverrides: { CHLOE_SUB2API_KEY: keyPlus },
    spawnProcess(_bin, args, options) {
      assert.ok(args.every((arg) => !arg.includes(keyPlus) && !arg.includes(keyFree)));
      spawnOptions = options;
      return spawn(process.execPath, ["-e", childCode], options);
    },
  });
  await client.start();
  for (let i = 0; i < 40 && !client.stderr; i += 1) await timeout(10);
  client.close();
  assert.ok(spawnOptions);
  assert.equal(spawnOptions.env.CHLOE_SUB2API_KEY, keyPlus);
  assert.equal(spawnOptions.env.CHLOE_SUB2API_PLUS_KEY, undefined);
  assert.equal(spawnOptions.env.CHLOE_SUB2API_FREE_KEY, undefined);
  assert.ok(client.stderr.includes(`"key":"${keyPlus}"`));
  assert.ok(client.stderr.includes('"plus":false,"free":false'));
  assert.ok(!client.stderr.includes(keyFree));
  assert.ok(!client.stderr.includes(`"argv":[${JSON.stringify(keyPlus)}`));
});

test("shared app-server cache separates account groups and credential rotation without plaintext identity", () => {
  const unique = crypto.randomUUID();
  const plus = sharedAppServer({ codexBin: process.execPath, cwd: process.cwd(),
    codexHome: `/tmp/chloe-${unique}-plus`, clientScope: unique,
    configOverrides: ["model_provider=chloe-sub2api-plus"], envOverrides: { CHLOE_SUB2API_KEY: keyPlus } });
  const free = sharedAppServer({ codexBin: process.execPath, cwd: process.cwd(),
    codexHome: `/tmp/chloe-${unique}-free`, clientScope: unique,
    configOverrides: ["model_provider=chloe-sub2api-free"], envOverrides: { CHLOE_SUB2API_KEY: keyFree } });
  const rotated = sharedAppServer({ codexBin: process.execPath, cwd: process.cwd(),
    codexHome: `/tmp/chloe-${unique}-plus`, clientScope: unique,
    configOverrides: ["model_provider=chloe-sub2api-plus"], envOverrides: { CHLOE_SUB2API_KEY: `${keyPlus}-rotated` } });
  assert.notEqual(plus, free);
  assert.notEqual(plus, rotated);
  assert.notEqual(plus.codexHome, free.codexHome);
  assert.ok(!JSON.stringify([plus.codexHome, plus.configOverrides]).includes(keyPlus));
  plus.close(); free.close(); rotated.close();
});

test("gateway capabilities are a local configured catalog and require the CLI and matching keys", async (t) => {
  const { service } = serviceFixture(t);
  service.clientFor = () => { throw new Error("gateway capabilities must not start app-server or query models"); };
  const result = await service.codexCapabilities(service.codexProfiles.default);
  assert.equal(result.available, true);
  assert.equal(result.configuration, "configured_not_model_verified");
  assert.deepEqual(result.models, []);
  assert.deepEqual(service.sub2apiCodexCatalog().map((model) => [model.id, model.accountGroup]), [
    ["gpt-6.1-sol", "plus"], ["gpt-6-luna", "free"],
    ["gpt-5.6-terra", "free"], ["gpt-5.6-luna", "free"],
  ]);
  assert.equal(service.modelAllowed("gpt-6.1-sol"), true);
  assert.equal(service.modelAllowed("gpt-6-astra"), false);

  const missingFree = serviceFixture(t, { sub2api: {
    baseUrl: "http://127.0.0.1:8080/v1", plusKey: keyPlus, freeKey: "",
    codexHomeRoot: path.join(os.tmpdir(), "chloe-missing-free"),
  } }).service;
  assert.deepEqual(missingFree.sub2apiCodexCatalog().map((model) => model.id), ["gpt-6.1-sol"]);
  assert.equal(missingFree.modelAllowed("gpt-6-luna"), false);

  const missingBin = serviceFixture(t, { codexBin: path.join(os.tmpdir(), `missing-codex-${crypto.randomUUID()}`) }).service;
  assert.deepEqual(missingBin.sub2apiCodexCatalog(), []);
  const missingBinStatus = await missingBin.codexCapabilities(missingBin.codexProfiles.default);
  assert.equal(missingBinStatus.available, false);
  assert.equal(missingBinStatus.reason, "executable_not_found");
});

test("switching between Plus and Free clears the old thread and replays Chloe history", (t) => {
  const { service } = serviceFixture(t);
  const conversation = service.createConversation("test", "gpt-6.1-sol", "high", "workspace-write");
  conversation.codexThreadId = "thread-plus-only";
  conversation.providerId = "codex";
  service.writeConversation(conversation);
  const response = {};
  service.updateConversationSettings({ body: { model: "gpt-6.1-sol" } }, response, conversation.id);
  const updated = service.readConversation(conversation.id);
  assert.equal(response.status, 200);
  assert.equal(updated.codexThreadId, null);
  assert.equal(updated.replayHistoryOnNextTurn, true);
  assert.equal(updated.providerId, "sub2api");
  service.updateConversationSettings({ body: { model: "gpt-5.6-terra" } }, response, conversation.id);
  const switched = service.readConversation(conversation.id);
  assert.equal(switched.model, "gpt-5.6-terra");
  assert.equal(switched.providerId, "sub2api");
  assert.equal(service.publicConversation(switched).accountGroup, "free");
});
