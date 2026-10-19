"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { ConversationStore } = require("./sqlite-store");
const { AntigravityAdapter, normalizeEffort } = require("./runtime/antigravity-adapter");
const { GrokBuildAdapter } = require("./runtime/grok-build-adapter");
const { RuntimeLogger } = require("./runtime/runtime-log");
const { collectGitChanges } = require("./git-change-collector");
const { redactHarnessText, sanitizeHarnessContent } = require("./runtime/tool-content");

const DEFAULT_SOCKET = process.env.WITT_WORKER_SOCKET || "/run/witt/worker.sock";
const FALLBACK_SOCKET = "/root/witt-data/worker.sock";
const DEFAULT_STATE_DIR = process.env.WITT_WORKER_STATE_DIR || path.join(
  path.dirname(process.env.DROP_VAULT_DATA_DIR || "/data/drop-vault/files"), "worker-state");

const HARNESS_REASONING = {
  low: "low", medium: "medium", high: "high",
  xhigh: "high", max: "high", ultra: "high",
};

const GROK_PERMISSION_BY_ACCESS = {
  "read-only": "plan",
  "workspace-write": "acceptEdits",
  "danger-full-access": "bypassPermissions",
};

function grokPermissionMode(accessMode) {
  return GROK_PERMISSION_BY_ACCESS[accessMode] || "plan";
}

function serializeGitBaseline(baseline) {
  if (!baseline || typeof baseline !== "object") return baseline;
  return {
    ...baseline,
    preexisting: baseline.preexisting instanceof Map
      ? { kind: "map", entries: [...baseline.preexisting.entries()] }
      : baseline.preexisting instanceof Set
        ? { kind: "set", values: [...baseline.preexisting.values()] }
        : baseline.preexisting,
    preexistingSnapshots: baseline.preexistingSnapshots instanceof Map
      ? { kind: "map", entries: [...baseline.preexistingSnapshots.entries()] }
      : baseline.preexistingSnapshots,
  };
}

function deserializeGitBaseline(baseline) {
  if (!baseline || typeof baseline !== "object") return baseline;
  const preexisting = baseline.preexisting;
  if (preexisting?.kind === "map" && Array.isArray(preexisting.entries)) {
    baseline = { ...baseline, preexisting: new Map(preexisting.entries) };
  } else if (preexisting?.kind === "set" && Array.isArray(preexisting.values)) {
    baseline = { ...baseline, preexisting: new Set(preexisting.values) };
  } else if (Array.isArray(preexisting)) {
    baseline = { ...baseline, preexisting: new Set(preexisting) };
  }
  const snapshots = baseline.preexistingSnapshots;
  if (snapshots?.kind === "map" && Array.isArray(snapshots.entries)) {
    return { ...baseline, preexistingSnapshots: new Map(snapshots.entries) };
  }
  if (Array.isArray(snapshots)) return { ...baseline, preexistingSnapshots: new Map(snapshots) };
  return baseline;
}

function antigravityFailureReason(eventError, result = {}) {
  return redactHarnessText(eventError || result.errorType || "failed", 200);
}

function emptyHarnessResponseReason(harnessName, lastTool, result = {}) {
  const tool = lastTool?.label || "工具调用";
  const toolState = lastTool?.status === "completed" ? "已完成" : "执行状态未确认";
  const processState = result.code === 0
    ? `${harnessName} CLI 进程正常结束`
    : `${harnessName} CLI 进程异常结束`;
  return `${processState}，但在${tool}（${toolState}）后未返回最终回复；请先检查工作区后再决定是否重试。`;
}

function emptyGrokResponseReason(lastTool, result = {}) {
  return emptyHarnessResponseReason("Grok Build", lastTool, result);
}

function settleWithin(promise, timeoutMs) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).then(() => true, () => true),
    new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

class TurnInstance {
  constructor(params, worker) {
    this.worker = worker;
    this.key = `${params.conversationId}:${params.assistantMessageId}`;
    this.conversationId = params.conversationId;
    this.assistantMessageId = params.assistantMessageId;
    this.userMessageId = params.userMessageId;
    this.userId = params.userId;
    this.harnessId = params.harnessId;
    this.model = params.model;
    this.reasoning = params.reasoning || "medium";
    this.accessMode = params.accessMode || "workspace-write";
    this.workDir = params.workDir;
    this.prompt = params.prompt;
    this.attachments = params.attachments || [];
    this.gitBaseline = deserializeGitBaseline(params.gitBaseline || null);
    this.gitBaselineError = params.gitBaselineError || null;
    this.existingSession = params.existingSession || null;
    this.chatDir = params.chatDir;
    this.dataDir = params.dataDir;
    this.harnessOptions = params.harnessOptions || {};
    this.remoteWorkspace = params.remoteWorkspace || this.harnessOptions?.grok?.remoteWorkspace || null;

    this.status = "running"; // running | completed | failed | interrupted
    this.seqCounter = 0;
    this.events = []; // Array of { seq, type, data, at }
    this.subscribers = new Set(); // HTTP responses
    this.pendingApprovals = new Map();
    this.adapter = null;
    this.handle = null;
    this.error = null;
    this.text = "";
    this.lastTool = null;
    this.interruptRequested = false;
    this.startedAt = new Date().toISOString();
    this.completedAt = null;
    this.persistTimer = null;
    this.pendingPersist = false;

    // Direct SQLite store instance for writing
    this.store = worker.getStore(this.chatDir);
  }

