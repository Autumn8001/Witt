"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "web", "app-workspace-20260916-r3.js"), "utf8");
const html = fs.readFileSync(path.join(root, "web", "index.html"), "utf8");

test("index loads the active workspace script and exposes the MVP settings entry", () => {
  assert.match(html, /<script src="\/vault\/app-workspace-20260916-r3\.js\?/);
  assert.match(html, /id="runtimeSettingsButton"[^>]*type="button"[^>]*aria-controls="settingsSheet"/);
  assert.match(app, /\$\("#runtimeSettingsButton"\)\.addEventListener\("click"/);
  assert.match(app, /closeDrawer\(\);\s*openSettings\(\);/);
});

test("the browser preference migration defaults new conversations to the Grok model", () => {
  assert.match(app, /const MVP_DEFAULT_MODEL = "grok-4\.7-high"/);
  assert.match(app, /MVP_MODEL_MIGRATION_KEY = "wit_grok_mvp_model_migrated_v1"/);
  assert.match(app, /shouldMigrateModelPreference/);
  assert.match(app, /prepareNewConversationSettings\(\)/);
  assert.match(app, /nativeBridge\.createConversation\(state\.model, state\.reasoning, state\.accessMode\)/);
  assert.doesNotMatch(app, /restorePreferredSettings\(/);
});

test("capabilities reconcile only the preference and never rewrite a loaded conversation", () => {
  assert.match(app, /function reconcileModelPreference\(\)/);
  assert.match(app, /available\.includes\(MVP_DEFAULT_MODEL\)/);
  assert.match(app, /if \(!state\.activeId \|\| !state\.active\)/);
  assert.match(app, /state\.draftModel = state\.model;/);
  assert.match(app, /state\.model = conversation\.model \|\| state\.model;/);
});

test("runtime profiles and server overview load after authentication without blocking chat", () => {
  assert.match(app, /fetch\("\/vault-api\/runtime\/profiles"/);
  assert.match(app, /fetch\("\/vault-api\/servers\/overview"/);
  assert.match(app, /void loadRuntimeExtras\(\);/g);
  assert.match(app, /totalBytes \|\| memory\.total/);
  assert.match(app, /usedBytes \|\| memory\.used/);
  assert.match(app, /payload\.http/);
  assert.match(app, /Runtime Profile 暂时不可用/);
  assert.match(app, /聊天功能不受影响/);
});

test("only serviceable runtime profiles can be selected and harness defaults to Auto", () => {
  assert.match(app, /harness: "auto"/);
  assert.match(app, /profile\.harness && runtime\[profile\.harness\]\?\.available !== true/);
  assert.match(app, /profile\.model !== MVP_DEFAULT_MODEL/);
  assert.match(app, /unavailable \? " unavailable"/);
  assert.match(app, /state\.harness = "auto";/);
  assert.match(app, /state\.draftReasoning = selected\.reasoning;/);
  assert.match(app, /state\.activeId, state\.model, state\.reasoning, state\.accessMode, state\.harness/);
  // Account management is intentionally parked in the Focus navigation.
  assert.match(app, /codexAccounts\.hidden = true/);
  assert.match(app, /if \(harness && harness !== "codex"\)/);
});

test("static first paint and settings placeholder are Grok-only", () => {
  assert.match(html, /id="modelLabel">Grok 4\.7 High</);
  assert.match(html, /id="quickPickerTitle">选择模型</);
  assert.match(html, /data-model="grok-4\.7-high"/);
  assert.doesNotMatch(html, /data-model="gpt-6-astra"/);
});
