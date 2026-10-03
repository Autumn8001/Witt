"use strict";

const { GrokBuildAdapter } = require("./grok-build-adapter");
const { resolveHarness, harnessChanged, HARNESSES } = require("./runtime-resolver");
const { ProviderRegistry } = require("./provider-registry");
const { RuntimeProfileStore } = require("./runtime-profiles");
const { RuntimeLogger } = require("./runtime-log");
const { describeBinary, resolveBinary } = require("./runtime-binaries");
const {
  parseGrokEvent, parseAntigravityEvent, classifyProviderStatus, parseNdjsonLines,
} = require("./event-parsers");

function createHarness(id, options = {}) {
  if (id === "codex") return new (require("./codex-harness-adapter").CodexHarnessAdapter)(options);
  if (id === "grok-build") return new GrokBuildAdapter(options);
  if (id === "google-antigravity") return new (require("./antigravity-adapter").AntigravityAdapter)(options);
  throw new Error(`Unsupported harness: ${id}`);
}

// Reports what is actually installed, without inventing capability.
function harnessInventory(options = {}) {
  return Object.keys(HARNESSES).map((id) => {
    const described = describeBinary(id, options);
    return {
      id,
      displayName: HARNESSES[id].displayName,
      bin: described ? described.bin : null,
      installed: Boolean(described && described.exists),
      install: described ? described.install : null,
    };
  });
}

module.exports = {
  get CodexHarnessAdapter() { return require("./codex-harness-adapter").CodexHarnessAdapter; },
  GrokBuildAdapter,
  get AntigravityAdapter() { return require("./antigravity-adapter").AntigravityAdapter; },
  get DeclaredHarnessAdapter() { return require("./declared-harness-adapter").DeclaredHarnessAdapter; },
  get HarnessRuntimeManager() { return require("./harness-runtime-manager").HarnessRuntimeManager; },
  ProviderRegistry,
  RuntimeProfileStore,
  RuntimeLogger,
  createHarness,
  harnessInventory,
  describeBinary,
  resolveBinary,
  resolveHarness,
  harnessChanged,
  HARNESSES,
  parseGrokEvent,
  parseAntigravityEvent,
  classifyProviderStatus,
  parseNdjsonLines,
};