  emitEvent(type, data) {
    const seq = this.seqCounter++;
    const payload = { seq, type, data: sanitizeHarnessContent(data), at: new Date().toISOString() };
    this.events.push(payload);
    // Keep max 2000 events in memory
    if (this.events.length > 2000) this.events.shift();
    if (type === "reasoning_delta") this.deferPersist();
    else this.worker.persistTurn(this);

    const chunk = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of this.subscribers) {
      if (!res.destroyed && !res.writableEnded) {
        try {
          res.write(chunk);
        } catch {
          this.subscribers.delete(res);
        }
      } else {
        this.subscribers.delete(res);
      }
    }
  }

  deferPersist() {
    this.pendingPersist = true;
    if (this.persistTimer || this.completedAt) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      if (!this.pendingPersist || this.completedAt) return;
      this.pendingPersist = false;
      this.worker.persistTurn(this);
    }, 150);
    this.persistTimer.unref?.();
  }

  readConversation() {
    return this.store.load(this.conversationId, { forceFresh: true });
  }

  saveConversation(conv) {
    conv.updatedAt = new Date().toISOString();
    const ids = new Set([this.assistantMessageId, this.userMessageId].filter(Boolean));
    const messages = (conv.messages || []).filter((message) => ids.has(message.id));
    const metadata = {};
    for (const key of ["harnessSessionId", "harnessId", "providerId", "remoteWorkspaceStarted"]) {
      if (Object.hasOwn(conv, key)) metadata[key] = conv[key];
    }
    if (typeof this.store.patchMessages !== "function") {
      throw new Error("ConversationStore.patchMessages is required for worker writes");
    }
    this.store.patchMessages(this.conversationId, messages, metadata);
  }

  upsertStream(assistant, id, values) {
    assistant.stream = Array.isArray(assistant.stream) ? assistant.stream : [];
    let entry = assistant.stream.find((item) => item.id === id);
    if (!entry) {
      entry = {
        id,
        kind: values.kind || "activity",
        createdAt: new Date().toISOString(),
        status: "running",
      };
      assistant.stream.push(entry);
    }
    for (const [k, v] of Object.entries(values)) {
      if (v !== undefined && v !== null) entry[k] = v;
    }
    return entry;
  }

  captureApproval(event, assistant) {
    const type = String(event?.type || "");
    if (!/approval|permission_request/i.test(type)) return false;
    const safeEvent = sanitizeHarnessContent(event);
    const adapterRequestId = event.approvalId || event.requestId || event.id || event.raw?.id;
    if (!adapterRequestId) return false;
    const approvalId = String(adapterRequestId);
    this.pendingApprovals.set(approvalId, { adapterRequestId, request: event });
    this.upsertStream(assistant, `approval-${approvalId}`, {
      kind: "approval",
      approvalId,
      status: "pending",
      summary: String(safeEvent.summary || safeEvent.label || "Harness 请求执行需要确认的操作").slice(0, 300),
      details: safeEvent.details || null,
    });
    this.addActivity(assistant, "approval", "等待确认 Harness 操作", "running");
    this.emitEvent("approval", { approvalId, status: "pending", summary: safeEvent.summary || safeEvent.label || "Harness 请求执行需要确认的操作" });
    return true;
  }

  addActivity(assistant, type, label, status = "running") {
    assistant.activity = Array.isArray(assistant.activity) ? assistant.activity : [];
    const current = assistant.activity.at(-1);
    if (current && current.type === type && current.status === status) {
      current.label = label;
      return current;
    }
    const entry = { type, label, status, createdAt: new Date().toISOString() };
    assistant.activity.push(entry);
    return entry;
  }

  trackTool(id, presented) {
    this.lastTool = {
      id,
      label: String(presented?.label || "调用工具").slice(0, 160),
      status: presented?.status || "running",
    };
  }

  emptyFinalResponseFailure(harnessName, result) {
    const reason = emptyHarnessResponseReason(harnessName, this.lastTool, result);
    this.worker.logger.log({
      harness: this.harnessId,
      sessionId: result.sessionId || null,
      model: this.model,
      event: "empty_final_response",
      durationMs: result.durationMs,
      errorType: "empty_final_response",
      detail: {
        lastTool: this.lastTool ? { label: this.lastTool.label, status: this.lastTool.status } : null,
        process: {
          code: result.code,
          signal: result.signal || null,
          invalidLineCount: Array.isArray(result.invalidLines) ? result.invalidLines.length : 0,
        },
      },
    });
    return reason;
  }

  async appendGitChanges(assistant) {
    if (!this.gitBaseline) return;
    try {
      const summary = await collectGitChanges(this.gitBaseline);
      const count = summary.changes.length;
      this.upsertStream(assistant, "turn-git-changes", {
        kind: "file",
        label: count ? `已修改 ${count} 个文件` : "未检测到文件修改",
        status: "completed",
        count,
        branch: summary.branch || null,
        baselineBranch: this.gitBaseline.branch || null,
        branchChanged: summary.branchChanged,
        details: {
          changes: summary.changes,
          omitted: summary.omitted,
          total: summary.total,
          baselineAt: new Date(this.gitBaseline.createdAt).toISOString(),
          branch: summary.branch,
          baselineBranch: this.gitBaseline.branch,
          branchChanged: summary.branchChanged,
          baselineUnavailable: summary.baselineUnavailable,
          baselineDirty: this.gitBaseline.preexisting.size > 0 || summary.baselineUnavailable > 0 ||
            summary.changes.some((change) => change.baselineDirty),
        },
      });
      this.emitEvent("activity", { type: "file", label: `已修改 ${count} 个文件`, status: "completed" });
    } catch {
      // Best effort git change collection
    }
  }

  finish(status, errorReason = "") {
    if (this.completedAt) return; // Already finished
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    this.pendingPersist = false;
    this.status = status;
    this.completedAt = new Date().toISOString();
    if (errorReason) {
      errorReason = redactHarnessText(errorReason, 1000);
      this.error = errorReason;
    }

    const conv = this.readConversation();
    if (conv) {
      const assistant = conv.messages?.find((m) => m.id === this.assistantMessageId);
      if (assistant) {
        delete assistant.workerDispatchPending;
        assistant.status = status;
        assistant.completedAt = this.completedAt;
        if (status === "completed") {
          assistant.text = this.text;
        } else if (status === "interrupted") {
          assistant.text = this.text || "已暂停";
        } else {
          assistant.text = this.text || errorReason || "执行失败";
        }

        // Close pending stream entries
        for (const entry of assistant.stream || []) {
          if (entry.status === "running") entry.status = status;
          if (entry.kind === "approval" && entry.status === "pending") {
            entry.status = status;
            entry.resolutionLabel = status === "interrupted" ? "执行已中断，请检查工作区" : "执行已结束，审批未确认";
          }
        }
        for (const act of assistant.activity || []) {
          if (act.status === "running") act.status = status;
        }
      }
      if (this.userMessageId) {
        const user = conv.messages?.find((m) => m.id === this.userMessageId);
        if (user) {
          user.status = status === "completed" || status === "interrupted" ? "completed" : "failed";
        }
      }
      this.saveConversation(conv);
    }

    this.emitEvent("finish", {
      status,
      text: this.text,
      error: this.error,
      completedAt: this.completedAt,
    });

    // Close all subscriber connections
    for (const res of this.subscribers) {
      try { res.end(); } catch {}
    }
    this.subscribers.clear();
  }

  async interrupt() {
    if (this.status !== "running") return { ok: true, status: this.status };
    this.interruptRequested = true;
    if (this.handle && this.adapter) {
      try {
        await this.adapter.cancel(this.handle);
      } catch {}
      const done = this.handle.done;
      let stopped = !done || await settleWithin(done, 5000);
      const processHandle = this.handle?.process;
      const child = processHandle?.child;
      if (!stopped && processHandle && child?.exitCode === null) {
        try { processHandle.kill("SIGKILL"); } catch {}
        stopped = await settleWithin(done, 2000);
      }
      if (!stopped || (child && child.exitCode === null && !child.signalCode)) {
        return { ok: false, error: "cancel_unconfirmed", message: "Harness 子进程尚未确认退出" };
      }
    }
    if (this.status !== "running") return { ok: true, status: this.status };
    const conv = this.readConversation();
    if (conv) {
      const assistant = conv.messages?.find((m) => m.id === this.assistantMessageId);
      if (assistant) {
        this.addActivity(assistant, "pause", "已暂停当前执行", "completed");
        this.saveConversation(conv);
      }
    }
    this.emitEvent("activity", { type: "pause", label: "已暂停当前执行", status: "completed" });
    this.finish("interrupted", "已暂停");
    return { ok: true, status: "interrupted" };
  }

  async resolveApproval(approvalId, decision, choiceId = null) {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) return { ok: false, error: "approval_not_found" };

    const approvalsSupported = this.adapter?.capabilities?.approvals === true ||
      this.adapter?.getCapabilities?.()?.approvals === true;
    if (!approvalsSupported || typeof this.adapter?.approve !== "function" ||
        typeof this.adapter?.deny !== "function") {
      return { ok: false, error: "approval_unsupported", message: "当前 Harness 不支持交互式审批" };
    }

    const accepted = decision === "accept" || decision === "allow-turn";
    let adapterResult;
    try {
      adapterResult = accepted
        ? await this.adapter.approve(pending.adapterRequestId || approvalId, { choiceId, request: pending.request })
        : await this.adapter.deny(pending.adapterRequestId || approvalId, { choiceId, request: pending.request });
    } catch (error) {
      return { ok: false, error: "approval_failed", message: String(error?.message || error).slice(0, 200) };
    }
    if (!adapterResult || adapterResult.ok !== true) {
      return {
        ok: false,
        error: adapterResult?.reason ? "approval_unsupported" : "approval_failed",
        message: String(adapterResult?.reason || "Harness 未确认审批结果").slice(0, 200),
      };
    }
    this.pendingApprovals.delete(approvalId);

    const conv = this.readConversation();
    if (conv) {
      const assistant = conv.messages?.find((m) => m.id === this.assistantMessageId);
      const entry = assistant?.stream?.find((item) => item.kind === "approval" && item.approvalId === approvalId);
      if (entry) {
        entry.status = accepted ? "accepted" : "declined";
        entry.resolutionLabel = accepted ? "已确认执行" : "已拒绝本步操作";
        entry.resolvedAt = new Date().toISOString();
        this.addActivity(assistant, "approval", entry.resolutionLabel, "completed");
        this.saveConversation(conv);
      }
    }

    this.emitEvent("approval_resolved", {
      approvalId,
      status: accepted ? "accepted" : "declined",
    });

    return { ok: true };
  }

  async run() {
    try {
      if (this.harnessId === "google-antigravity") {
        await this._runAntigravity();
      } else if (this.harnessId === "grok-build") {
        await this._runGrok();
      } else {
        this.finish("failed", `Unsupported harness: ${this.harnessId}`);
      }
    } catch (err) {
      this.finish("failed", `Runtime exception: ${err.message || String(err)}`);
    }
  }

  async _runAntigravity() {
    const options = this.harnessOptions?.antigravity || {};
    const skipPermissions = this.accessMode === "danger-full-access";
    this.adapter = new AntigravityAdapter({
      bin: options.bin,
      model: this.model,
      cwd: this.workDir,
      apiKeyEnv: options.apiKeyEnv || "GEMINI_API_KEY",
      apiKeyValue: options.apiKeyValue || "",
      baseUrl: options.baseUrl || "",
      printTimeoutMs: options.timeoutMs || 300000,
      skipPermissions,
      runAsAdmin: options.runAsAdmin === true && skipPermissions,
      logger: this.worker.logger,
    });

    const conv0 = this.readConversation();
    if (conv0) {
      const assistant0 = conv0.messages?.find((m) => m.id === this.assistantMessageId);
      if (assistant0) {
        this.addActivity(assistant0, "thinking", "Gemini 正在准备与分析...", "running");
        this.saveConversation(conv0);
      }
    }

    try {
      await this.adapter.startRuntime();
    } catch (err) {
      this.finish("failed", `Failed to start Google Antigravity: ${String(err.message || err).slice(0, 200)}`);
      return;
    }

    if (this.interruptRequested) {
      this.finish("interrupted", "已暂停");
      return;
    }

    const handle = this.adapter.sendPrompt({
      prompt: this.prompt,
      model: this.model,
      cwd: this.workDir,
      effort: normalizeEffort(this.reasoning || "medium"),
      skipPermissions,
      ...(this.existingSession ? { conversationId: this.existingSession } : {}),
    });
    this.handle = handle;

    handle.events.on("event", (event) => {
      if (this.completedAt) return;
      const conv = this.readConversation();
      if (!conv) return;
      const assistant = conv.messages?.find((m) => m.id === this.assistantMessageId);
      if (!assistant) return;
      if (this.captureApproval(event, assistant)) {
        this.saveConversation(conv);
        return;
      }

      const discoveredSessionId = event.sessionId || event.raw?.sessionId;
      if (discoveredSessionId) {
        conv.harnessSessionId = String(discoveredSessionId);
        conv.harnessId = "google-antigravity";
        conv.providerId = "google-antigravity";
        if (this.remoteWorkspace) conv.remoteWorkspaceStarted = true;
      }

      if (event.type === "text_delta") {
        const thinkingEntry = assistant.stream?.find((e) => e.id === "harness-thinking");
        if (thinkingEntry && thinkingEntry.status === "running") {
          thinkingEntry.status = "completed";
          thinkingEntry.label = "思考完成";
          this.addActivity(assistant, "thinking", "思考完成", "completed");
        }
        const entry = this.upsertStream(assistant, "harness-message",
          { kind: "message", phase: "final_answer", status: "running" });
        const safeText = redactHarnessText(event.text || "", 20000);
        entry.text = `${entry.text || ""}${safeText}`;
        this.emitEvent("text_delta", { text: safeText });
      } else if (event.type === "reasoning_delta") {
        const text = String(event.text || "");
        if (text) {
          const entry = this.upsertStream(assistant, "harness-thinking", {
            kind: "thought",
            label: "思考过程",
            status: "running",
            hasDetails: true,
            details: { thought: "", output: "" },
          });
          const safeDelta = redactHarnessText(text, 20000);
          const current = entry.details?.thought || entry.text || "";
          const next = `${current}${safeDelta}`;
          entry.details = { ...(entry.details || {}), thought: next, output: next };
          entry.text = next;
          const snippet = next.trim().split(/\r?\n/).filter(Boolean).at(-1) || "正在思考...";
          entry.label = `思考：${snippet.slice(0, 48)}`;
          this.addActivity(assistant, "thinking", entry.label, "running");
          this.emitEvent("reasoning_delta", { text: safeDelta });
        }
      } else if (event.type === "plan") {
        const entries = Array.isArray(event.entries) ? sanitizeHarnessContent(event.entries) : [];
        const plan = this.upsertStream(assistant, "harness-plan", {
          kind: "plan", label: "执行计划", status: "running", hasDetails: true,
          details: { entries },
        });
        plan.details = { ...(plan.details || {}), entries };
        plan.label = entries.length ? `执行计划 · ${entries.length} 步` : "执行计划";
        this.addActivity(assistant, "plan", plan.label, "running");
        this.emitEvent("plan", { entries });
      } else if (event.type === "tool_call") {
        const presented = this.adapter.formatToolCall(event, this.workDir);
        const safePresented = sanitizeHarnessContent(presented);
        this.addActivity(assistant, safePresented.kind, safePresented.label, "running");
        const callId = event.id || `tool-${event.stepIndex || Date.now()}`;
        this.trackTool(callId, safePresented);
        this.upsertStream(assistant, callId, safePresented);
        this.emitEvent("tool_call", safePresented);
        if (event.output !== undefined || ["completed", "failed", "error", "cancelled"].includes(event.status)) {
          const patch = this.adapter.formatToolUpdate(event, safePresented);
          this.upsertStream(assistant, callId, patch);
          this.trackTool(callId, { ...safePresented, ...patch });
          if (patch.status === "completed") {
            this.addActivity(assistant, safePresented.kind, `${safePresented.label} (已完成)`, "completed");
          }
        }
      } else if (event.type === "tool_call_update") {
        const callId = event.id || `tool-${event.stepIndex || Date.now()}`;
        const existing = assistant.stream?.find((entry) => entry.id === callId) || {
          kind: "tool", label: `调用工具：${event.tool || "工具调用"}`, details: {},
        };
        const patch = this.adapter.formatToolUpdate(event, existing);
        this.upsertStream(assistant, callId, patch);
        this.trackTool(callId, { ...existing, ...patch });
        this.addActivity(assistant, patch.kind || "tool", patch.status === "completed"
          ? `${existing.label}（已完成）` : `${existing.label}（${patch.status === "failed" ? "失败" : "执行中"}）`,
        patch.status);
        this.emitEvent("tool_call_update", { id: callId, ...patch });
      } else if (event.type === "result") {
        const thinkingEntry = assistant.stream?.find((e) => e.id === "harness-thinking");
        if (thinkingEntry && thinkingEntry.status === "running") {
          thinkingEntry.status = "completed";
          thinkingEntry.label = "思考完成";
        }
        if (event.text) {
          const entry = this.upsertStream(assistant, "harness-message",
            { kind: "message", phase: "final_answer", status: "running" });
          entry.text = redactHarnessText(event.text, 20000);
        }
        if (event.error) {
          this.error = redactHarnessText(event.error, 300);
          this.addActivity(assistant, "error", `Gemini：${this.error}`, "failed");
          this.emitEvent("error", { error: this.error });
        }
      } else if (event.type === "error") {
        this.error = redactHarnessText(event.error || "运行失败", 200);
        this.addActivity(assistant, "error", "Antigravity 返回错误事件", "failed");
        this.emitEvent("error", { error: this.error });
      }

      this.saveConversation(conv);
    });

    const result = await handle.done;
    if (this.completedAt) return;

    const conv = this.readConversation();
    const assistant = conv?.messages?.find((m) => m.id === this.assistantMessageId);
    this.text = redactHarnessText((assistant?.stream || [])
      .filter((e) => e.kind === "message")
      .map((e) => e.text || "").join("").trim() || (result.text || "").trim(), 20000);

    if (result.sessionId && conv) {
      conv.harnessSessionId = result.sessionId;
      conv.harnessId = "google-antigravity";
      conv.providerId = "google-antigravity";
      if (this.remoteWorkspace) conv.remoteWorkspaceStarted = true;
      this.saveConversation(conv);
    }

    if (assistant) {
      await this.appendGitChanges(assistant);
    }

    if (result.timedOut) {
      this.finish("failed", "Google Antigravity 运行超时");
      return;
    }
    if (this.interruptRequested) {
      this.finish("interrupted", "已暂停");
      return;
    }
    if (!result.ok || this.error) {
      const reason = antigravityFailureReason(this.error, result);
      this.finish("failed", `Google Antigravity ${reason}`);
      return;
    }
    if (!this.text) {
      this.finish("failed", this.emptyFinalResponseFailure("Google Antigravity", result));
      return;
    }

    this.finish("completed");
  }

  async _runGrok() {
    const options = this.harnessOptions?.grok || {};
    this.adapter = new GrokBuildAdapter({
      bin: options.bin,
      model: this.model,
      cwd: this.workDir,
      envKey: options.envKey || "WITT_CPA_KEY",
      envValue: options.envValue || "",
      remoteDeviceMcpEnabled: options.remoteDeviceMcpEnabled === true,
      remoteDeviceTokenFile: options.remoteDeviceTokenFile || "",
      remoteWorkspace: this.remoteWorkspace,
      browserMcpEnabled: options.browserMcpEnabled === true,
      permissionMode: options.permissionMode || grokPermissionMode(this.accessMode),
      reasoningEffort: options.reasoningEffort || null,
      timeoutMs: options.timeoutMs,
      logger: this.worker.logger,
    });

    try {
      await this.adapter.startRuntime();
    } catch (err) {
      this.finish("failed", `无法启动 Grok Build: ${String(err.message || err).slice(0, 200)}`);
      return;
    }

    if (this.interruptRequested) {
      this.finish("interrupted", "已暂停");
      return;
    }

    const handle = this.adapter.sendPrompt({
      prompt: this.prompt,
      model: this.model,
      cwd: this.workDir,
      reasoningEffort: HARNESS_REASONING[this.reasoning] || "medium",
      ...(this.existingSession ? { resumeSessionId: this.existingSession } : {
        sessionId: crypto.randomUUID(),
      }),
    });
    this.handle = handle;

    handle.events.on("event", (event) => {
      if (this.completedAt) return;
      const conv = this.readConversation();
      if (!conv) return;
      const assistant = conv.messages?.find((m) => m.id === this.assistantMessageId);
      if (!assistant) return;
      if (this.captureApproval(event, assistant)) {
        this.saveConversation(conv);
        return;
      }

      const discoveredSessionId = event.sessionId || event.raw?.sessionId;
      if (discoveredSessionId) {
        conv.harnessSessionId = String(discoveredSessionId);
        conv.harnessId = "grok-build";
        conv.providerId = "cpa";
        if (this.remoteWorkspace) conv.remoteWorkspaceStarted = true;
      }

      if (event.type === "text_delta") {
        const entry = this.upsertStream(assistant, "harness-message",
          { kind: "message", phase: "final_answer", status: "running" });
        const safeText = redactHarnessText(event.text || "", 20000);
        entry.text = `${entry.text || ""}${safeText}`;
        this.emitEvent("text_delta", { text: safeText });
      } else if (event.type === "reasoning_delta") {
        this.addActivity(assistant, "thinking", "正在推理", "running");
        this.emitEvent("reasoning_delta", { text: event.text || "" });
      } else if (event.type === "tool_call") {
        const presented = this.adapter.formatToolCall(event, this.workDir);
        const safePresented = sanitizeHarnessContent(presented);
        const callId = event.id || `tool-${Date.now()}`;
        this.trackTool(callId, safePresented);
        this.addActivity(assistant, safePresented.kind, safePresented.label, "running");
        this.upsertStream(assistant, callId, safePresented);
        this.emitEvent("tool_call", safePresented);
      } else if (event.type === "tool_call_update") {
        const callId = event.id || this.lastTool?.id || `tool-${Date.now()}`;
        const existing = assistant.stream?.find((entry) => entry.id === callId) || {
          kind: "tool", label: "调用工具：Grok Build", details: {},
        };
        const patch = this.adapter.formatToolUpdate(event, existing);
        this.upsertStream(assistant, callId, patch);
        this.trackTool(callId, { ...existing, ...patch });
        this.addActivity(assistant, patch.kind || "tool", patch.status === "completed"
          ? `${existing.label}（已完成）` : `${existing.label}（${patch.status === "failed" ? "失败" : "执行中"}）`,
        patch.status);
        this.emitEvent("tool_call_update", { id: callId, ...patch });
      } else if (event.type === "error") {
        this.error = redactHarnessText(event.error || "运行失败", 200);
        this.addActivity(assistant, "error", "Grok Build 返回错误事件", "failed");
        this.emitEvent("error", { error: this.error });
      }

      this.saveConversation(conv);
    });

    const result = await handle.done;
    if (this.completedAt) return;

    const conv = this.readConversation();
    const assistant = conv?.messages?.find((m) => m.id === this.assistantMessageId);
    this.text = redactHarnessText((assistant?.stream || [])
      .filter((e) => e.kind === "message")
      .map((e) => e.text || "").join("").trim() || (result.text || "").trim(), 20000);

    if (result.sessionId && conv) {
      conv.harnessSessionId = result.sessionId;
      conv.harnessId = "grok-build";
      conv.providerId = "cpa";
      if (this.remoteWorkspace) conv.remoteWorkspaceStarted = true;
      this.saveConversation(conv);
    }

    if (assistant) {
      await this.appendGitChanges(assistant);
    }

    if (result.timedOut) {
      this.finish("failed", "Grok Build 运行超时");
      return;
    }
    if (this.interruptRequested) {
      this.finish("interrupted", "已暂停");
      return;
    }
    if (!result.ok || this.error) {
      this.finish("failed", `Grok Build ${result.errorType || this.error || "failed"}`);
      return;
    }
    if (!this.text) {
      this.finish("failed", this.emptyFinalResponseFailure("Grok Build", result));
      return;
    }

    this.finish("completed");
  }
}

