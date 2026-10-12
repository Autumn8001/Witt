"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const app = fs.readFileSync(path.resolve(__dirname, "../web/app-workspace-20260916-r3.js"), "utf8");

test("Sub2API GPT model descriptions identify the configured account group", () => {
  assert.match(app, /"gpt-6\.1-sol": "GPT-6\.1 Sol"/);
  assert.match(app, /"gpt-6\.1-sol": "Plus 账号组额度/);
  assert.match(app, /"gpt-5\.6-terra": "Free 账号组额度/);
  assert.match(app, /"gpt-5\.6-luna": "Free 账号组额度/);
  assert.match(app, /"gpt-6-luna": "Free 账号组额度/);
});

test("Sub2API runtime profiles have clear Chinese labels and explain automatic routing", () => {
  assert.match(app, /"codex-plus": "Sol · Plus 账号额度"/);
  assert.match(app, /"codex-free": "Luna · Free 账号额度"/);
  assert.match(app, /"codex-terra": "Terra · Free 账号额度"/);
  assert.match(app, /state\.runtimeProfiles\.some\(\(profile\) => sub2apiProfileNames\[profile\?\.id\]\)/);
  assert.match(app, /GPT-6\.1 Sol 使用 Plus；Luna、Terra 使用 Free/);
});

test("the picker only renders backend capabilities and keeps unavailable profiles disabled", () => {
  assert.match(app, /Array\.isArray\(state\.capabilities\?\.models\) \? state\.capabilities\.models : \[\]/);
  assert.match(app, /\.model-options"\)\.innerHTML = models\.map/);
  assert.match(app, /!availableModels\.includes\(profile\.model\)/);
  assert.match(app, /\$\("#quickModelOptions"\)\.innerHTML = models\.map/);
  assert.doesNotMatch(app, /\[\s*"gpt-6\.1-sol"[^\]]*"gpt-5\.6-terra"/);
});

test("new GPT models are not mistaken for legacy preferences during migration", () => {
  assert.match(app, /const LEGACY_DEFAULT_MODELS = new Set\(/);
  assert.doesNotMatch(app, /previousModel\.startsWith\("gpt-"\)/);
  assert.doesNotMatch(app.match(/const LEGACY_DEFAULT_MODELS = new Set\(\[([\s\S]*?)\]\);/)?.[1] || "", /gpt-6\.1-sol/);
});
