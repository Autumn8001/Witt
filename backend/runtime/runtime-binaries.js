"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Where each official CLI normally lands, plus the bare command name so a
// PATH-resolved install still works. Used by executable-detection tests and by
// the adapters before they try to spawn anything.
const DEFAULT_BINARIES = {
  codex: {
    command: "codex",
    candidates: [
      "/home/ubuntu/.local/bin/codex",
      "/usr/local/bin/codex",
      "/root/.local/bin/codex",
    ],
    versionArgs: ["--version"],
    install: "npm i -g @openai/codex",
  },
  "grok-build": {
    command: "grok",
    candidates: [
      "/root/.local/bin/grok",
      "/usr/local/bin/grok",
      "/home/ubuntu/.local/bin/grok",
    ],
    versionArgs: ["--version"],
    install: "curl -fsSL https://x.ai/cli/install.sh | bash",
  },
  "google-antigravity": {
    command: "agy",
    candidates: [
      "/root/.local/bin/agy",
      "/usr/local/bin/agy",
      "/home/ubuntu/.local/bin/agy",
    ],
    versionArgs: ["--version"],
    install: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
  },
};

function resolveBinary(harnessId, options = {}) {
  const spec = DEFAULT_BINARIES[harnessId];
  if (!spec) return null;
  if (options.bin) return options.bin;
  if (process.env.WITT_HARNESS_BIN) {
    const override = process.env.WITT_HARNESS_BIN;
    if (harnessId === "codex") return override;
  }
  for (const candidate of spec.candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return spec.command;
}

function describeBinary(harnessId, options = {}) {
  const spec = DEFAULT_BINARIES[harnessId];
  if (!spec) return null;
  const resolved = resolveBinary(harnessId, options);
  let exists = false;
  try {
    fs.accessSync(resolved, fs.constants.X_OK);
    exists = true;
  } catch {
    exists = false;
  }
  return {
    harness: harnessId,
    bin: resolved,
    absolute: path.isAbsolute(resolved),
    exists,
    install: spec.install,
    versionArgs: spec.versionArgs.slice(),
  };
}

module.exports = { DEFAULT_BINARIES, resolveBinary, describeBinary };