class WorkerService {
  constructor(options = {}) {
    this.socketPath = options.socketPath || DEFAULT_SOCKET;
    this.stateDir = options.stateDir || DEFAULT_STATE_DIR;
    this.turnStateDir = path.join(this.stateDir, "turns");
    this.logger = options.logger || new RuntimeLogger({ enabled: false });
    this.activeTurns = new Map(); // key -> TurnInstance
    this.stores = new Map(); // chatDir -> ConversationStore
    this.draining = false;
    this.shutdownRequested = false;
    this.server = null;
  }

  turnStatePath(key) {
    const name = crypto.createHash("sha256").update(key).digest("hex");
    return path.join(this.turnStateDir, `${name}.json`);
  }

  persistTurn(turn) {
    fs.mkdirSync(this.turnStateDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(this.stateDir, 0o700); } catch {}
    try { fs.chmodSync(this.turnStateDir, 0o700); } catch {}
    const record = {
      version: 1,
      key: turn.key,
      conversationId: turn.conversationId,
      assistantMessageId: turn.assistantMessageId,
      userMessageId: turn.userMessageId,
      userId: turn.userId,
      harnessId: turn.harnessId,
      status: turn.status,
      seqCounter: turn.seqCounter,
      events: turn.events,
      text: turn.text,
      error: turn.error,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
      chatDir: turn.chatDir,
      dataDir: turn.dataDir,
    };
    const file = this.turnStatePath(turn.key);
    const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(temp, file);
    try { fs.chmodSync(file, 0o600); } catch {}
  }

