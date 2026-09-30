"use strict";

const { CodexHarnessAdapter } = require("./codex-harness-adapter");
const { DeclaredHarnessAdapter } = require("./declared-harness-adapter");
const { HarnessRuntimeManager } = require("./harness-runtime-manager");
const { resolveHarness, harnessChanged, HARNESSES } = require("./runtime-resolver");
const { ProviderRegistry } = require("./provider-registry");
const { RuntimeProfileStore } = require("./runtime-profiles");

function createHarness(id, options = {}) {
  if (id === "codex") return new CodexHarnessAdapter(options);
  if (id === "grok-build") {
    return new DeclaredHarnessAdapter({
      id,
      displayName: "Grok Build",
      capabilityOverrides: { sessions: false, streaming: false, tools: false },
      unavailableReason: options.unavailableReason
        || "Grok Build official runtime is not configured; no Computer Use fallback is allowed",
    });
  }
  if (id === "google-antigravity") {
    return new DeclaredHarnessAdapter({
      id,
      displayName: "Gemini",
      capabilityOverrides: { sessions: false, streaming: false, tools: false },
      unavailableReason: options.unavailableReason
        || "Google Antigravity runtime is not configured",
    });
  }
  throw new Error(`Unsupported harness: ${id}`);
}

module.exports = {
  CodexHarnessAdapter,
  DeclaredHarnessAdapter,
  HarnessRuntimeManager,
  ProviderRegistry,
  RuntimeProfileStore,
  createHarness,
  resolveHarness,
  harnessChanged,
  HARNESSES,
};
