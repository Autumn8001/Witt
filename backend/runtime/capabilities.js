"use strict";

// Capability values are tri-state on purpose:
//   true      -> observed working on the real runtime
//   false     -> the runtime does not provide it
//   "unknown" -> not verified yet; the UI must not treat it as available
const CAPABILITY_KEYS = [
  "sessions", "resume", "fork", "compact", "review", "approvals", "mcp",
  "shell", "files", "diff", "subagents", "skills", "hooks",
  "reasoning_levels", "images", "artifacts", "streaming", "cancel", "tools",
  "model_selection", "stdin_sessions",
];

function capabilities(overrides = {}) {
  const value = {};
  for (const key of CAPABILITY_KEYS) value[key] = false;
  return { ...value, ...overrides };
}

// Verified against Codex app-server behaviour that upstream Witt already relied on.
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
  model_selection: true,
});

// Verified live on Grok Build 1.0.44 against CPA on 2026-09-30.
// See docs/MILESTONE-1-INTEGRATION.md for the individual test IDs.
const GROK_BUILD_CAPABILITIES = capabilities({
  sessions: true,          // T-GROK-04: fixed UUID accepted, sessionId returned
  resume: true,            // T-GROK-05/06: cross-process resume recalled context
  fork: "unknown",         // --fork-session exists but was not exercised
  compact: true,           // auto_compact_* events and the compact command exist
  review: false,           // no review command in available_commands
  approvals: false,        // headless has permission modes, not interactive approvals
  mcp: true,               // T-A5.2: search_tool + use_tool against a stdio MCP server
  shell: true,             // run_terminal_command in the advertised tool list
  files: true,             // read_file / write / search_replace
  diff: "unknown",
  subagents: true,         // spawn_subagent advertised
  skills: true,
  hooks: true,
  reasoning_levels: true,  // thought deltas plus --reasoning-effort
  images: true,            // image_gen / image_edit advertised
  artifacts: false,
  streaming: true,         // T-GROK-03: streaming-json NDJSON
  cancel: true,            // T-GROK-07: SIGTERM, exit 143, partial stream kept
  tools: true,             // T-A5.1 built-in tool plus T-A5.2 MCP
  model_selection: true,   // -m / --model, grok models discovery
  stdin_sessions: "unknown",
});

// Antigravity: schema read from the official docs, but the binary cannot execute
// on this host (missing pclmulqdq), so behaviour is unverified.
const ANTIGRAVITY_CAPABILITIES = capabilities({
  sessions: "unknown",
  resume: "unknown",
  streaming: "unknown",
  tools: "unknown",
  mcp: "unknown",
  reasoning_levels: "unknown",
  model_selection: "unknown",
  cancel: "unknown",
  approvals: false,
});

module.exports = {
  CAPABILITY_KEYS,
  capabilities,
  CODEX_CAPABILITIES,
  GROK_BUILD_CAPABILITIES,
  ANTIGRAVITY_CAPABILITIES,
};