  loadPersistedTurns() {
    fs.mkdirSync(this.turnStateDir, { recursive: true, mode: 0o700 });
    let names = [];
    try { names = fs.readdirSync(this.turnStateDir).filter((name) => name.endsWith(".json")); } catch {}
    for (const name of names) {
      let record;
      try { record = JSON.parse(fs.readFileSync(path.join(this.turnStateDir, name), "utf8")); }
      catch { continue; }
      if (!record?.key || !record.conversationId || !record.assistantMessageId || !record.chatDir) continue;
      const turn = new TurnInstance({
        conversationId: record.conversationId,
        assistantMessageId: record.assistantMessageId,
        userMessageId: record.userMessageId,
        userId: record.userId,
        harnessId: record.harnessId,
        chatDir: record.chatDir,
        dataDir: record.dataDir,
        gitBaseline: null,
        remoteWorkspace: record.remoteWorkspace,
      }, this);
      turn.key = record.key;
      turn.status = record.status || "interrupted";
      turn.seqCounter = Number.isInteger(record.seqCounter) ? record.seqCounter : 0;
      turn.events = Array.isArray(record.events) ? record.events.slice(-2000) : [];
      turn.text = typeof record.text === "string" ? record.text : "";
      turn.error = typeof record.error === "string" ? record.error : null;
      turn.startedAt = record.startedAt || turn.startedAt;
      turn.completedAt = record.completedAt || null;
      this.activeTurns.set(turn.key, turn);
      if (turn.status === "running") {
        turn.finish("interrupted", "Worker 重启时任务中断；请检查工作区后再决定是否重试");
      }
    }
  }

