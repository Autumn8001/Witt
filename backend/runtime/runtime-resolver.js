"use strict";

const HARNESSES = {
  codex: { id: "codex", displayName: "Codex" },
  "grok-build": { id: "grok-build", displayName: "Grok Build" },
  "google-antigravity": { id: "google-antigravity", displayName: "Gemini" },
};

function resolveHarness(modelId, override = "auto") {
  const model = String(modelId || "").toLowerCase();
  const requested = String(override || "auto").toLowerCase();
  if (requested && requested !== "auto") {
    if (!HARNESSES[requested]) throw new Error(`Unknown harness override: ${override}`);
    return requested;
  }
  if (model.startsWith("grok-") || model.startsWith("grok")) return "grok-build";
  if (model.startsWith("gemini-") || model.startsWith("gemini")) return "google-antigravity";
  if (model.startsWith("deepseek-") || model.startsWith("deepseek")) return "codex";
  if (model.startsWith("gpt-") || model.startsWith("gpt")) return "codex";
  return "codex";
}

function harnessChanged(currentHarness, nextModel, override = "auto") {
  const next = resolveHarness(nextModel, override);
  return currentHarness && currentHarness !== next;
}

module.exports = { HARNESSES, resolveHarness, harnessChanged };
