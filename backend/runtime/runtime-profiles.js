"use strict";

const { resolveHarness } = require("./runtime-resolver");

const DEFAULT_PROFILES = [
  {
    id: "grok-main",
    name: "Grok Main",
    harness: "grok-build",
    provider: "cpa",
    model: "grok-4.7",
    reasoning: "high",
  },
  {
    id: "gemini-fast",
    name: "Gemini Fast",
    harness: "google-antigravity",
    provider: "sub2api",
    model: "gemini-3.8-flash",
    reasoning: "medium",
  },
  {
    id: "codex-default",
    name: "Codex Default",
    harness: "codex",
    provider: "cpa",
    model: "gpt-5.5",
    reasoning: "medium",
  },
];

class RuntimeProfileStore {
  constructor(profiles = DEFAULT_PROFILES) {
    this.profiles = new Map(profiles.map((profile) => [profile.id, { ...profile }]));
  }

  list() {
    return [...this.profiles.values()].map((profile) => ({
      ...profile,
      harness: profile.harness || resolveHarness(profile.model, "auto"),
      harnessMode: "auto",
    }));
  }

  get(id) {
    const profile = this.profiles.get(id);
    return profile ? { ...profile } : null;
  }
}

module.exports = { RuntimeProfileStore, DEFAULT_PROFILES };