  getStore(chatDir) {
    if (!this.stores.has(chatDir)) {
      this.stores.set(chatDir, new ConversationStore(chatDir));
    }
    return this.stores.get(chatDir);
  }

  start() {
    return new Promise((resolve, reject) => {
      this.loadPersistedTurns();
      // Ensure directory for socket exists
      const socketDir = path.dirname(this.socketPath);
      try {
        if (!fs.existsSync(socketDir)) {
          fs.mkdirSync(socketDir, { recursive: true, mode: 0o755 });
        }
      } catch (err) {
        // Fallback to FALLBACK_SOCKET if /run/witt is not writable
        console.warn(`Could not create ${socketDir}, falling back to ${FALLBACK_SOCKET}`);
        this.socketPath = FALLBACK_SOCKET;
        fs.mkdirSync(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
      }

      // Remove stale socket
      try {
        if (fs.existsSync(this.socketPath)) {
          fs.unlinkSync(this.socketPath);
        }
      } catch {}

      this.server = http.createServer((req, res) => this.handleRequest(req, res));
      this.server.on("error", reject);

      this.server.listen(this.socketPath, () => {
        try {
          fs.chmodSync(this.socketPath, 0o700);
        } catch {}
        console.log(`[WorkerService] Listening on ${this.socketPath}`);
        resolve();
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          try {
            if (fs.existsSync(this.socketPath)) fs.unlinkSync(this.socketPath);
          } catch {}
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  handleRequest(req, res) {
    const url = new URL(req.url, "http://localhost");

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        activeCount: [...this.activeTurns.values()].filter((t) => t.status === "running").length,
        draining: this.draining,
      }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/admin/status") {
      const runningCount = [...this.activeTurns.values()].filter((t) => t.status === "running").length;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, draining: this.draining, runningCount, activeCount: runningCount }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin/drain") {
      this.draining = true;
      const runningCount = [...this.activeTurns.values()].filter((t) => t.status === "running").length;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, draining: true, runningCount }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin/resume") {
      this.draining = false;
      const runningCount = [...this.activeTurns.values()].filter((t) => t.status === "running").length;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, draining: false, runningCount }));
      return;
    }

