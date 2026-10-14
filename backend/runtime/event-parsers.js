"use strict";

// Pure parsers for harness NDJSON streams. Kept free of process handling so the
// wire mapping can be unit tested without the real binaries installed.
//
// Normalised event shape used across harnesses:
//   { type, text?, tool?, id?, status?, input?, output?, usage?, sessionId?,
//     stopReason?, error?, kind?, raw? }
// Normalised types: text_delta, reasoning_delta, tool_call, tool_call_update,
//   plan, commands, usage, init, end, result, notice, error, unknown.

function safeJson(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const value = JSON.parse(trimmed);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

function numberOrUndefined(value) {
  return Number.isFinite(Number(value)) ? Number(value) : undefined;
}

// ---------------------------------------------------------------------------
// Grok Build 1.0.44 -- `grok -p ... --output-format streaming-json`
// Verified live; see docs/MILESTONE-1-INTEGRATION.md (T-GROK-03, T-A5.1, T-A5.2).
// ---------------------------------------------------------------------------
function parseGrokEvent(payload) {
  if (!payload || typeof payload !== "object") return null;
  const type = firstString(payload.type);
  switch (type) {
    case "text":
      return { type: "text_delta", text: String(payload.data || "") };
    case "thought":
      return { type: "reasoning_delta", text: String(payload.data || "") };
    case "tool_call":
      return {
        type: "tool_call",
        id: firstString(payload.toolCallId),
        tool: firstString(payload.toolName, payload.title),
        kind: firstString(payload.kind),
        status: firstString(payload.status),
        input: payload.rawInput,
        locations: Array.isArray(payload.locations) ? payload.locations : [],
      };
    case "tool_call_update":
      return {
        type: "tool_call_update",
        id: firstString(payload.toolCallId),
        status: firstString(payload.status),
        output: payload.rawOutput,
        content: payload.content,
        locations: Array.isArray(payload.locations) ? payload.locations : [],
      };
    case "plan":
      return {
        type: "plan",
        entries: Array.isArray(payload.entries) ? payload.entries : [],
      };
    case "available_commands":
      return {
        type: "commands",
        tools: Array.isArray(payload.tools) ? payload.tools : [],
        commands: Array.isArray(payload.commands) ? payload.commands : [],
      };
    case "usage":
      return {
        type: "usage",
        messageId: firstString(payload.messageId),
        stopReason: firstString(payload.stopReason),
        usage: payload.usage || null,
      };
    case "end":
      return {
        type: "end",
        sessionId: firstString(payload.sessionId),
        requestId: firstString(payload.requestId),
        stopReason: firstString(payload.stopReason),
        usage: payload.usage || null,
        numTurns: numberOrUndefined(payload.num_turns),
        modelUsage: payload.modelUsage || null,
        costUsd: numberOrUndefined(payload.total_cost_usd),
      };
    case "error":
      return {
        type: "error",
        error: firstString(payload.message, payload.error) || "grok runtime error",
      };
    case undefined:
      return { type: "unknown", kind: "missing-type", raw: payload };
    default:
      // The documented list is explicitly non-exhaustive:
      // max_turns_reached, auto_compact_* and future events land here.
      return { type: "notice", kind: type, raw: payload };
  }
}

// ---------------------------------------------------------------------------
// Antigravity CLI -- `agy -p ... --output-format stream-json`
// Schema taken from the official headless docs: one `init`, then any number of
// `step_update`, then exactly one `result`. Behaviour is NOT verified live
// because the published binary cannot execute on this host.
// ---------------------------------------------------------------------------
function parseAntigravityStep(step, conversationId) {
  if (!step || typeof step !== "object") {
    return { type: "unknown", kind: "step_update", raw: step };
  }
  const base = {
    sessionId: firstString(step.conversation_id, conversationId),
    stepIndex: numberOrUndefined(step.step_index),
    state: firstString(step.state),
    durationMs: numberOrUndefined(step.duration_ms),
    usage: step.usage || null,
  };
  const tool = step.tool_info || step.toolInfo || step.tool_call || step.toolCall;
  if (tool && typeof tool === "object") {
    // Field names inside tool_info were not published in the sections we could
    // read, so accept the plausible spellings instead of guessing one.
    const status = firstString(tool.status, step.state);
    const output = tool.output ?? tool.result ?? step.tool_output ?? step.toolOutput;
    const isUpdate = output !== undefined || ["completed", "failed", "error", "cancelled"].includes(status);
    return {
      ...base,
      type: isUpdate ? "tool_call_update" : "tool_call",
      id: firstString(tool.id, tool.call_id, tool.tool_call_id),
      tool: firstString(tool.name, tool.tool, tool.tool_name),
      status,
      input: tool.input ?? tool.args ?? tool.parameters ?? null,
      output: output ?? null,
    };
  }
  const plan = step.plan || step.plan_update || step.planUpdate || step.steps;
  if (Array.isArray(plan)) return { ...base, type: "plan", entries: plan };
  const delta = firstString(step.text_delta, step.textDelta, step.response_delta, step.responseDelta,
    step.output_text, step.outputText);
  if (delta) return { ...base, type: "text_delta", text: delta };
  const thinking = firstString(step.thinking_delta, step.thinkingDelta, step.thought_delta,
    step.thoughtDelta, step.reasoning_delta, step.reasoningDelta, step.thought, step.thinking);
  if (thinking) return { ...base, type: "reasoning_delta", text: thinking };
  return { ...base, type: "notice", kind: "step_update", raw: step };
}

function parseAntigravityEvent(payload) {
  if (!payload || typeof payload !== "object") return null;
  const event = firstString(payload.event, payload.type);
  switch (event) {
    case "init": {
      const init = payload.init || {};
      return {
        type: "init",
        sessionId: firstString(init.conversation_id, init.conversationId),
        cwd: firstString(init.cwd),
        model: firstString(init.model),
        raw: init,
      };
    }
    case "step_update":
      return parseAntigravityStep(
        payload.step_update || payload.stepUpdate || payload.step,
        firstString(payload.conversation_id, payload.conversationId),
      );
    case "plan":
    case "plan_update":
      return {
        type: "plan",
        sessionId: firstString(payload.conversation_id, payload.conversationId),
        entries: payload.plan || payload.steps || payload.entries || [],
      };
    case "result": {
      const result = payload.result || {};
      const status = firstString(result.status);
      const failed = Boolean(result.error) || (status && !["SUCCESS", "COMPLETED", "DONE"].includes(status));
      return {
        type: "result",
        sessionId: firstString(result.conversation_id, result.conversationId),
        status,
        text: firstString(result.response),
        usage: result.usage || null,
        numTurns: numberOrUndefined(result.num_turns),
        durationMs: result.duration_seconds ? Number(result.duration_seconds) * 1000 : undefined,
        error: failed ? firstString(result.error, `antigravity status ${status}`) : undefined,
        structuredOutput: result.structured_output,
      };
    }
    case "error":
      return { type: "error", error: firstString(payload.message, payload.error) || "antigravity runtime error" };
    case undefined:
      return { type: "unknown", kind: "missing-event", raw: payload };
    default:
      return { type: "notice", kind: event, raw: payload };
  }
}

// ---------------------------------------------------------------------------
// Provider error mapping (PHASE D / PHASE H). Turns an HTTP status into a
// stable classification so the backend can react without string matching.
// ---------------------------------------------------------------------------
function classifyProviderStatus(status) {
  const code = Number(status);
  if (code === 401 || code === 403) return { kind: "auth_error", retryable: false, code };
  if (code === 404) return { kind: "not_found", retryable: false, code };
  if (code === 408 || code === 504) return { kind: "timeout", retryable: true, code };
  if (code === 429) return { kind: "rate_limited", retryable: true, code };
  if (code >= 500) return { kind: "provider_error", retryable: true, code };
  if (code >= 400) return { kind: "request_error", retryable: false, code };
  return { kind: "ok", retryable: false, code };
}

function parseNdjsonLines(chunk, parser) {
  const events = [];
  const invalid = [];
  for (const line of String(chunk || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const payload = safeJson(trimmed);
    if (!payload) {
      // Non-JSON stdout on a JSON stream is itself evidence worth surfacing.
      invalid.push(trimmed.slice(0, 300));
      continue;
    }
    const event = parser(payload);
    if (event) events.push(event);
  }
  return { events, invalid };
}

module.exports = {
  safeJson,
  parseGrokEvent,
  parseAntigravityEvent,
  classifyProviderStatus,
  parseNdjsonLines,
};
