"use strict";

const CAPABILITY_KEYS = [
  "sessions", "resume", "fork", "compact", "review", "approvals", "mcp",
  "shell", "files", "diff", "subagents", "skills", "hooks",
  "reasoning_levels", "images", "artifacts", "streaming", "cancel", "tools",
];

function capabilities(overrides = {}) {
  const value = {};
  for (const key of CAPABILITY_KEYS) value[key] = false;
  return { ...value, ...overrides };
}

const CODEX_CAPABILITIES = capabilities({
  sessions: true,
  resume: true,
  fork: true,
  compact: true,
  review: true,
  approvals: true,
  mcp: true,
  shell: true,
  files: true,
  diff: true,
  skills: true,
  reasoning_levels: true,
  images: true,
  artifacts: true,
  streaming: true,
  cancel: true,
  tools: true,
});

module.exports = { CAPABILITY_KEYS, capabilities, CODEX_CAPABILITIES };
