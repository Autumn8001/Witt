"use strict";

const { CodexHarnessAdapter } = require("./codex-harness-adapter");
const { GrokBuildAdapter } = require("./grok-build-adapter");
const { AntigravityAdapter } = require("./antigravity-adapter");
const { DeclaredHarnessAdapter } = require("./declared-harness-adapter");
const { HarnessRuntimeManager } = require("./harness-runtime-manager");
const { resolveHarness, harnessChanged, HARNESSES } = require("./runtime-resolver");
const { ProviderRegistry } = require("./provider-registry");
const { RuntimeProfileStore } = require("./runtime-profiles");
const { RuntimeLogger } = require("./runtime-log");
const { describeBinary, resolveBinary } = require("./runtime-binaries");
const {
  parseGrokEvent, parseAntigravityEvent, classifyProviderStatus, parseNdjsonLines,
} = require("./event-parsers");

function createHarness(id, options = {}) {
  if (id === "codex") return new CodexHarnessAdapter(options);
  if (id === "grok-build") return new GrokBuildAdapter(options);
  if (id === "google-antigravity") return new AntigravityAdapter(options);
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
  CodexHarnessAdapter,
  GrokBuildAdapter,
  AntigravityAdapter,
  DeclaredHarnessAdapter,
  HarnessRuntimeManager,
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
