"use strict";

const path = require("node:path");

// This is an explicit product catalog, not a probe of Sub2API account access.
// Keeping it closed prevents a new/unknown GPT slug from silently consuming a
// different account pool.
const SUB2API_CODEX_MODELS = Object.freeze({
  "gpt-6.1-sol": "plus",
  "gpt-6-luna": "free",
  "gpt-5.6-terra": "free",
  "gpt-5.6-luna": "free",
});

function sub2apiGroupForModel(model) {
  return SUB2API_CODEX_MODELS[String(model || "")] || null;
}

function createSub2ApiRoute({ model, sub2api }) {
  if (!sub2api) return null;
  const group = sub2apiGroupForModel(model);
  if (!group) {
    const error = new Error(`Unsupported Sub2API model route: ${String(model || "")}`);
    error.code = "unsupported_sub2api_model_route";
    throw error;
  }
  const key = String(group === "plus" ? sub2api.plusKey || "" : sub2api.freeKey || "");
  if (!key) {
    const error = new Error(`Sub2API ${group} group is not configured`);
    error.code = "sub2api_group_key_missing";
    error.group = group;
    throw error;
  }
  const baseUrl = String(sub2api.baseUrl || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(baseUrl)) {
    const error = new Error("Sub2API base URL is not configured");
    error.code = "sub2api_base_url_missing";
    throw error;
  }
  const providerId = `chloe-sub2api-${group}`;
  const displayGroup = group === "plus" ? "Plus" : "Free";
  const codexHomeRoot = String(sub2api.codexHomeRoot || "").trim();
  if (!path.isAbsolute(codexHomeRoot)) {
    const error = new Error("Sub2API Codex home root must be absolute");
    error.code = "sub2api_codex_home_invalid";
    throw error;
  }
  const configOverrides = [
    `model_provider=${JSON.stringify(providerId)}`,
    `model_providers.${providerId}.name=${JSON.stringify(`Chloe Sub2API ${displayGroup}`)}`,
    `model_providers.${providerId}.base_url=${JSON.stringify(baseUrl)}`,
    `model_providers.${providerId}.wire_api="responses"`,
    `model_providers.${providerId}.requires_openai_auth=false`,
    `model_providers.${providerId}.supports_websockets=false`,
    `model_providers.${providerId}.env_key="CHLOE_SUB2API_KEY"`,
  ];
  return {
    group,
    providerId,
    codexHome: path.join(codexHomeRoot, group),
    configOverrides,
    envOverrides: { CHLOE_SUB2API_KEY: key },
    cacheIdentity: `${providerId}:${baseUrl}`,
  };
}

module.exports = { SUB2API_CODEX_MODELS, sub2apiGroupForModel, createSub2ApiRoute };