    // Match /turns/:conversationId/:messageId/...
    const turnMatch = url.pathname.match(/^\/turns\/([a-f0-9-]{36})\/([a-f0-9-]{36})(?:\/(status|events|interrupt|approvals\/([a-f0-9-]{36})))?$/);
    if (turnMatch) {
      const convId = turnMatch[1];
      const msgId = turnMatch[2];
      const action = turnMatch[3];
      const approvalId = turnMatch[4];
      const key = `${convId}:${msgId}`;
      const turn = this.activeTurns.get(key);

      if (req.method === "GET" && action === "status") {
        if (!turn) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "not_found" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          status: turn.status,
          seq: turn.seqCounter,
          text: turn.text,
          error: turn.error,
          startedAt: turn.startedAt,
          completedAt: turn.completedAt,
          pendingApprovals: [...turn.pendingApprovals.keys()],
        }));
        return;
      }

      if (req.method === "GET" && action === "events") {
        if (!turn) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "not_found" }));
          return;
        }

        const fromSeq = parseInt(url.searchParams.get("fromSeq") || "0", 10);
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no",
        });

        // 1. Replay buffered events from fromSeq
        for (const ev of turn.events) {
          if (ev.seq >= fromSeq) {
            res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
          }
        }

        // 2. If already finished, end stream
        if (turn.status !== "running") {
          res.end();
          return;
        }

        // 3. Otherwise add to subscribers for real-time pushing
        turn.subscribers.add(res);
        req.on("close", () => turn.subscribers.delete(res));
        return;
      }

      if (req.method === "POST" && action === "interrupt") {
        if (!turn) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "not_found" }));
          return;
        }
        turn.interrupt().then((result) => {
          res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        }).catch((error) => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String(error?.message || error) }));
        });
        return;
      }

      if (req.method === "POST" && approvalId) {
        if (!turn) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "not_found" }));
          return;
        }
        let bodyRaw = "";
        req.setEncoding("utf8");
        req.on("data", (chunk) => bodyRaw += chunk);
        req.on("end", () => {
          let body = {};
          try { body = JSON.parse(bodyRaw); } catch {}
          Promise.resolve(turn.resolveApproval(approvalId, body.decision, body.choiceId)).then((result) => {
            res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json" });
            res.end(JSON.stringify(result));
          }).catch((error) => {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: String(error?.message || error) }));
          });
        });
        return;
      }
    }

    if (req.method === "POST" && url.pathname === "/turns/start") {
      if (this.draining) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Worker is draining" }));
        return;
      }

      let bodyRaw = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => bodyRaw += chunk);
      req.on("end", () => {
        let params = null;
        try { params = JSON.parse(bodyRaw); } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "invalid_json" }));
          return;
        }

        const validId = (value) => typeof value === "string" &&
          /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
        const safeLocalPath = (value) => typeof value === "string" && path.isAbsolute(value) &&
          !/^[a-z][a-z0-9+.-]*:\/\//i.test(value) &&
          !value.split(/[\\/]+/).includes("..");
        if (!validId(params?.conversationId) || !validId(params?.assistantMessageId) ||
            !validId(params?.userMessageId) || !safeLocalPath(params?.chatDir) ||
            (params?.dataDir && !safeLocalPath(params.dataDir))) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "invalid_turn_metadata" }));
          return;
        }

        const key = `${params.conversationId}:${params.assistantMessageId}`;
        let existing = this.activeTurns.get(key);
        if (existing) {
          // A turn key is immutable: retries return the known state and never replay a command.
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, turnId: key, status: existing.status, seq: existing.seqCounter }));
          return;
        }

        const turn = new TurnInstance(params, this);
        this.activeTurns.set(key, turn);
        this.persistTurn(turn);

        // Run turn in background
        setImmediate(() => {
          turn.run().finally(() => {
            if (this.draining) {
              const remaining = [...this.activeTurns.values()].filter((t) => t.status === "running").length;
              if (remaining === 0 && this.shutdownRequested) {
                console.log("[WorkerService] Shutdown drain complete.");
                this.stop().then(() => process.exit(0));
              }
            }
          });
        });

        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, turnId: key, status: "running" }));
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "not_found" }));
  }
}

if (require.main === module) {
  const service = new WorkerService();
  service.start().then(() => {
    console.log("[WorkerService] AI Execution Worker started successfully.");
  }).catch((err) => {
    console.error("[WorkerService] Fatal error starting worker:", err);
    process.exit(1);
  });

  const handleShutdown = (signal) => {
    console.log(`[WorkerService] Received ${signal}. Initiating graceful drain...`);
    service.draining = true;
    service.shutdownRequested = true;
    const running = [...service.activeTurns.values()].filter((t) => t.status === "running").length;
    if (running === 0) {
      service.stop().then(() => process.exit(0));
    } else {
      console.log(`[WorkerService] Waiting for ${running} active turns to finish...`);
    }
  };

  process.on("SIGINT", () => handleShutdown("SIGINT"));
  process.on("SIGTERM", () => handleShutdown("SIGTERM"));
  process.on("SIGUSR1", () => handleShutdown("SIGUSR1"));
}

module.exports = {
  WorkerService,
  TurnInstance,
  antigravityFailureReason,
  emptyHarnessResponseReason,
  emptyGrokResponseReason,
  serializeGitBaseline,
  deserializeGitBaseline,
};
