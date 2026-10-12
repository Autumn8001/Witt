"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { AppServerClient, sharedAppServer } = require("./app-server-client");
const { ConversationStore } = require("./sqlite-store");
const { workspaceOverview } = require("./workspace-overview");
const { resolveHarness, harnessChanged, HARNESSES } = require("./runtime/runtime-resolver");
const { GrokBuildAdapter } = require("./runtime/grok-build-adapter");
const { AntigravityAdapter, normalizeEffort } = require("./runtime/antigravity-adapter");
const { describeBinary } = require("./runtime/runtime-binaries");
const { RuntimeLogger } = require("./runtime/runtime-log");
const { createGitChangeBaseline, collectGitChanges } = require("./git-change-collector");
const { SUB2API_CODEX_MODELS, createSub2ApiRoute } = require("./sub2api-routing");

const ID_PATTERN = /^[a-f0-9-]{36}$/;
const DEEPSEEK_MODELS = new Set(["deepseek-v4-pro", "deepseek-v4-flash"]);
const DEFAULT_HARNESS_MODEL = "grok-4.7-high";
const DEFAULT_PROVIDER_ID = "cpa";

// --- Model catalogs ---------------------------------------------------------
// SELECTABLE: models a caller may choose for a NEW session or through PATCH.
// Gemini 3.8 is enabled through the explicitly provisioned Antigravity runtime.
// Other paused runtimes remain unavailable, even to unrestricted administrators.
const SELECTABLE_HARNESS_MODELS = new Set(["grok-4.7-high", "gemini-3.8-flash-high"]);
// Runtimes that are paused (Gemini): selecting one is refused with this reason.
const PAUSED_RUNTIME_REASON = "blocked_runtime_incompatible";
const PAUSED_RUNTIME_MODELS = new Set([
  "gemini-3.7-flash-high", "gemini-3.6-flash-high",
  "gemini-3.1-flash-lite",
]);
// Harness models that were never verified end-to-end. They must never be silently
// substituted with a verified sibling (medium/max/xhigh must not become high).
const RETIRED_MODEL_REASON = "retired_model_unverified";
const RETIRED_UNVERIFIED_MODELS = new Set([
  "grok-4.7-medium", "grok-4.7-max", "grok-4.7-xhigh",
]);
// LEGACY_KNOWN: recognised only so an existing historical binding is still
// displayed and preserved verbatim. Never offered and never selectable.
const LEGACY_KNOWN_MODELS = new Set([...PAUSED_RUNTIME_MODELS, ...RETIRED_UNVERIFIED_MODELS]);
const BLOCK_REASON_CODES = new Set([PAUSED_RUNTIME_REASON, RETIRED_MODEL_REASON]);

const ADMIN_MODELS = new Set([
  "gpt-6-astra", "gpt-6-sol", "gpt-6.1-sol", "gpt-6-luna",
  "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", ...DEEPSEEK_MODELS,
  ...SELECTABLE_HARNESS_MODELS,
]);
const NON_ADMIN_MODELS = new Set(["gpt-5.5", ...DEEPSEEK_MODELS, ...SELECTABLE_HARNESS_MODELS]);
const SELECTABLE_MODELS = new Set([...ADMIN_MODELS, ...NON_ADMIN_MODELS]);
// Kept for display/validation of stored bindings only.
const ALL_MODELS = new Set([...SELECTABLE_MODELS, ...LEGACY_KNOWN_MODELS]);

// Explicit provider mapping. Only Grok maps to CPA; an unknown model must never
// fall back to a gateway it does not belong to.
function providerForModel(model) {
  const id = String(model || "");
  if (id.startsWith("grok-")) return DEFAULT_PROVIDER_ID;
  if (id.startsWith("gemini-")) return "sub2api";
  if (DEEPSEEK_MODELS.has(id)) return "deepseek";
  if (id.startsWith("gpt-")) return "codex";
  return null;
}
// Witt reasoning levels mapped onto the levels the harnesses accept.
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

// The capability endpoint is reachable by any authenticated device, so a harness
// failure must surface as a short code. Raw messages can contain executable
// paths, command arguments and other host detail, so they are never forwarded.
const CODEX_REASON_CODES = new Set([
  "executable_not_found", "startup_timeout", "process_exited", "authentication_required", "unavailable",
]);

function codexUnavailableReason(error) {
  const text = String(error?.message || "");
  if (/ENOENT|not found|spawn/i.test(text)) return "executable_not_found";
  if (/timed out|timeout/i.test(text)) return "startup_timeout";
  if (/stopped|closed|exited/i.test(text)) return "process_exited";
  return "unavailable";
}
const QUOTA_EXHAUSTED_MESSAGE = "Your quota has been exhausted. Please try again later.";
const ALLOWED_REASONING = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);
const ALLOWED_ACCESS = new Set(["read-only", "workspace-write", "danger-full-access"]);
const MAX_ARTIFACT_BYTES = 500 * 1024 * 1024;
const MAX_INLINE_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_INLINE_PREVIEW_BYTES = 5 * 1024 * 1024;
const ARTIFACT_PREVIEW_TTL_MS = 15 * 60 * 1000;
const IMAGE_ID_PATTERN = /^[a-f0-9-]{36}$/;
const artifactPreviewTokens = new Map();

// Working directories Witt may open a project in. Upstream hardcoded this list,
// which made the configured DROP_VAULT_CODEX_WORKDIR unusable on any host whose
// project directory lives elsewhere. The operator's configured work dir and any
// extra roots are now honoured, while the constraint itself is preserved.
const DEFAULT_WORKDIR_ROOTS = ["/home/ubuntu", "/data/drop-vault", "/data/xuanyu-build-console"];

function normalizeRootList(values) {
  const roots = [];
  for (const value of values) {
    const text = String(value || "").trim();
    if (!text || !path.isAbsolute(text)) continue;
    const lexical = path.resolve(text);
    roots.push(lexical);
    try {
      roots.push(fs.realpathSync(lexical));
    } catch {
      // A configured root that does not exist yet still counts lexically.
    }
  }
  return [...new Set(roots)];
}

function buildWorkDirRoots(options = {}, codexWorkDir) {
  const configured = Array.isArray(options.workDirRoots) ? options.workDirRoots : [];
  // Comma or semicolon separated, so a Windows-style path is never split on ":".
  const fromEnv = String(process.env.WITT_WORKDIR_ROOTS || "")
    .split(/[;,]/).map((item) => item.trim()).filter(Boolean);
  return normalizeRootList([
    ...DEFAULT_WORKDIR_ROOTS,
    codexWorkDir,
    ...configured,
    ...fromEnv,
  ]);
}

function isWithinRoots(candidates, roots) {
  // path.relative is separator-native, so this behaves correctly on Linux and
  // Windows, and it rejects the prefix trap: relative("/home/ubuntu",
  // "/home/ubuntu-evil") is "../ubuntu-evil", which escapes the root.
  return candidates.some((candidate) =>
    roots.some((root) => {
      const relative = path.relative(root, candidate);
      if (relative === "") return true;
      if (path.isAbsolute(relative)) return false;
      return relative !== ".." && !relative.startsWith(`..${path.sep}`);
    }));
}

function servePublicArtifactPreview(res, token) {
  const entry = artifactPreviewTokens.get(String(token || ""));
  if (!entry || entry.expiresAt <= Date.now()) {
    if (entry) artifactPreviewTokens.delete(String(token));
    return false;
  }
  return entry.service.previewArtifactForToken(res, entry);
}

function servePublicArtifactSource(res, token) {
  const entry = artifactPreviewTokens.get(String(token || ""));
  if (!entry || entry.expiresAt <= Date.now()) {
    if (entry) artifactPreviewTokens.delete(String(token));
    return false;
  }
  return entry.service.sourceArtifactForToken(res, entry);
}

class ChatService {
  constructor(options) {
    this.chatDir = options.chatDir;
    this.dataDir = options.dataDir;
    this.codexBin = options.codexBin;
    this.codexWorkDir = options.codexWorkDir;
    this.workDirRoots = buildWorkDirRoots(options, this.codexWorkDir);
    this.deepseekEnabled = options.deepseekEnabled !== false;
    this.sendJson = options.sendJson;
    this.readJsonBody = options.readJsonBody;
    this.allowedModels = Object.hasOwn(options, "allowedModels")
      ? options.allowedModels : ADMIN_MODELS;
    this.defaultModel = options.defaultModel || DEFAULT_HARNESS_MODEL;
    this.defaultProviderId = options.defaultProviderId || DEFAULT_PROVIDER_ID;
    this.sub2api = options.sub2api || null;
    this.quotaExhausted = Boolean(options.quotaExhausted);
    this.codexProfiles = options.codexProfiles || {
      default: {
        id: "default",
        label: "Chloe 默认账号",
        codexHome: "/home/ubuntu/.codex",
        workDir: this.codexWorkDir,
      },
    };
    this.allowedCodexProfiles = new Set(
      (options.allowedCodexProfiles || Object.keys(this.codexProfiles))
        .filter((profile) => this.codexProfiles[profile]));
    if (!this.allowedCodexProfiles.size) this.allowedCodexProfiles.add("default");
    this.defaultCodexProfile = [...this.allowedCodexProfiles][0];
    // Non-Codex harness wiring. Secrets arrive here from the server, never from
    // the repository, and are handed to the adapter as a child-process env value.
    this.harnessOptions = options.harnessOptions || {};
    // Present only for Remote Vibecoding Workspace conversations. The service
    // owns immutable device/root bindings and per-turn MCP credentials; this
    // ChatService never receives a customer filesystem path.
    this.remoteWorkspaceService = options.remoteWorkspaceService || null;
    this.runtimeLogger = options.runtimeLogger
      || new RuntimeLogger({ enabled: Boolean(process.env.WITT_RUNTIME_LOG) });
    // Keep app-server notifications scoped to this user's ChatService. Multiple users may use
    // the same Codex profile, but their active turns must never share an EventEmitter.
    this.clientScope = options.clientScope || crypto.randomUUID();
    this.imageDir = options.imageDir || path.join(path.dirname(this.chatDir), "chat-images");
    this.previewDir = path.join(this.dataDir, ".witt-previews");
    this.deliveryRoots = (options.deliveryRoots || [
      this.dataDir,
      this.codexWorkDir,
      "/home/ubuntu/Documents",
      "/data/builds",
      "/data/xuanyu-build-console",
    ]).flatMap((root) => {
      try { return [fs.realpathSync(root)]; } catch { return []; }
    });
    this.active = null;
    this.lastUsageConversationId = null;
    this.usageCache = new Map();
    this.capabilityCache = new Map();
    this.boundClients = new WeakSet();
    this.availableModels = new Map();
    fs.mkdirSync(this.chatDir, { recursive: true });
    fs.mkdirSync(this.imageDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.previewDir, { recursive: true, mode: 0o700 });
    this.store = new ConversationStore(this.chatDir);
    this.store.importJsonFiles();
    this.jsonCheckpoints = new Map();
    this.eventSubscribers = new Map();
    this.eventBroadcasts = new Map();
    this.workerClient = options.workerClient || null;
    this.ownerUserId = options.ownerUserId || "legacy";
    this.recovery = this.recover().catch((error) => {
      console.error("Chat recovery failed:", error.message);
    });
  }

  clientFor(profile, model = this.defaultModel) {
    const deepseek = DEEPSEEK_MODELS.has(model);
    const configOverrides = ["features.default_mode_request_user_input=true"];
    let route = null;
    if (this.sub2api && String(model).startsWith("gpt-")) {
      route = createSub2ApiRoute({ model, sub2api: this.sub2api });
      configOverrides.push(...route.configOverrides);
    }
    if (deepseek) configOverrides.push(
      'model_provider="witt-deepseek"',
      'model_providers.witt-deepseek.name="DeepSeek through Witt"',
      'model_providers.witt-deepseek.base_url="http://127.0.0.1:33111/v1"',
      'model_providers.witt-deepseek.wire_api="responses"',
      "model_providers.witt-deepseek.request_max_retries=1",
      "model_providers.witt-deepseek.stream_max_retries=2",
      "model_providers.witt-deepseek.stream_idle_timeout_ms=300000",
    );
    const client = sharedAppServer({
      codexBin: this.codexBin,
      cwd: profile.workDir,
      home: "/home/ubuntu",
      codexHome: route?.codexHome || profile.codexHome,
      configOverrides,
      ...(route ? {
        envOverrides: route.envOverrides,
        cacheIdentity: route.cacheIdentity,
      } : {}),
      clientScope: this.clientScope,
    });
    if (!this.boundClients.has(client)) {
      this.boundClients.add(client);
      client.on("notification", (method, params) => {
        const active = this.active;
        if (!active || active.client !== client) return;
        this.handleNotification(active.conversationId, active.messageId, method, params);
      });
      client.on("request", (request) => {
        const active = this.active;
        if (!active || active.client !== client) {
          try { client.respond(request.id, { decision: "decline" }); } catch {}
          return;
        }
        this.handleServerRequest(active.conversationId, active.messageId, request);
      });
      client.on("closed", ({ stderr }) => {
        if (this.active?.client === client && !this.active.finished) {
          this.failActive(stderr.trim().slice(-1200) || "Codex 服务意外停止");
        }
      });
      client.on("notification", (method) => {
        if (method === "skills/changed") this.capabilityCache.clear();
      });
    }
    return client;
  }

  // True only when the model may be chosen for a NEW turn. Legacy bindings are
  // intentionally excluded, so a paused runtime cannot be selected again.
  modelAllowed(model, profileId = this.defaultCodexProfile) {
    if (this.sub2api && String(model || "").startsWith("gpt-")) {
      const group = SUB2API_CODEX_MODELS[String(model)];
      if (!group || !this.codexBinaryAvailable() ||
          (group === "plus" ? !this.sub2api.plusKey : !this.sub2api.freeKey)) return false;
    }
    if (DEEPSEEK_MODELS.has(model)) return this.deepseekEnabled &&
      (this.allowedModels === null || this.allowedModels.has(model));
    const dynamic = this.availableModels.get(profileId);
    const policyAllows = this.allowedModels === null || this.allowedModels.has(model);
    // Catalog membership is required: either a model the provider actually
    // reported, or one in the selectable catalog. Without this, an operator policy
    // of "no restriction" accepted arbitrary model strings, which then failed deep
    // inside the harness instead of being rejected at the API.
    const catalogAllows = (dynamic && dynamic.has(model)) || SELECTABLE_MODELS.has(model);
    return policyAllows && catalogAllows && !this.modelBlockReason(model);
  }

  // A paused runtime or an unverified retired model is refused with an explicit,
  // stable reason. Never a silent substitution.
  modelBlockReason(model) {
    const id = String(model || "");
    if (PAUSED_RUNTIME_MODELS.has(id)) return PAUSED_RUNTIME_REASON;
    if (RETIRED_UNVERIFIED_MODELS.has(id)) return RETIRED_MODEL_REASON;
    return null;
  }

  // The single availability policy applied to EVERY model source, including the
  // list Codex reports. A model that cannot be served must not be advertised.
  isModelServable(model) {
    const id = String(model || "");
    if (!id) return false;
    return !this.modelBlockReason(id);
  }

  // What the API should report for a stored binding. A historical model that is no
  // longer selectable is still shown exactly as stored, so an existing session is
  // never rewritten to the default behind the user's back.
  displayModel(conversation, profileId = this.defaultCodexProfile) {
    const stored = String(conversation?.model || "");
    if (!stored) return this.defaultModel;
    if (this.modelAllowed(stored, profileId)) return stored;
    if (this.sub2api && stored.startsWith("gpt-")) return stored;
    if (LEGACY_KNOWN_MODELS.has(stored)) return stored;
    const dynamic = this.availableModels.get(profileId);
    if (dynamic && dynamic.has(stored)) return stored;
    return this.defaultModel;
  }

  conversationPath(id) {
    return path.join(this.chatDir, `${id}.json`);
  }

  readConversation(id, { forceFresh = false } = {}) {
    if (!ID_PATTERN.test(String(id || ""))) return null;
    if (this.workerClient || forceFresh || (this.active?.conversationId === id && this.active?.isWorker)) {
      this.store.evict?.(id);
      return this.store.load(id, { forceFresh: true });
    }
    const stored = this.store.load(id, { forceFresh });
    if (stored) return stored;
    try {
      return JSON.parse(fs.readFileSync(this.conversationPath(id), "utf8"));
    } catch {
      return null;
    }
  }

  writeConversation(conversation) {
    if (this.workerClient && this.store.selectConversation.get(conversation.id)) {
      conversation = this.store.mutate(conversation.id, (latest) => {
        const incoming = new Map(conversation.messages.map((message) => [message.id, message]));
        for (const message of latest.messages) {
          const workerOwns = this.active?.isWorker && this.active.messageId === message.id &&
            message.status === "running" && message.role === "assistant" &&
            ["google-antigravity", "grok-build"].includes(latest.harnessId) &&
            !this.remoteWorkspaceBinding(latest) &&
            !(this.active?.messageId === message.id && this.active.finished);
          if (workerOwns || !incoming.has(message.id)) incoming.set(message.id, message);
        }
        return { ...conversation, messages: [...incoming.values()],
          ...(latest.harnessSessionId ? { harnessSessionId: latest.harnessSessionId } : {}) };
      });
    } else {
      this.store.save(conversation, { immediate: Boolean(this.workerClient) });
    }
    this.scheduleConversationEvent(conversation.id);
    const existing = this.jsonCheckpoints.get(conversation.id);
    if (existing) {
      existing.conversation = conversation;
      return;
    }
    const checkpoint = { conversation };
    checkpoint.timer = setTimeout(() => {
      this.jsonCheckpoints.delete(conversation.id);
      this.writeJsonCheckpoint(this.workerClient
        ? (this.readConversation(conversation.id) || checkpoint.conversation) : checkpoint.conversation);
    }, 2_000);
    checkpoint.timer.unref();
    this.jsonCheckpoints.set(conversation.id, checkpoint);
  }

  scheduleConversationEvent(conversationId) {
    if (!this.eventSubscribers.get(conversationId)?.size ||
        this.eventBroadcasts.has(conversationId)) return;
    const timer = setTimeout(() => {
      this.eventBroadcasts.delete(conversationId);
      const conversation = this.readConversation(conversationId);
      if (!conversation || conversation.archived) return;
      this.broadcastConversationEvent(
        conversationId, "delta", this.publicConversationDelta(conversation));
    }, 180);
    timer.unref();
    this.eventBroadcasts.set(conversationId, timer);
  }

  writeConversationEvent(res, event, payload) {
    if (res.destroyed || res.writableEnded) return false;
    if (res.writableLength > 1024 * 1024) {
      res.destroy();
      return false;
    }
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      return true;
    } catch {
      return false;
    }
  }

  broadcastConversationEvent(conversationId, event, payload) {
    const subscribers = this.eventSubscribers.get(conversationId);
    if (!subscribers) return;
    for (const subscriber of [...subscribers]) {
      if (!this.writeConversationEvent(subscriber.res, event, payload)) {
        subscriber.close();
      }
    }
  }

  subscribeConversation(req, res, conversationId, limit = null) {
    const conversation = limit === null ? this.readConversation(conversationId)
      : this.store.loadPage(conversationId, { limit });
    if (!conversation || conversation.archived) {
      this.sendJson(res, 404, { error: "对话不存在" });
      return;
    }
    res.writeHead(200, {
      "Cache-Control": "no-store, no-transform",
      "Content-Type": "text/event-stream; charset=utf-8",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    });
    res.flushHeaders?.();
    res.write("retry: 1500\n\n");

    const subscribers = this.eventSubscribers.get(conversationId) || new Set();
    this.eventSubscribers.set(conversationId, subscribers);
    let closed = false;
    const subscriber = {
      res,
      close: () => {
        if (closed) return;
        closed = true;
        clearInterval(subscriber.heartbeat);
        subscribers.delete(subscriber);
        if (!subscribers.size) this.eventSubscribers.delete(conversationId);
        if (!res.writableEnded) res.end();
      },
    };
    subscriber.heartbeat = setInterval(() => {
      if (res.destroyed || res.writableEnded) subscriber.close();
      else res.write(": keep-alive\n\n");
    }, 25_000);
    subscriber.heartbeat.unref();
    subscribers.add(subscriber);
    req.on("aborted", subscriber.close);
    req.on("close", subscriber.close);
    res.on("close", subscriber.close);
    this.writeConversationEvent(res, "snapshot", {
      conversation: this.publicConversation(conversation),
    });
  }

  writeJsonCheckpoint(conversation) {
    const destination = this.conversationPath(conversation.id);
    const temporary = `${destination}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(conversation)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, destination);
  }

  allConversations() {
    return this.store.all().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  publicMessage(message) {
    const renderedImageIds = new Set();
    const { senderDeviceId: ignoredSenderDeviceId,
      clientRequestId: ignoredClientRequestId, requestFingerprint: ignoredFingerprint,
      ...publicFields } = message;
    return {
      ...publicFields,
      ...(message.senderDeviceId ? { senderDeviceLabel: this.deviceLabel(message.senderDeviceId) } : {}),
      artifacts: (message.artifacts || []).map((storedArtifact) => {
        const previewToken = this.issueArtifactPreviewToken(message.id, storedArtifact);
        const { sourcePath: ignored, ...artifact } = storedArtifact;
        return previewToken ? { ...artifact, previewToken } : artifact;
      }),
      previewVersions: (message.previewVersions || []).map((storedArtifact) => {
        const previewToken = this.issueArtifactPreviewToken(message.id, storedArtifact);
        const {
          sourcePath: ignored,
          sourceFile: ignoredSource,
          contentHash: ignoredHash,
          ...artifact
        } = storedArtifact;
        return previewToken ? { ...artifact, previewToken } : artifact;
      }),
      livePreview: message.livePreview ? (() => {
        const previewToken = this.issueArtifactPreviewToken(message.id, message.livePreview);
        const {
          sourcePath: ignored,
          sourceFile: ignoredSource,
          contentHash: ignoredHash,
          ...artifact
        } = message.livePreview;
        return previewToken ? { ...artifact, previewToken } : artifact;
      })() : null,
      images: (message.images || []).map(
        ({ sourcePath: ignoredPath, fileName: ignoredFile, ...image }) => image),
      stream: (message.stream || []).filter((entry) => {
        if (entry.kind !== "image" || !entry.imageId) return true;
        if (renderedImageIds.has(entry.imageId)) return false;
        renderedImageIds.add(entry.imageId);
        return true;
      }).map(({ details, ...entry }) => ({
        ...entry,
        hasDetails: Boolean(details),
      })),
    };
  }

  issueArtifactPreviewToken(messageId, artifact) {
    const extension = path.extname(String(artifact?.name || "")).toLowerCase();
    if (!artifact?.id || !artifact?.sourcePath || !['.html', '.htm'].includes(extension) ||
        Number(artifact.size || 0) > MAX_INLINE_PREVIEW_BYTES) return "";
    const now = Date.now();
    for (const [token, entry] of artifactPreviewTokens) {
      if (entry.expiresAt <= now) artifactPreviewTokens.delete(token);
      else if (entry.service === this && entry.messageId === messageId &&
          entry.artifactId === artifact.id) return token;
    }
    const token = crypto.randomBytes(24).toString("base64url");
    artifactPreviewTokens.set(token, {
      service: this,
      messageId,
      artifactId: artifact.id,
      expiresAt: now + ARTIFACT_PREVIEW_TTL_MS,
    });
    return token;
  }

  parsePreviewMarkers(value) {
    const paths = [];
    const visible = [];
    for (const line of String(value || "").split("\n")) {
      const match = line.trim().match(/^\[\[preview:(\/.+)\]\]$/);
      if (match) {
        paths.push(match[1].trim());
      } else if (!/^\s*\[\[preview:/.test(line)) {
        visible.push(line);
      }
    }
    return { text: visible.join("\n").trim(), paths };
  }

  publishPreviewSnapshot(assistant, requestedPath) {
    const verified = this.deliveryArtifact(requestedPath);
    const extension = path.extname(String(verified?.name || "")).toLowerCase();
    if (!verified || !['.html', '.htm'].includes(extension) ||
        verified.size > MAX_INLINE_PREVIEW_BYTES) return false;
    let source;
    try {
      source = fs.readFileSync(verified.sourcePath, "utf8");
    } catch {
      return false;
    }
    if (!/<html(?:\s|>)/i.test(source) || !/<\/html>\s*$/i.test(source) ||
        !/<body(?:\s|>)/i.test(source) || !/<\/body>/i.test(source)) return false;
    const artifactKey = crypto.createHash("sha256")
      .update(verified.sourcePath).digest("hex").slice(0, 24);
    const contentHash = crypto.createHash("sha256").update(source).digest("hex");
    let versions = Array.isArray(assistant.previewVersions)
      ? assistant.previewVersions.slice() : [];
    if (!versions.length && this.active?.conversationId) {
      const conversation = this.readConversation(this.active.conversationId);
      const previous = conversation?.messages?.slice().reverse().find((message) =>
        message.id !== assistant.id && message.livePreview?.artifactKey === artifactKey);
      if (previous) versions = (previous.previewVersions || []).slice(-20);
    }
    const latest = versions.at(-1);
    if (latest?.contentHash === contentHash || assistant.livePreview?.contentHash === contentHash) {
      return false;
    }
    const revision = Math.max(0, Number(latest?.revision || 0)) + 1;
    const id = crypto.randomUUID();
    const sourcePath = path.join(this.previewDir, `${id}.html`);
    const temporary = `${sourcePath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, source, { mode: 0o600 });
      fs.renameSync(temporary, sourcePath);
    } catch {
      try { fs.rmSync(temporary, { force: true }); } catch {}
      return false;
    }
    const snapshot = {
      id,
      name: verified.name,
      size: Buffer.byteLength(source),
      mimeType: "text/html",
      sourcePath,
      sourceFile: verified.sourcePath,
      artifactKey,
      contentHash,
      revision,
      live: true,
      createdAt: new Date().toISOString(),
    };
    versions.push(snapshot);
    while (versions.length > 20) {
      versions.shift();
    }
    assistant.previewVersions = versions;
    assistant.livePreview = snapshot;
    if (this.active?.messageId === assistant.id) {
      this.active.previewSourcePath = verified.sourcePath;
    }
    return true;
  }

  publicConversation(conversation, includeMessages = true) {
    const profile = this.profileFor(conversation);
    const remoteWorkspace = this.remoteWorkspaceBinding(conversation);
    const messages = conversation.messages || [];
    const active = this.active?.conversationId === conversation.id ? this.active : null;
    const busy = conversation.busy ?? messages.some((message) =>
      message.role === "assistant" && ["queued", "running"].includes(message.status));
    const lastAssistant = messages.findLast((message) => message.role === "assistant");
    const waiting = Boolean(active?.pendingApprovals?.size) || (conversation.awaitingConfirmation ??
      lastAssistant?.stream?.some((entry) => entry.kind === "approval" && entry.status === "pending"));
    const lastStatus = conversation.lastAssistantStatus ?? lastAssistant?.status;
    const taskState = waiting ? "awaiting_confirmation" : busy ? "running" :
      lastStatus === "failed" ? "failed" : lastStatus === "interrupted" ? "interrupted" :
      messages.length || conversation.totalMessages ? "completed" : "idle";
    const result = {
      id: conversation.id,
      title: conversation.title,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      archived: Boolean(conversation.archived),
      pinned: Boolean(conversation.pinned),
      project: String(conversation.project || ""),
      hasAttachments: conversation.hasAttachments ?? messages.some((message) =>
        message.attachments?.length || message.artifacts?.length),
      taskStatus: { state: taskState, label: {
        awaiting_confirmation: "等你确认", running: "处理中", failed: "执行失败",
        completed: "已结束", interrupted: "已暂停", idle: "尚未开始",
      }[taskState] },
      activeDeviceLabel: active?.ownerDeviceId ? this.deviceLabel(active.ownerDeviceId) : null,
      codexProfile: profile.id,
      codexProfileLabel: profile.label,
      codexProfileAllowed: this.profileAllowed(conversation),
      hasCodexContext: Boolean(conversation.codexThreadId),
      // Exposed so the client can see the session's runtime binding without
      // having to read the harness session identifier itself.
      harnessSessionBound: Boolean(conversation.harnessSessionId),
      harnessSessionId: conversation.harnessSessionId || null,
      harnessId: conversation.harnessId || resolveHarness(conversation.model, "auto"),
      harnessLabel: (HARNESSES[conversation.harnessId] || HARNESSES[resolveHarness(conversation.model, "auto")]).displayName,
      // Reported from the stored value: a legacy provider binding is not rewritten.
      providerId: conversation.providerId || providerForModel(conversation.model),
      accountGroup: this.sub2api ? SUB2API_CODEX_MODELS[String(conversation.model || "")] || null : null,
      model: this.displayModel(conversation, profile.id),
      modelBlockedReason: this.modelBlockReason(conversation.model),
      reasoning: conversation.reasoning || "medium",
      accessMode: ALLOWED_ACCESS.has(conversation.accessMode)
        ? conversation.accessMode : "danger-full-access",
      workDir: Object.hasOwn(conversation, "workDir")
        ? (remoteWorkspace ? "" : (conversation.workDir || "")) : this.codexWorkDir,
      remoteWorkspace: remoteWorkspace ? {
        workspaceId: remoteWorkspace.workspace_id,
        customerId: remoteWorkspace.customer_id,
        deviceLabel: remoteWorkspace.device_id,
        rootAlias: remoteWorkspace.root_alias,
        displayPath: remoteWorkspace.display_path,
        state: remoteWorkspace.state,
      } : null,
      contextUsage: this.quotaExhausted ? {
        usedTokens: 1,
        contextWindow: 1,
        updatedAt: null,
      } : (conversation.contextUsage?.source === "last-input" ? {
        usedTokens: Math.max(0, Number(conversation.contextUsage.usedTokens || 0)),
        contextWindow: Math.max(0, Number(conversation.contextUsage.contextWindow || 0)),
        updatedAt: conversation.contextUsage.updatedAt || null,
      } : null),
      busy,
      lastMessage: conversation.lastMessage ?? messages.at(-1)?.text ?? "",
    };
    if (includeMessages) {
      result.messages = messages.map((message) => this.publicMessage(message));
      result.messageOffset = conversation.messageOffset || 0;
      result.totalMessages = conversation.totalMessages ?? messages.length;
      result.hasMore = result.messageOffset > 0;
    }
    return result;
  }

  deviceLabel(deviceId) {
    // Account-scoped display fingerprint, never a login/device identifier.
    return `设备 ${crypto.createHash("sha256").update(`${this.chatDir}\0${deviceId}`).digest("hex").slice(0, 6).toUpperCase()}`;
  }

  publicConversationDelta(conversation) {
    const lastAssistantIndex = conversation.messages.findLastIndex(
      (message) => message.role === "assistant");
    const replaceFrom = lastAssistantIndex >= 0
      ? lastAssistantIndex : Math.max(0, conversation.messages.length - 2);
    return {
      conversation: this.publicConversation(conversation, false),
      replaceFrom,
      totalMessages: conversation.messages.length,
      messages: conversation.messages.slice(replaceFrom)
        .map((message) => this.publicMessage(message)),
    };
  }

  imageType(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
    if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return { extension: ".png", mimeType: "image/png" };
    }
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return { extension: ".jpg", mimeType: "image/jpeg" };
    }
    const signature = buffer.subarray(0, 6).toString("ascii");
    if (signature === "GIF87a" || signature === "GIF89a") {
      return { extension: ".gif", mimeType: "image/gif" };
    }
    if (buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
        buffer.subarray(8, 12).toString("ascii") === "WEBP") {
      return { extension: ".webp", mimeType: "image/webp" };
    }
    return null;
  }

  safeImageSource(requestedPath) {
    try {
      const sourcePath = fs.realpathSync(String(requestedPath || ""));
      const lower = sourcePath.toLowerCase();
      const generatedImage = /^\/home\/ubuntu\/\.codex(?:-xuanyu)?\/generated_images\/[a-f0-9-]{36}\/[a-z0-9-]+\.(?:png|jpg|jpeg|webp|gif)$/i.test(sourcePath);
      if ((/(^|\/)(\.ssh|\.gnupg|\.aws|\.codex)(\/|$)/.test(lower) && !generatedImage) ||
          /(^|\/)(\.env($|\.)|[^/]*(token|credential|secret|private[_-]?key)[^/]*)$/.test(lower)) {
        return null;
      }
      const stats = fs.statSync(sourcePath);
      if (!stats.isFile() || stats.size < 12 || stats.size > MAX_INLINE_IMAGE_BYTES) return null;
      const handle = fs.openSync(sourcePath, "r");
      const header = Buffer.alloc(16);
      fs.readSync(handle, header, 0, header.length, 0);
      fs.closeSync(handle);
      const type = this.imageType(header);
      return type ? { sourcePath, stats, type } : null;
    } catch {
      return null;
    }
  }

  storeImageBuffer(buffer, name, source = "execution", artifactId = null) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 12 || buffer.length > MAX_INLINE_IMAGE_BYTES) {
      return null;
    }
    const type = this.imageType(buffer);
    if (!type) return null;
    const id = crypto.randomUUID();
    const fileName = `${id}${type.extension}`;
    const destination = path.join(this.imageDir, fileName);
    fs.writeFileSync(destination, buffer, { mode: 0o600, flag: "wx" });
    const image = {
      id,
      name: String(name || `Chloe 图片${type.extension}`).slice(0, 180),
      size: buffer.length,
      mimeType: type.mimeType,
      source,
      artifactId,
      createdAt: new Date().toISOString(),
      fileName,
      sourcePath: destination,
    };
    fs.writeFileSync(
      path.join(this.imageDir, `${id}.json`),
      `${JSON.stringify({
        id: image.id,
        name: image.name,
        size: image.size,
        mimeType: image.mimeType,
        fileName: image.fileName,
      })}\n`,
      { mode: 0o600, flag: "wx" },
    );
    return image;
  }

  storeImagePath(requestedPath, source = "execution", artifactId = null) {
    const verified = this.safeImageSource(requestedPath);
    if (!verified) return null;
    const buffer = fs.readFileSync(verified.sourcePath);
    return this.storeImageBuffer(
      buffer, path.basename(verified.sourcePath), source, artifactId);
  }

  storeImageData(value, name = "Chloe 生成图片", source = "execution") {
    const raw = String(value || "");
    const dataUrl = raw.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([a-zA-Z0-9+/=\s]+)$/);
    const encoded = dataUrl ? dataUrl[2] : raw;
    if (!encoded || encoded.length > Math.ceil(MAX_INLINE_IMAGE_BYTES * 4 / 3) + 16) return null;
    try {
      return this.storeImageBuffer(Buffer.from(encoded.replace(/\s+/g, ""), "base64"), name, source);
    } catch {
      return null;
    }
  }

  attachImage(message, image) {
    if (!image) return null;
    message.images = Array.isArray(message.images) ? message.images : [];
    const duplicate = message.images.find((candidate) =>
      (image.artifactId && candidate.artifactId === image.artifactId) ||
      (candidate.size === image.size && candidate.name === image.name &&
        candidate.source === image.source));
    if (duplicate) return duplicate;
    message.images.push(image);
    return image;
  }

  captureToolImages(message, item) {
    const contents = item.type === "dynamicToolCall"
      ? item.contentItems
      : item.result?.content;
    if (!Array.isArray(contents)) return [];
    const images = [];
    for (const [index, content] of contents.entries()) {
      if (!content || typeof content !== "object") continue;
      let image = null;
      if (content.type === "image" && content.data) {
        image = this.storeImageData(content.data, `工具图片 ${index + 1}`);
      } else if ((content.type === "inputImage" || content.type === "input_image") &&
          (content.imageUrl || content.image_url)) {
        image = this.storeImageData(
          content.imageUrl || content.image_url, `工具图片 ${index + 1}`);
      }
      if (image) images.push(this.attachImage(message, image));
    }
    return images.filter(Boolean);
  }

  captureGeneratedImage(message, item) {
    const savedPath = item.savedPath || item.saved_path;
    const stored = savedPath
      ? this.storeImagePath(savedPath, "execution")
      : this.storeImageData(item.result, "Chloe 生成图片", "execution");
    return this.attachImage(message, stored);
  }

  generatedImageFiles(threadId, codexHome = "/home/ubuntu/.codex") {
    if (!ID_PATTERN.test(String(threadId || ""))) return new Set();
    const directory = path.join(codexHome, "generated_images", threadId);
    try {
      return new Set(fs.readdirSync(directory)
        .map((name) => path.join(directory, name))
        .filter((file) => fs.statSync(file).isFile() && this.safeImageSource(file)));
    } catch {
      return new Set();
    }
  }

  captureNewGeneratedImages(message, threadId, before = new Set(),
      codexHome = "/home/ubuntu/.codex") {
    const images = [];
    for (const sourcePath of this.generatedImageFiles(threadId, codexHome)) {
      if (before.has(sourcePath)) continue;
      const existingIds = new Set((message.images || []).map((image) => image.id));
      const image = this.attachImage(message,
        this.storeImagePath(sourcePath, "execution"));
      if (image && !existingIds.has(image.id)) images.push(image);
    }
    return images;
  }

  handlePublicImage(req, res, url) {
    const match = url.pathname.match(/^\/chat-images\/([a-f0-9-]{36})$/);
    if (!match) return false;
    if (req.method !== "GET") {
      this.sendJson(res, 405, { error: "不支持此请求方法" });
      return true;
    }
    try {
      const metadataPath = path.join(this.imageDir, `${match[1]}.json`);
      const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
      if (metadata.id !== match[1] || !IMAGE_ID_PATTERN.test(metadata.id) ||
          !/^[a-f0-9-]{36}\.(?:png|jpg|webp|gif)$/.test(metadata.fileName)) {
        throw new Error("invalid image metadata");
      }
      const imagePath = path.join(this.imageDir, metadata.fileName);
      const resolved = fs.realpathSync(imagePath);
      if (!resolved.startsWith(`${path.resolve(this.imageDir)}${path.sep}`)) {
        throw new Error("invalid image path");
      }
      const stats = fs.statSync(resolved);
      if (!stats.isFile() || stats.size !== metadata.size || stats.size > MAX_INLINE_IMAGE_BYTES) {
        throw new Error("invalid image file");
      }
      const verified = this.safeImageSource(resolved);
      if (!verified || verified.type.mimeType !== metadata.mimeType) {
        throw new Error("invalid image type");
      }
      res.writeHead(200, {
        "Cache-Control": "private, max-age=3600",
        "Content-Length": stats.size,
        "Content-Type": metadata.mimeType,
        "Content-Security-Policy": "default-src 'none'",
        "X-Content-Type-Options": "nosniff",
      });
      fs.createReadStream(resolved).pipe(res);
    } catch {
      this.sendJson(res, 404, { error: "图片不存在" });
    }
    return true;
  }

  normalizeWorkDir(value) {
    const requested = String(value || "").trim();
    if (!requested) return null;
    if (!path.isAbsolute(requested)) throw new Error("项目路径必须是绝对路径");
    const lexical = path.resolve(requested);
    const outsideError = () => new Error("该项目路径不在 Chloe 允许的工作目录范围内");

    let stats;
    try {
      stats = fs.statSync(lexical);
    } catch {
      // A missing path is still checked against the allowlist first, so the
      // response never depends on anything outside the permitted roots.
      if (!isWithinRoots([lexical], this.workDirRoots)) throw outsideError();
      throw new Error("项目路径不存在");
    }
    if (!stats.isDirectory()) throw new Error("项目路径不是目录");

    // Fail closed: the real path must be resolvable AND permitted. Checking the
    // resolved path is what stops a symlink inside the workspace from escaping it.
    let real;
    try {
      real = fs.realpathSync(lexical);
    } catch {
      throw outsideError();
    }
    if (!isWithinRoots([real], this.workDirRoots)) throw outsideError();
    return real;
  }

  effectiveWorkDir(conversation) {
    const binding = this.remoteWorkspaceBinding(conversation);
    if (binding) return this.remoteWorkspaceService.runtimeFor(binding).cwd;
    if (!Object.hasOwn(conversation, "workDir")) return this.codexWorkDir;
    return conversation.workDir || "/home/ubuntu";
  }

  remoteWorkspaceBinding(conversation) {
    if (!this.remoteWorkspaceService || !conversation?.id) return null;
    try { return this.remoteWorkspaceService.bindingForConversation(conversation.id); }
    catch { return null; }
  }

  profileFor(conversation) {
    const requested = String(conversation?.codexProfile || "default");
    return this.codexProfiles[requested] || this.codexProfiles.default;
  }

  profileAllowed(conversation) {
    const requested = String(conversation?.codexProfile || "default");
    return Boolean(this.codexProfiles[requested]) && this.allowedCodexProfiles.has(requested);
  }

  createConversation(title = "新对话", model = this.defaultModel, reasoning = "medium",
      accessMode = "danger-full-access", workDir = "", codexProfile = null) {
    const requestedProfile = codexProfile == null || codexProfile === ""
      ? this.defaultCodexProfile : String(codexProfile);
    if (!this.allowedCodexProfiles.has(requestedProfile)) {
      throw new Error("该用户不能使用这个 Codex 账号");
    }
    const profile = this.codexProfiles[requestedProfile];
    const requestedWorkDir = workDir || (profile.id === "default" ? "" : profile.workDir);
    const now = new Date().toISOString();
    // A paused runtime is refused outright, for every role, before any fallback.
    const requestedModel = String(model == null || model === "" ? this.defaultModel : model);
    if (this.sub2api && requestedModel.startsWith("gpt-")) {
      // Never replace an unsupported or unconfigured gateway choice with a
      // default that may consume a different account pool.
      createSub2ApiRoute({ model: requestedModel, sub2api: this.sub2api });
    }
    const blockReason = this.modelBlockReason(requestedModel);
    if (blockReason) {
      const error = new Error(`该模型不可用于新会话（${blockReason}）：${requestedModel}`);
      error.blockReason = blockReason;
      error.model = requestedModel;
      throw error;
    }
    if (this.sub2api && SUB2API_CODEX_MODELS[requestedModel] &&
        !this.modelAllowed(requestedModel, profile.id)) {
      throw new Error("该 Sub2API 模型当前未开放，未改用其他模型");
    }
    const resolvedModel = this.modelAllowed(requestedModel, profile.id)
      ? requestedModel : this.defaultModel;
    const conversation = {
      id: crypto.randomUUID(),
      title: String(title || "新对话").trim().slice(0, 60) || "新对话",
      createdAt: now,
      updatedAt: now,
      archived: false,
      codexThreadId: null,
      codexProfile: profile.id,
      model: resolvedModel,
      // "auto" is resolved from the model, so a new session binds grok-build for
      // grok-* without the caller having to know about harnesses.
      harnessId: resolveHarness(resolvedModel, "auto"),
      // Explicit per-family mapping; an unknown model yields null, never a gateway.
      providerId: this.sub2api && SUB2API_CODEX_MODELS[resolvedModel]
        ? "sub2api" : providerForModel(resolvedModel),
      harnessSessionId: null,
      reasoning: ALLOWED_REASONING.has(reasoning) ? reasoning : "medium",
      accessMode: ALLOWED_ACCESS.has(accessMode) ? accessMode : "danger-full-access",
      workDir: this.normalizeWorkDir(requestedWorkDir),
      messages: [],
    };
    this.writeConversation(conversation);
    return conversation;
  }

  createRemoteWorkspaceConversation({ title, model, reasoning, harnessSessionId }) {
    if (!this.remoteWorkspaceService || !/^grok-/.test(String(model || ""))) {
      throw new Error("远程工作区目前仅支持 Grok Build");
    }
    if (typeof harnessSessionId !== "string" || !harnessSessionId) throw new Error("远程会话标识无效");
    const conversation = this.createConversation(title || "远程开发工作区", model, reasoning || "high",
      "workspace-write", "", null);
    conversation.harnessId = "grok-build";
    conversation.providerId = providerForModel(conversation.model) || "cpa";
    conversation.harnessSessionId = harnessSessionId;
    conversation.remoteWorkspaceStarted = false;
    // A Remote Workspace never maps a client-side Windows path to `workDir`.
    conversation.workDir = "";
    this.writeConversation(conversation);
    return conversation;
  }

  readUpload(id) {
    if (!/^[a-zA-Z0-9-]+$/.test(String(id || ""))) return null;
    try {
      const record = JSON.parse(fs.readFileSync(path.join(this.dataDir, `${id}.json`), "utf8"));
      const absolutePath = path.join(this.dataDir, record.storedName);
      if (!absolutePath.startsWith(`${path.resolve(this.dataDir)}${path.sep}`)) return null;
      if (!fs.statSync(absolutePath).isFile()) return null;
      return {
        id: record.id,
        name: record.originalName,
        mimeType: record.mimeType || "application/octet-stream",
        size: Number(record.size || 0),
        path: absolutePath,
      };
    } catch {
      return null;
    }
  }

  // Selectable harness models offered to this principal. The only source of
  // harness-served models, and it never consults Codex. Paused runtimes are
  // absent by construction.
  harnessModelCatalog() {
    const models = [];
    for (const id of SELECTABLE_HARNESS_MODELS) {
      if (this.allowedModels !== null && !this.allowedModels.has(id)) continue;
      if (this.modelBlockReason(id)) continue;
      models.push({
        id,
        displayName: id.startsWith("gemini-") ? `Gemini ${id.replace(/^gemini-/, "").replace(/-(low|medium|high|max)$/, "").replace(/-/g, " ")}` : `Grok ${id.replace(/^grok-/, "").replace(/-/g, " ")}`,
        isDefault: id === this.defaultModel,
        inputModalities: ["text", "image"],
        defaultReasoningEffort: "high",
        reasoningEfforts: [
          { id: "low", description: "快速" },
          { id: "medium", description: "均衡" },
          { id: "high", description: "深入" },
        ],
        supportsPersonality: false,
        upgrade: null,
        harness: resolveHarness(id, "auto"),
        provider: providerForModel(id),
      });
    }
    return models;
  }

  sub2apiCodexCatalog() {
    if (!this.sub2api || !this.codexBinaryAvailable()) return [];
    return Object.entries(SUB2API_CODEX_MODELS).flatMap(([id, group]) => {
      if (this.allowedModels !== null && !this.allowedModels.has(id)) return [];
      if (group === "plus" ? !this.sub2api.plusKey : !this.sub2api.freeKey) return [];
      return [{
        id,
        displayName: id.replace(/^gpt-/, "GPT-").replace(/(^|-)([a-z0-9])/g,
          (_match, prefix, letter) => `${prefix}${letter.toUpperCase()}`),
        isDefault: id === this.defaultModel,
        inputModalities: ["text", "image"],
        defaultReasoningEffort: "high",
        reasoningEfforts: [
          { id: "low", description: "快速" },
          { id: "medium", description: "均衡" },
          { id: "high", description: "深入" },
        ],
        supportsPersonality: false,
        upgrade: null,
        harness: "codex",
        provider: "sub2api",
        accountGroup: group,
      }];
    });
  }

  modelProviderIdentity(model) {
    const id = String(model || "");
    if (DEEPSEEK_MODELS.has(id)) return "deepseek";
    if (this.sub2api && SUB2API_CODEX_MODELS[id]) return `sub2api-${SUB2API_CODEX_MODELS[id]}`;
    return "codex";
  }

  codexBinaryAvailable() {
    return Boolean(describeBinary("codex", { bin: this.codexBin })?.exists);
  }

  // DeepSeek runs through Codex, so it is only offered when Codex is reachable.
  deepseekCatalog() {
    return [
      {
        id: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro", isDefault: false,
        inputModalities: ["text"], defaultReasoningEffort: "high",
        reasoningEfforts: [
          { id: "high", description: "DeepSeek 深度思考" },
          { id: "xhigh", description: "DeepSeek 最大思考" },
        ],
        supportsPersonality: false, upgrade: null, provider: "deepseek",
      },
      {
        id: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash", isDefault: false,
        inputModalities: ["text"], defaultReasoningEffort: "high",
        reasoningEfforts: [
          { id: "high", description: "DeepSeek 深度思考" },
          { id: "xhigh", description: "DeepSeek 最大思考" },
        ],
        supportsPersonality: false, upgrade: null, provider: "deepseek",
      },
    ].filter((model) => this.allowedModels === null || this.allowedModels.has(model.id));
  }

  // Probes Codex for its own catalog. Never throws: a failure is recorded as an
  // availability reason so harness capabilities can still be served.
  async codexCapabilities(profile) {
    const empty = {
      available: false, reason: null, models: [], skills: [],
      mcpServers: [], collaborationModes: [], features: [],
    };
    try {
      if (this.sub2api) {
        const binaryAvailable = this.codexBinaryAvailable();
        const configured = binaryAvailable && this.sub2apiCodexCatalog().length > 0;
        return {
          ...empty,
          available: configured,
          reason: configured ? null : binaryAvailable ? "authentication_required" : "executable_not_found",
          configuration: configured ? "configured_not_model_verified" : null,
          binaryAvailable,
        };
      }
      // A present CLI is not a usable Codex runtime without local authentication.
      // Check only for credential presence; never parse or log credential contents,
      // and avoid opening the app server (which may initiate provider requests).
      const authFiles = [profile.codexHome, "/root/.codex", "/home/ubuntu/.codex"]
        .filter(Boolean).map((directory) => path.join(directory, "auth.json"));
      const authenticated = Boolean(process.env.CODEX_ACCESS_TOKEN || process.env.OPENAI_API_KEY) ||
        authFiles.some((file) => { try { return fs.statSync(file).isFile(); } catch { return false; } });
      if (!authenticated) return { ...empty, reason: "authentication_required" };
      const client = this.clientFor(profile);
      await client.start();
      const settled = await Promise.allSettled([
        client.request("model/list", { limit: 100, includeHidden: false }),
        client.request("skills/list", { cwds: [profile.workDir], forceReload: false }),
        client.request("mcpServerStatus/list", { limit: 100, detail: "toolsAndAuthOnly" }),
        client.request("collaborationMode/list", {}),
        client.request("experimentalFeature/list", { limit: 100 }),
      ]);
      const value = (index) => settled[index].status === "fulfilled"
        ? settled[index].value : {};
      // The same availability policy applies to Codex-reported models: a paused or
      // retired model must not be advertised just because Codex listed it.
      const models = (value(0).data || []).filter((model) => {
        const id = String(model.id || model.model || "");
        return !model.hidden && this.isModelServable(id) &&
          (this.allowedModels === null || this.allowedModels.has(id)) &&
          (!this.sub2api || !id.startsWith("gpt-") || this.modelAllowed(id, profile.id));
      })
        .map((model) => ({
        id: String(model.id || model.model || ""),
        displayName: String(model.displayName || model.id || model.model || ""),
        isDefault: Boolean(model.isDefault),
        inputModalities: Array.isArray(model.inputModalities)
          ? model.inputModalities.map(String) : ["text", "image"],
        defaultReasoningEffort: String(model.defaultReasoningEffort || "medium"),
        reasoningEfforts: (model.supportedReasoningEfforts || []).map((effort) => ({
          id: String(effort.reasoningEffort || ""),
          description: String(effort.description || ""),
        })).filter((effort) => effort.id),
        supportsPersonality: Boolean(model.supportsPersonality),
        upgrade: model.upgrade ? String(model.upgrade) : null,
      })).filter((model) => model.id);
      const skillGroups = value(1).data || [];
      const skills = skillGroups.flatMap((group) => group.skills || []).map((skill) => ({
        name: String(skill.name || ""),
        description: String(skill.description || skill.interface?.shortDescription || ""),
        enabled: skill.enabled !== false,
      })).filter((skill) => skill.name);
      const mcpServers = (value(2).data || []).map((server) => ({
        name: String(server.name || server.serverName || ""),
        status: String(server.status || "unknown"),
        authStatus: String(server.authStatus || server.auth?.status || "unknown"),
        toolCount: Array.isArray(server.tools) ? server.tools.length : 0,
      })).filter((server) => server.name);
      const collaborationModes = (value(3).data || value(3).collaborationModes || [])
        .map((mode) => ({ id: String(mode.id || mode.name || ""),
          label: String(mode.label || mode.displayName || mode.id || mode.name || "") }))
        .filter((mode) => mode.id);
      const features = (value(4).data || []).map((feature) => ({
        name: String(feature.name || ""), stage: String(feature.stage || ""),
        enabled: Boolean(feature.enabled), displayName: String(feature.displayName || ""),
      })).filter((feature) => feature.name);
      return { available: true, reason: null, models, skills, mcpServers, collaborationModes, features };
    } catch (error) {
      const reason = codexUnavailableReason(error);
      this.runtimeLogger.log({
        harness: "codex", provider: "codex", model: this.defaultModel,
        event: "capabilities_unavailable", errorType: reason,
      });
      return { ...empty, reason };
    }
  }

  // Availability is reported per harness so the workspace can show why something
  // is missing instead of failing to load at all. No host paths or arguments.
  runtimeStatus(codex) {
    // Use the operator's configured binary, not just the default install path.
    const configuredBin = this.harnessOptions?.grok?.bin;
    const grok = describeBinary("grok-build", configuredBin ? { bin: configuredBin } : {});
    const antigravity = describeBinary("google-antigravity", this.harnessOptions?.antigravity || {});
    return {
      codex: {
        available: codex.available,
        status: codex.available ? "ready" : "unavailable",
        reason: codex.reason || null,
        ...(codex.configuration ? { configuration: codex.configuration } : {}),
      },
      "grok-build": {
        available: Boolean(grok && grok.exists),
        status: grok && grok.exists ? "ready" : "executable_not_found",
        provider: providerForModel(DEFAULT_HARNESS_MODEL),
      },
      "google-antigravity": {
        available: Boolean(antigravity.exists),
        status: antigravity.exists ? "ready" : "executable_not_found",
        provider: "google-antigravity",
      },
    };
  }

  // Always answers 200. A missing harness is reported inside the payload, never as
  // an endpoint failure, and never with raw host detail.
  async readCapabilities(res) {
    const profile = this.codexProfiles[this.defaultCodexProfile];
    const cached = this.capabilityCache.get(profile.id);
    if (cached && Date.now() - cached.cachedAt < 5 * 60 * 1000) {
      this.sendJson(res, 200, cached.payload);
      return;
    }
    const harnessModels = this.harnessModelCatalog();
    let codex;
    try {
      codex = await this.codexCapabilities(profile);
    } catch (error) {
      // Last-resort guard: the endpoint must not fail because of a harness probe.
      codex = {
        available: false, reason: codexUnavailableReason(error), models: [],
        skills: [], mcpServers: [], collaborationModes: [], features: [],
      };
    }
    const deepseekModels = codex.available && this.deepseekEnabled ? this.deepseekCatalog() : [];
    // Deduplicate by id: a model may be reported by Codex and also come from the
    // harness catalog. The harness entry wins, so the binding stays explicit.
    const merged = new Map();
    for (const model of [...codex.models, ...this.sub2apiCodexCatalog(), ...deepseekModels, ...harnessModels]) {
      if (!model || !model.id || !this.isModelServable(model.id)) continue;
      merged.set(model.id, model);
    }
    const models = [...merged.values()];
    this.availableModels.set(profile.id, new Set(models.map((model) => model.id)));
    const payload = {
      models,
      skills: codex.skills,
      mcpServers: codex.mcpServers,
      collaborationModes: codex.collaborationModes,
      features: codex.features,
      // Codex-only actions require Codex to actually be reachable.
      support: {
        fork: codex.available, compact: codex.available,
        review: codex.available, plans: codex.available,
      },
      harnesses: Object.values(HARNESSES),
      defaultHarness: "auto",
      defaultModel: this.defaultModel,
      runtime: this.runtimeStatus(codex),
      checkedAt: new Date().toISOString(),
    };
    this.capabilityCache.set(profile.id, { cachedAt: Date.now(), payload });
    this.sendJson(res, 200, payload);
  }

  async resumeOnClient(conversation) {
    if (!conversation.codexThreadId) throw new Error("这个对话还没有可复用的 Codex 上下文");
    const profile = this.profileFor(conversation);
    const client = this.clientFor(profile, conversation.model);
    await client.start();
    await client.request("thread/resume", {
      threadId: conversation.codexThreadId,
      cwd: this.effectiveWorkDir(conversation),
      model: conversation.model,
      sandbox: conversation.accessMode,
      approvalPolicy: "on-request",
      developerInstructions: this.buildDeveloperInstructions(conversation),
      excludeTurns: true,
    });
    return client;
  }

  handle(req, res, url, principal = {}) {
    if (!url.pathname.startsWith("/chat/")) return false;
    const deviceId = String(principal.deviceId || "legacy");

    if (req.method === "GET" && url.pathname === "/chat/conversations") {
      const query = String(url.searchParams.get("q") || "").trim().slice(0, 200);
      const project = url.searchParams.get("project");
      const entries = query ? this.store.search(query, { limit: 100 }) : this.store.listMetadata();
      const conversations = entries
        .filter((conversation) => !conversation.archived)
        .filter((conversation) => project === null || String(conversation.project || "") === project)
        .filter((conversation) => url.searchParams.get("attachments") !== "1" || conversation.hasAttachments)
        .map((conversation) => ({ ...this.publicConversation(conversation, false),
          ...(query ? { matchingMessageId: conversation.matchingMessageId,
            searchSnippet: conversation.snippet } : {}) }))
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
      const activeConversationId = this.active?.ownerDeviceId === deviceId
        ? this.active.conversationId : null;
      this.sendJson(res, 200, { activeConversationId, conversations,
        currentDeviceLabel: this.deviceLabel(deviceId) });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/chat/workspace-overview") {
      Promise.resolve().then(() => workspaceOverview({ workDir: this.codexWorkDir, dataDir: this.dataDir }))
        .then((payload) => this.sendJson(res, 200, payload))
        .catch(() => this.sendJson(res, 503, { error: "暂时无法读取项目与服务状态" }));
      return true;
    }

    if (req.method === "GET" && url.pathname === "/chat/capabilities") {
      this.readCapabilities(res);
      return true;
    }

    if (req.method === "GET" && url.pathname === "/chat/usage") {
      this.readAccountUsage(res, url.searchParams.get("conversationId"));
      return true;
    }

    if (req.method === "POST" && url.pathname === "/chat/usage/reset") {
      this.consumeRateLimitReset(res, url.searchParams.get("conversationId"));
      return true;
    }

    if (req.method === "POST" && url.pathname === "/chat/conversations") {
      this.readJsonBody(req, 16 * 1024, (error, body) => {
        if (error) {
          this.sendJson(res, 400, { error: error.message });
          return;
        }
        try {
          const conversation = this.createConversation(
            body?.title, body?.model, body?.reasoning, body?.accessMode, body?.workDir,
            body?.codexProfile);
          this.sendJson(res, 201, { conversation: this.publicConversation(conversation) });
        } catch (createError) {
          const body400 = { error: createError.message || "无法创建对话" };
          if (createError.blockReason) {
            body400.blockReason = createError.blockReason;
            body400.model = createError.model || null;
          }
          this.sendJson(res, 400, body400);
        }
      });
      return true;
    }

    const messageMatch = url.pathname.match(/^\/chat\/conversations\/([a-f0-9-]{36})\/messages$/);
    if (req.method === "GET" && messageMatch) {
      const before = url.searchParams.get("before");
      const limit = url.searchParams.get("limit");
      if ((before !== null && !/^\d+$/.test(before)) ||
          (limit !== null && !/^[1-9]\d*$/.test(limit))) {
        this.sendJson(res, 400, { error: "分页参数无效" });
        return true;
      }
      const conversation = this.store.loadPage(messageMatch[1], {
        ...(before !== null ? { before: Number(before) } : {}),
        limit: Math.min(100, Number(limit || 40)),
      });
      if (!conversation || conversation.archived) this.sendJson(res, 404, { error: "对话不存在" });
      else this.sendJson(res, 200, { conversation: this.publicConversation(conversation) });
      return true;
    }
    if (req.method === "POST" && messageMatch) {
      this.createMessage(req, res, messageMatch[1], deviceId);
      return true;
    }

    const syncMatch = url.pathname.match(/^\/chat\/conversations\/([a-f0-9-]{36})\/sync$/);
    if (req.method === "GET" && syncMatch) {
      const conversation = this.readConversation(syncMatch[1]);
      if (!conversation || conversation.archived) {
        this.sendJson(res, 404, { error: "对话不存在" });
        return true;
      }
      this.sendJson(res, 200, this.publicConversationDelta(conversation));
      return true;
    }

    const eventsMatch = url.pathname.match(
      /^\/chat\/conversations\/([a-f0-9-]{36})\/events$/);
    if (req.method === "GET" && eventsMatch) {
      const limit = url.searchParams.get("limit");
      if (limit !== null && !/^[1-9]\d*$/.test(limit)) {
        this.sendJson(res, 400, { error: "分页参数无效" });
        return true;
      }
      this.subscribeConversation(req, res, eventsMatch[1], limit === null ? null : Math.min(100, Number(limit)));
      return true;
    }

    const artifactMatch = url.pathname.match(
      /^\/chat\/conversations\/([a-f0-9-]{36})\/messages\/([a-f0-9-]{36})\/artifacts\/([a-f0-9-]{36})(\/preview)?$/);
    if (req.method === "GET" && artifactMatch) {
      if (artifactMatch[4]) {
        this.previewArtifact(res, artifactMatch[1], artifactMatch[2], artifactMatch[3]);
      } else {
        this.downloadArtifact(res, artifactMatch[1], artifactMatch[2], artifactMatch[3]);
      }
      return true;
    }

    const streamMatch = url.pathname.match(
      /^\/chat\/conversations\/([a-f0-9-]{36})\/messages\/([a-f0-9-]{36})\/stream\/([a-zA-Z0-9_-]{1,160})$/);
    if (req.method === "GET" && streamMatch) {
      this.streamDetails(res, streamMatch[1], streamMatch[2], streamMatch[3]);
      return true;
    }

    const interruptMatch = url.pathname.match(
      /^\/chat\/conversations\/([a-f0-9-]{36})\/interrupt$/);
    if (req.method === "POST" && interruptMatch) {
      this.interruptConversation(res, interruptMatch[1], deviceId);
      return true;
    }

    const forkMatch = url.pathname.match(
      /^\/chat\/conversations\/([a-f0-9-]{36})\/fork$/);
    if (req.method === "POST" && forkMatch) {
      this.forkConversation(req, res, forkMatch[1]);
      return true;
    }

    const compactMatch = url.pathname.match(
      /^\/chat\/conversations\/([a-f0-9-]{36})\/compact$/);
    if (req.method === "POST" && compactMatch) {
      this.compactConversation(res, compactMatch[1]);
      return true;
    }

    const reviewMatch = url.pathname.match(
      /^\/chat\/conversations\/([a-f0-9-]{36})\/review$/);
    if (req.method === "POST" && reviewMatch) {
      this.startReview(req, res, reviewMatch[1], deviceId);
      return true;
    }

    const approvalMatch = url.pathname.match(
      /^\/chat\/conversations\/([a-f0-9-]{36})\/approvals\/([a-f0-9-]{36})$/);
    if (req.method === "POST" && approvalMatch) {
      this.resolveApproval(req, res, approvalMatch[1], approvalMatch[2], deviceId);
      return true;
    }

    const conversationMatch = url.pathname.match(/^\/chat\/conversations\/([a-f0-9-]{36})$/);
    if (req.method === "GET" && conversationMatch) {
      const limit = url.searchParams.get("limit");
      if (limit !== null && !/^[1-9]\d*$/.test(limit)) {
        this.sendJson(res, 400, { error: "分页参数无效" });
        return true;
      }
      const conversation = limit === null ? this.readConversation(conversationMatch[1])
        : this.store.loadPage(conversationMatch[1], { limit: Math.min(100, Number(limit)) });
      if (!conversation || conversation.archived) {
        this.sendJson(res, 404, { error: "对话不存在" });
        return true;
      }
      this.sendJson(res, 200, { conversation: this.publicConversation(conversation) });
      return true;
    }
    if (req.method === "PATCH" && conversationMatch) {
      this.updateConversationSettings(req, res, conversationMatch[1]);
      return true;
    }
    if (req.method === "DELETE" && conversationMatch) {
      const conversation = this.readConversation(conversationMatch[1]);
      if (!conversation) {
        this.sendJson(res, 404, { error: "对话不存在" });
        return true;
      }
      conversation.archived = true;
      conversation.updatedAt = new Date().toISOString();
      this.writeConversation(conversation);
      this.sendJson(res, 200, { ok: true });
      return true;
    }

    this.sendJson(res, 404, { error: "聊天接口不存在" });
    return true;
  }

  forkConversation(req, res, conversationId) {
    this.readJsonBody(req, 8 * 1024, (error, body) => {
      if (error) { this.sendJson(res, 400, { error: error.message }); return; }
      const source = this.readConversation(conversationId);
      if (!source || source.archived) {
        this.sendJson(res, 404, { error: "对话不存在" });
        return;
      }
      if (this.active?.conversationId === conversationId) {
        this.sendJson(res, 409, { error: "当前轮次完成后才能创建分支" });
        return;
      }
      void (async () => {
        try {
          const client = await this.resumeOnClient(source);
          const requestedTurnId = String(body?.lastTurnId || "");
          const params = { threadId: source.codexThreadId };
          if (requestedTurnId) params.lastTurnId = requestedTurnId;
          const result = await client.request("thread/fork", params);
          const now = new Date().toISOString();
          const conversation = structuredClone(source);
          conversation.id = crypto.randomUUID();
          conversation.codexThreadId = result.thread.id;
          conversation.forkedFromConversationId = source.id;
          conversation.forkedFromThreadId = source.codexThreadId;
          conversation.title = `${source.title} · 分支`.slice(0, 60);
          conversation.createdAt = now;
          conversation.updatedAt = now;
          conversation.archived = false;
          if (requestedTurnId) {
            const lastIndex = conversation.messages.findIndex(
              (message) => message.codexTurnId === requestedTurnId);
            if (lastIndex >= 0) conversation.messages = conversation.messages.slice(0, lastIndex + 1);
          }
          this.writeConversation(conversation);
          this.sendJson(res, 201, { conversation: this.publicConversation(conversation) });
        } catch (forkError) {
          this.sendJson(res, 500, { error: forkError.message || "无法创建对话分支" });
        }
      })();
    });
  }

  compactConversation(res, conversationId) {
    const conversation = this.readConversation(conversationId);
    if (!conversation || conversation.archived) {
      this.sendJson(res, 404, { error: "对话不存在" });
      return;
    }
    if (this.active?.conversationId === conversationId) {
      this.sendJson(res, 409, { error: "当前轮次完成后才能压缩上下文" });
      return;
    }
    void (async () => {
      try {
        const client = await this.resumeOnClient(conversation);
        await client.request("thread/compact/start", { threadId: conversation.codexThreadId });
        conversation.contextCompaction = {
          status: "requested", requestedAt: new Date().toISOString(),
        };
        conversation.updatedAt = new Date().toISOString();
        this.writeConversation(conversation);
        this.sendJson(res, 202, { ok: true, conversation: this.publicConversation(conversation) });
      } catch (compactError) {
        this.sendJson(res, 500, { error: compactError.message || "无法压缩上下文" });
      }
    })();
  }

  startReview(req, res, conversationId, deviceId = "legacy") {
    this.readJsonBody(req, 8 * 1024, (error, body) => {
      if (error) { this.sendJson(res, 400, { error: error.message }); return; }
      const conversation = this.readConversation(conversationId);
      if (!conversation || conversation.archived) {
        this.sendJson(res, 404, { error: "对话不存在" });
        return;
      }
      if (this.active) {
        this.sendJson(res, 409, { error: "另一项任务正在执行，请稍后再审查" });
        return;
      }
      let target = { type: "uncommittedChanges" };
      const requestedType = String(body?.type || "uncommittedChanges");
      if (requestedType === "custom") {
        const instructions = String(body?.instructions || "").trim().slice(0, 4000);
        if (!instructions) { this.sendJson(res, 400, { error: "请输入审查要求" }); return; }
        target = { type: "custom", instructions };
      } else if (requestedType === "baseBranch") {
        const branch = String(body?.branch || "").trim().slice(0, 200);
        if (!branch) { this.sendJson(res, 400, { error: "请输入基准分支" }); return; }
        target = { type: "baseBranch", branch };
      } else if (requestedType === "commit") {
        const sha = String(body?.sha || "").trim();
        if (!/^[0-9a-f]{7,40}$/.test(sha)) {
          this.sendJson(res, 400, { error: "提交编号无效" }); return;
        }
        target = { type: "commit", sha, title: String(body?.title || "").slice(0, 200) };
      } else if (requestedType !== "uncommittedChanges") {
        this.sendJson(res, 400, { error: "不支持这个审查目标" }); return;
      }
      void (async () => {
        try {
          const client = await this.resumeOnClient(conversation);
          const now = new Date().toISOString();
          const assistant = {
            id: crypto.randomUUID(), role: "assistant", text: "", attachments: [],
            createdAt: now, startedAt: now, status: "running",
            activity: [{ type: "review", label: "正在审查代码", status: "running" }],
            stream: [], review: true,
          };
          conversation.messages.push(assistant);
          conversation.updatedAt = now;
          this.writeConversation(conversation);
          this.active = {
            conversationId, messageId: assistant.id, userId: null, client,
            ownerDeviceId: deviceId,
            threadId: conversation.codexThreadId, turnId: null, turnStarted: false,
            finalResponse: "", finished: false, pendingSteers: [],
            pendingApprovals: new Map(), codexHome: this.profileFor(conversation).codexHome,
            mode: "review",
          };
          const result = await client.request("review/start", {
            threadId: conversation.codexThreadId, delivery: "inline", target,
          });
          this.active.turnId = result.turn?.id || null;
          assistant.codexTurnId = this.active.turnId;
          this.writeConversation(conversation);
          this.sendJson(res, 202, { conversation: this.publicConversation(conversation) });
        } catch (reviewError) {
          if (this.active?.conversationId === conversationId) {
            this.failActive(reviewError.message || "无法启动代码审查");
          }
          if (!res.headersSent) this.sendJson(res, 500, { error: reviewError.message || "无法启动代码审查" });
        }
      })();
    });
  }

  updateConversationSettings(req, res, conversationId) {
    this.readJsonBody(req, 16 * 1024, (error, body) => {
      if (error) {
        this.sendJson(res, 400, { error: error.message });
        return;
      }
      const conversation = this.readConversation(conversationId);
      if (!conversation || conversation.archived) {
        this.sendJson(res, 404, { error: "对话不存在" });
        return;
      }
      const hasPinned = Object.hasOwn(body || {}, "pinned");
      const hasProject = Object.hasOwn(body || {}, "project");
      if ((hasPinned && typeof body.pinned !== "boolean") ||
          (hasProject && (typeof body.project !== "string" || body.project.length > 80 || /[\x00-\x1f]/.test(body.project)))) {
        this.sendJson(res, 400, { error: "置顶或项目分组格式无效" });
        return;
      }
      const metadataOnly = (hasPinned || hasProject) && Object.keys(body).every((key) =>
        key === "pinned" || key === "project");
      if (metadataOnly) {
        if (hasPinned) conversation.pinned = body.pinned;
        if (hasProject) conversation.project = body.project.trim();
        conversation.updatedAt = new Date().toISOString();
        this.writeConversation(conversation);
        this.sendJson(res, 200, { conversation: this.publicConversation(conversation) });
        return;
      }
      if (this.remoteWorkspaceBinding(conversation)) {
        this.sendJson(res, 409, {
          error: "远程工作区已固定绑定设备、项目根目录、Harness 与模型；请创建新工作区。",
          remoteWorkspaceLocked: true,
        });
        return;
      }
      const requestedModel = body?.model == null
        ? this.displayModel(conversation, this.profileFor(conversation).id)
        : body.model;
      if (this.sub2api && String(requestedModel).startsWith("gpt-")) {
        try { createSub2ApiRoute({ model: requestedModel, sub2api: this.sub2api }); }
        catch (routeError) {
          const unsupported = routeError.code === "unsupported_sub2api_model_route";
          this.sendJson(res, 400, {
            error: unsupported ? "该 GPT 型号没有配置 Sub2API 分组路由" :
              routeError.code === "sub2api_group_key_missing"
                ? `Sub2API ${routeError.group} 分组凭据未配置`
                : "Sub2API 路由配置不完整",
            blockReason: routeError.code,
            model: String(requestedModel),
          });
          return;
        }
      }
      // Selecting a paused runtime is refused explicitly, for every role, so the
      // client can show why instead of a generic validation error.
      if (body?.model != null) {
        const blockReason = this.modelBlockReason(body.model);
        if (blockReason) {
          this.sendJson(res, 409, {
            error: `该模型不可用于新回合（${blockReason}）：${String(body.model)}`,
            blockReason,
            model: String(body.model),
          });
          return;
        }
      }
      const requestedReasoning = body?.reasoning == null
        ? (ALLOWED_REASONING.has(conversation.reasoning) ? conversation.reasoning : "medium")
        : body.reasoning;
      const requestedAccess = body?.accessMode == null
        ? (ALLOWED_ACCESS.has(conversation.accessMode)
          ? conversation.accessMode : "danger-full-access")
        : body.accessMode;
      if (!this.modelAllowed(requestedModel, this.profileFor(conversation).id) ||
          !ALLOWED_REASONING.has(requestedReasoning) ||
          !ALLOWED_ACCESS.has(requestedAccess)) {
        this.sendJson(res, 400, { error: "模型、智能程度或访问权限不可用" });
        return;
      }
      // An absent harness means "let the resolver decide" so that changing only the
      // model is still checked against the harness the session is bound to.
      const requestedHarness = body?.harness == null || body.harness === ""
        ? "auto" : String(body.harness);
      const nextHarness = requestedHarness === "auto"
        ? resolveHarness(requestedModel, "auto")
        : requestedHarness;
      if (!HARNESSES[nextHarness]) {
        this.sendJson(res, 400, { error: "Harness 不可用" });
        return;
      }
      const modelHarness = resolveHarness(requestedModel, "auto");
      if (nextHarness !== modelHarness) {
        this.sendJson(res, 400, {
          error: "模型与 Harness 不匹配：Grok 必须使用 Grok Build，GPT 必须使用 Codex。",
          blockReason: "model_harness_mismatch",
          expectedHarness: modelHarness,
        });
        return;
      }
      const boundHarness = conversation.harnessId
        || resolveHarness(conversation.model, "auto");
      // Either runtime binding counts as existing context: a Codex thread or a
      // non-Codex harness session. A bound session is never migrated silently.
      const hasRuntimeContext = Boolean(conversation.codexThreadId || conversation.harnessSessionId);
      if (hasRuntimeContext && nextHarness !== boundHarness) {
        this.sendJson(res, 409, {
          error: "Harness changed. Start a new session or branch this session; the current session stays bound.",
          harnessChanged: true,
          currentHarness: boundHarness,
          nextHarness,
        });
        return;
      }
      if (conversation.messages.some((message) =>
        message.status === "queued" || message.status === "running")) {
        this.sendJson(res, 409, { error: "当前对话正在处理，完成后再切换" });
        return;
      }
      const providerChanged = this.modelProviderIdentity(requestedModel) !==
        this.modelProviderIdentity(conversation.model);
      const legacyCodexThread = Boolean(conversation.codexThreadId && this.sub2api &&
        SUB2API_CODEX_MODELS[requestedModel] && conversation.providerId !== "sub2api");
      if (conversation.codexThreadId && (providerChanged || legacyCodexThread)) {
        conversation.codexThreadId = null;
        conversation.replayHistoryOnNextTurn = true;
      }
      let requestedWorkDir = Object.hasOwn(conversation, "workDir")
        ? conversation.workDir : this.codexWorkDir;
      if (Object.hasOwn(body || {}, "workDir")) {
        try {
          requestedWorkDir = this.normalizeWorkDir(body.workDir);
        } catch (workDirError) {
          this.sendJson(res, 400, { error: workDirError.message || "项目目录不可用" });
          return;
        }
      }
      let requestedProfile = this.profileFor(conversation);
      if (Object.hasOwn(body || {}, "codexProfile")) {
        requestedProfile = this.codexProfiles[String(body.codexProfile || "")];
        if (!requestedProfile) {
          this.sendJson(res, 400, { error: "Codex 账号不可用" });
          return;
        }
        if (!this.allowedCodexProfiles.has(requestedProfile.id)) {
          this.sendJson(res, 403, { error: "该用户不能使用这个 Codex 账号" });
          return;
        }
        if (conversation.codexThreadId &&
            requestedProfile.id !== this.profileFor(conversation).id) {
          this.sendJson(res, 409, { error: "已有上下文的对话不能切换 Codex 账号" });
          return;
        }
        if (!conversation.codexThreadId && !Object.hasOwn(body || {}, "workDir")) {
          requestedWorkDir = requestedProfile.id === "default" ? "" : requestedProfile.workDir;
        }
      }
      conversation.model = requestedModel;
      conversation.providerId = this.sub2api && SUB2API_CODEX_MODELS[requestedModel]
        ? "sub2api" : providerForModel(requestedModel);
      conversation.harnessId = nextHarness;
      conversation.reasoning = requestedReasoning;
      conversation.accessMode = requestedAccess;
      conversation.workDir = requestedWorkDir;
      conversation.codexProfile = requestedProfile.id;
      if (hasPinned) conversation.pinned = body.pinned;
      if (hasProject) conversation.project = body.project.trim();
      conversation.updatedAt = new Date().toISOString();
      this.writeConversation(conversation);
      this.sendJson(res, 200, { conversation: this.publicConversation(conversation) });
    });
  }

  createMessage(req, res, conversationId, deviceId = "legacy") {
    this.readJsonBody(req, 64 * 1024, async (error, body) => {
      if (error) {
        this.sendJson(res, 400, { error: error.message });
        return;
      }
      if (this.workerClient) await this.recovery;
      const conversation = this.readConversation(conversationId);
      if (!conversation || conversation.archived) {
        this.sendJson(res, 404, { error: "对话不存在" });
        return;
      }
      if (!this.profileAllowed(conversation)) {
        this.sendJson(res, 403, { error: "该对话属于未授权的 Codex 账号，请新建玄遇对话" });
        return;
      }
      const text = String(body?.text || "").trim();
      const attachmentIds = Array.isArray(body?.attachmentIds)
        ? [...new Set(body.attachmentIds.map(String))].slice(0, 8)
        : [];
      const clientRequestId = String(body?.clientRequestId || "");
      if (clientRequestId && !/^[a-zA-Z0-9_-]{8,128}$/.test(clientRequestId)) {
        this.sendJson(res, 400, { error: "消息请求标识无效" });
        return;
      }
      const requestFingerprint = crypto.createHash("sha256")
        .update(JSON.stringify({ text, attachmentIds })).digest("hex");
      if (clientRequestId) {
        const duplicate = conversation.messages.find((message) => message.role === "user" &&
          message.senderDeviceId === deviceId && message.clientRequestId === clientRequestId);
        if (duplicate) {
          if (duplicate.requestFingerprint !== requestFingerprint) {
            this.sendJson(res, 409, { error: "该发送标识已用于另一条消息，请重新发送" });
          } else {
            this.sendJson(res, 200, { conversation: this.publicConversation(conversation),
              messageId: duplicate.id, duplicate: true, steered: Boolean(duplicate.steeredInto) });
          }
          return;
        }
      }
      if (this.quotaExhausted) {
        this.sendJson(res, 429, { error: QUOTA_EXHAUSTED_MESSAGE });
        return;
      }
      const attachments = attachmentIds.map((id) => this.readUpload(id)).filter(Boolean);
      if (!text && !attachments.length) {
        this.sendJson(res, 400, { error: "请输入消息或添加附件" });
        return;
      }
      if (Buffer.byteLength(text, "utf8") > 48 * 1024) {
        this.sendJson(res, 413, { error: "消息内容过长" });
        return;
      }
      const now = new Date().toISOString();
      const userMessage = {
        id: crypto.randomUUID(),
        role: "user",
        text,
        senderDeviceId: deviceId,
        ...(clientRequestId ? { clientRequestId, requestFingerprint } : {}),
        attachments: attachments.map(({ path: ignored, ...attachment }) => attachment),
        createdAt: now,
        status: "queued",
      };
      const activeAssistant = !["grok-build", "google-antigravity"].includes(this.active?.harnessId) &&
          this.active?.conversationId === conversation.id && this.active?.ownerDeviceId === deviceId
        ? conversation.messages.find((message) =>
          message.id === this.active.messageId && message.role === "assistant")
        : null;
      const queuedAfterGrok = ["grok-build", "google-antigravity"].includes(this.active?.harnessId) &&
        this.active?.conversationId === conversation.id;
      if (activeAssistant) {
        userMessage.status = "running";
        userMessage.steeredInto = activeAssistant.id;
        userMessage.steerAtStreamIndex = Array.isArray(activeAssistant.stream)
          ? activeAssistant.stream.length
          : 0;
        conversation.messages.push(userMessage);
        this.addActivity(activeAssistant, "steer", "已接收补充要求，正在调整处理方向", "completed");
        conversation.updatedAt = now;
        this.writeConversation(conversation);
        if (clientRequestId) this.store.save(conversation, { immediate: true });
        const inputs = this.buildInputs(conversation, userMessage, attachments, false);
        const pending = !this.active.turnId || !this.active.turnStarted;
        this.sendJson(res, 202, {
          conversation: this.publicConversation(conversation),
          messageId: userMessage.id,
          steered: true,
          pending,
        });
        if (pending) {
          this.active.pendingSteers.push({ userMessageId: userMessage.id, inputs });
        } else {
          this.sendSteer(userMessage.id, inputs);
        }
        return;
      }
      const assistantMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        text: "",
        attachments: [],
        createdAt: now,
        status: "queued",
        activity: [{ type: "queue",
          label: queuedAfterGrok ? "补充要求已排队，将在当前回合结束后处理" : "消息已送达服务器",
          status: "completed" }],
        replyTo: userMessage.id,
      };
      conversation.messages.push(userMessage, assistantMessage);
      if (conversation.messages.filter((message) => message.role === "user").length === 1) {
        const titleSource = text || attachments[0]?.name || "附件对话";
        conversation.title = titleSource.replace(/\s+/g, " ").slice(0, 28);
      }
      conversation.updatedAt = now;
      this.writeConversation(conversation);
      if (clientRequestId) this.store.save(conversation, { immediate: true });
      this.sendJson(res, 202, {
        conversation: this.publicConversation(conversation),
        messageId: userMessage.id,
      });
      setImmediate(() => this.runNext());
    });
  }

  async readAccountUsage(res, conversationId = null) {
    if (this.readConversation(conversationId)) this.lastUsageConversationId = conversationId;
    if (this.quotaExhausted) {
      this.sendJson(res, 200, this.withConversationUsage({
        summary: {
          lifetimeTokens: 0, peakDailyTokens: 0, longestRunningTurnSec: 0,
          currentStreakDays: 0, longestStreakDays: 0,
        },
        dailyUsageBuckets: [],
        rateLimits: {
          planType: "",
          primary: { usedPercent: 100, windowDurationMins: 0, resetsAt: 0 },
          secondary: null,
          resetCredits: 0,
        },
      }, conversationId));
      return;
    }
    const conversation = this.readConversation(conversationId);
    const storedProfile = this.profileFor(conversation);
    const profile = this.allowedCodexProfiles.has(storedProfile.id)
      ? storedProfile : this.codexProfiles[this.defaultCodexProfile];
    const usageCache = this.usageCache.get(profile.id);
    if (usageCache && Date.now() - usageCache.cachedAt < 5 * 60 * 1000) {
      this.sendJson(res, 200, this.withConversationUsage(usageCache.payload, conversationId));
      return;
    }
    const client = new AppServerClient({
      codexBin: this.codexBin,
      cwd: profile.workDir,
      home: "/home/ubuntu",
      codexHome: profile.codexHome,
    });
    try {
      await client.start();
      const usage = await client.request("account/usage/read", {});
      const summary = usage?.summary || {};
      const rate = await client.request("account/rateLimits/read", {});
      const limits = rate?.rateLimitsByLimitId?.codex || rate?.rateLimits || {};
      const window = (value) => value ? {
        usedPercent: Math.max(0, Math.min(100, Number(value.usedPercent || 0))),
        windowDurationMins: Number(value.windowDurationMins || 0),
        resetsAt: Number(value.resetsAt || 0),
      } : null;
      const payload = {
        summary: {
          lifetimeTokens: Number(summary.lifetimeTokens || 0),
          peakDailyTokens: Number(summary.peakDailyTokens || 0),
          longestRunningTurnSec: Number(summary.longestRunningTurnSec || 0),
          currentStreakDays: Number(summary.currentStreakDays || 0),
          longestStreakDays: Number(summary.longestStreakDays || 0),
        },
        dailyUsageBuckets: Array.isArray(usage?.dailyUsageBuckets)
          ? usage.dailyUsageBuckets
            .filter((bucket) => /^\d{4}-\d{2}-\d{2}$/.test(String(bucket?.startDate || "")))
            .map((bucket) => ({
              startDate: String(bucket.startDate),
              tokens: Math.max(0, Number(bucket.tokens || 0)),
            }))
          : [],
        rateLimits: {
          planType: String(limits.planType || ""),
          primary: window(limits.primary),
          secondary: window(limits.secondary),
          resetCredits: Math.max(0, Number(rate?.rateLimitResetCredits?.availableCount || 0)),
        },
      };
      this.usageCache.set(profile.id, { cachedAt: Date.now(), payload });
      this.sendJson(res, 200, this.withConversationUsage(payload, conversationId));
    } catch (error) {
      this.sendJson(res, 502, {
        error: `暂时无法读取 Token 用量：${String(error.message || error).slice(0, 160)}`,
      });
    } finally {
      client.close();
    }
  }

  withConversationUsage(payload, conversationId) {
    const conversation = this.readConversation(conversationId);
    return {
      ...payload,
      context: this.quotaExhausted ? { usedTokens: 1, contextWindow: 1 } :
        (conversation?.contextUsage?.source === "last-input" ? conversation.contextUsage : null),
    };
  }

  async consumeRateLimitReset(res, conversationId = null) {
    if (this.quotaExhausted) {
      this.sendJson(res, 429, { error: QUOTA_EXHAUSTED_MESSAGE });
      return;
    }
    const conversation = this.readConversation(conversationId || this.lastUsageConversationId);
    const storedProfile = this.profileFor(conversation);
    const profile = this.allowedCodexProfiles.has(storedProfile.id)
      ? storedProfile : this.codexProfiles[this.defaultCodexProfile];
    const client = new AppServerClient({
      codexBin: this.codexBin,
      cwd: profile.workDir,
      home: "/home/ubuntu",
      codexHome: profile.codexHome,
    });
    try {
      await client.start();
      const latestLimits = await client.request("account/rateLimits/read", {});
      const resetCredits = latestLimits?.rateLimitResetCredits;
      const availableCount = Math.max(0, Number(resetCredits?.availableCount || 0));
      if (!availableCount) {
        this.usageCache.delete(profile.id);
        this.sendJson(res, 409, {
          error: "该账号当前没有可用的重置额度，额度信息已刷新",
          code: "RATE_LIMIT_RESET_UNAVAILABLE",
        });
        return;
      }
      const availableCredit = Array.isArray(resetCredits?.credits)
        ? resetCredits.credits.find((credit) => credit?.status === "available" && credit?.id)
        : null;
      const params = { idempotencyKey: crypto.randomUUID() };
      if (availableCredit) params.creditId = String(availableCredit.id);
      const result = await client.request("account/rateLimitResetCredit/consume", params);
      this.usageCache.delete(profile.id);
      this.sendJson(res, 200, {
        outcome: String(result?.outcome || "noCredit"),
        codexProfile: profile.id,
      });
    } catch (error) {
      this.usageCache.delete(profile.id);
      const detail = String(error.message || error);
      if (/\b429\b|Too Many Requests/i.test(detail)) {
        this.sendJson(res, 409, {
          error: "重置额度状态已变化或兑换暂时受限，额度信息已刷新，请稍后再试",
          code: "RATE_LIMIT_RESET_REJECTED",
        });
      } else {
        this.sendJson(res, 502, { error: `无法使用重置额度：${detail.slice(0, 160)}` });
      }
    } finally {
      client.close();
    }
  }

  async interruptConversation(res, conversationId, deviceId = "legacy") {
    const conversation = this.readConversation(conversationId);
    if (!conversation || conversation.archived) {
      this.sendJson(res, 404, { error: "对话不存在" });
      return;
    }
    const current = this.ensureActiveFor(conversationId);
    if (!current || current.conversationId !== conversationId || current.finished) {
      this.sendJson(res, 409, { error: "当前对话没有正在执行的任务" });
      return;
    }
    if (current.ownerDeviceId && current.ownerDeviceId !== deviceId) {
      this.sendJson(res, 409, { error: "这一轮由另一台设备发起，不能从当前设备暂停" });
      return;
    }
    current.interruptRequested = true;
    if (current.isWorker && this.workerClient) {
      const result = await this.workerClient.interruptTurn(conversationId, current.messageId);
      if (!result.ok) {
        current.interruptRequested = false;
        this.sendJson(res, 503, { error: "执行服务未确认取消，请稍后重试" });
        return;
      }
      if (result.data?.status === "interrupted") this.completeWorkerTurn(current.messageId, result.data);
      this.store.evict?.(conversationId);
      const freshConv = this.readConversation(conversationId, { forceFresh: true }) || conversation;
      this.sendJson(res, 202, {
        ok: true,
        conversation: this.publicConversation(freshConv),
      });
      return;
    }
    const assistant = conversation.messages.find((message) => message.id === current.messageId);
    if (assistant) {
      this.addActivity(assistant, "pause", "正在暂停当前执行", "running");
      conversation.updatedAt = new Date().toISOString();
      this.writeConversation(conversation);
    }
    this.requestActiveInterrupt();
    this.sendJson(res, 202, {
      ok: true,
      conversation: this.publicConversation(conversation),
    });
  }

  requestActiveInterrupt() {
    const current = this.active;
    if (!current?.interruptRequested || current.interruptSent || current.finished) return;
    // Non-Codex harnesses cancel by signalling the child process.
    if (current.harnessAdapter && current.harnessHandle) {
      current.interruptSent = true;
      try {
        current.harnessAdapter.cancel(current.harnessHandle);
      } catch (error) {
        current.interruptSent = false;
        current.interruptRequested = false;
        this.failActive(`暂停失败：${String(error.message || error).slice(0, 120)}`);
      }
      return;
    }
    if (!current.threadId || !current.turnId) return;
    current.interruptSent = true;
    current.client.request("turn/interrupt", {
      threadId: current.threadId,
      turnId: current.turnId,
    }).catch((error) => {
      if (!this.active || this.active.messageId !== current.messageId) return;
      current.interruptSent = false;
      current.interruptRequested = false;
      const conversation = this.readConversation(current.conversationId);
      const assistant = conversation?.messages.find((message) => message.id === current.messageId);
      if (assistant) {
        this.addActivity(
          assistant, "pause", `暂停失败：${String(error.message || error).slice(0, 100)}`, "failed");
        conversation.updatedAt = new Date().toISOString();
        this.writeConversation(conversation);
      }
    });
  }

  failSteer(conversationId, userMessageId, error) {
    const conversation = this.readConversation(conversationId);
    if (!conversation) return;
    const user = conversation.messages.find((message) => message.id === userMessageId);
    const assistant = conversation.messages.find((message) => message.id === this.active?.messageId);
    const detail = String(error.message || error);
    if (user && /no active turn|not steerable|active turn/i.test(detail) &&
        !conversation.messages.some((message) => message.replyTo === userMessageId)) {
      user.status = "queued";
      delete user.steeredInto;
      conversation.messages.push({
        id: crypto.randomUUID(),
        role: "assistant",
        text: "",
        attachments: [],
        createdAt: new Date().toISOString(),
        status: "queued",
        activity: [{
          type: "queue",
          label: "上一轮刚刚结束，补充要求已自动转为下一轮",
          status: "completed",
        }],
        replyTo: userMessageId,
      });
      if (assistant) this.addActivity(
        assistant, "steer", "补充要求已衔接到下一轮", "completed");
      conversation.updatedAt = new Date().toISOString();
      this.writeConversation(conversation);
      setImmediate(() => this.runNext());
      return;
    }
    if (user) user.status = "failed";
    if (assistant) this.addActivity(
      assistant, "steer", `补充要求未能送达：${detail.slice(0, 100)}`, "failed");
    conversation.updatedAt = new Date().toISOString();
    this.writeConversation(conversation);
  }

  sendSteer(userMessageId, inputs) {
    const current = this.active;
    if (!current?.turnId || !current.threadId || !current.turnStarted) return;
    current.client.request("turn/steer", {
      threadId: current.threadId,
      expectedTurnId: current.turnId,
      input: inputs,
      clientUserMessageId: userMessageId,
    }).catch((error) => this.failSteer(current.conversationId, userMessageId, error));
  }

  flushPendingSteers() {
    if (!this.active?.turnStarted || !this.active.turnId) return;
    const pendingSteers = this.active.pendingSteers.splice(0);
    for (const pendingSteer of pendingSteers) {
      this.sendSteer(pendingSteer.userMessageId, pendingSteer.inputs);
    }
  }

  async recover() {
    for (const metadata of this.store.listMetadata()) {
      const conversation = this.readConversation(metadata.id);
      if (!conversation) continue;
      if (this.workerClient && ["google-antigravity", "grok-build"].includes(conversation.harnessId) &&
          !this.remoteWorkspaceBinding(conversation)) {
        const running = conversation.messages.findLast((message) => message.role === "assistant" && message.status === "running");
        if (running) {
          const status = await this.workerClient.getTurnStatus(conversation.id, running.id);
          if (status?.unavailable) {
            this.resumeWorkerTurn(conversation, running);
            continue;
          }
          if (status?.ok) {
            if (status.status === "running") this.resumeWorkerTurn(conversation, running);
            continue;
          }
          // A durable Worker registers the task key before executing anything.
          // If restart happened before registration, the same key can be sent
          // again without replaying an already accepted task.
          if (!status && running.workerDispatchPending) {
            running.status = "queued";
            const user = conversation.messages.find((message) => message.id === running.replyTo);
            if (user) user.status = "queued";
            this.writeConversation(conversation);
            continue;
          }
        }
      }
      let changed = false;
      for (let index = 0; index < conversation.messages.length; index += 1) {
        const message = conversation.messages[index];
        if (message.role === "assistant" && message.status === "running") {
          let workerStatus = null;
          if (this.workerClient && ["google-antigravity", "grok-build"].includes(conversation.harnessId) &&
              !this.remoteWorkspaceBinding(conversation)) {
            try {
              workerStatus = await this.workerClient.getTurnStatus(conversation.id, message.id);
            } catch {}
          }
          if (workerStatus && workerStatus.ok && workerStatus.status === "running") {
            // Worker is still running this task! Keep running and resume subscription!
            this.resumeWorkerTurn(conversation, message);
            changed = false;
            break;
          }
          if (workerStatus && workerStatus.ok && (workerStatus.status === "completed" || workerStatus.status === "interrupted")) {
            this.store.evict?.(conversation.id);
            changed = false;
            break;
          }

          // Process truly interrupted
          message.status = "failed";
          message.completedAt = new Date().toISOString();
          message.text = "服务重启时本轮中断，执行结果无法确认。请先检查工作区，再决定是否重新提交任务。";
          message.stream = Array.isArray(message.stream) ? message.stream : [];
          for (const entry of message.stream) {
            if (entry.status === "running") entry.status = "failed";
          }
          for (const activity of message.activity || []) {
            if (activity.status === "running") activity.status = "failed";
          }
          changed = true;
          continue;
        }
        for (const entry of message.stream || []) {
          if (entry.kind === "approval" && entry.status === "pending") {
            const parentAssistant = conversation.messages.find((m) => m.id === message.id);
            if (parentAssistant && parentAssistant.status === "running") {
              continue; // Keep approval pending!
            }
            entry.status = "expired";
            entry.resolvedAt = new Date().toISOString();
            changed = true;
          }
        }
        if (message.role === "user" && message.status === "running") {
          message.status = "failed";
          changed = true;
          continue;
        }
        if (message.role !== "user" ||
            (message.status !== "queued" && message.status !== "running")) continue;
        if (message.steeredInto) {
          const target = conversation.messages.find((candidate) =>
            candidate.role === "assistant" && candidate.id === message.steeredInto);
          if (target && ["completed", "interrupted", "failed"].includes(target.status)) {
            message.status = target.status === "failed" ? "failed" : "completed";
            changed = true;
            continue;
          }
          if (target && (target.status === "queued" || target.status === "running")) {
            if (message.status !== "running") {
              message.status = "running";
              changed = true;
            }
            continue;
          }
        }
        const ownReply = conversation.messages.find((candidate) =>
          candidate.role === "assistant" && candidate.replyTo === message.id &&
          (candidate.status === "queued" || candidate.status === "running"));
        if (ownReply) {
          if (message.status !== "queued") {
            message.status = "queued";
            changed = true;
          }
          continue;
        }
        const followingAssistant = conversation.messages.slice(index + 1)
          .find((candidate) => candidate.role === "assistant");
        if (followingAssistant &&
            ["completed", "interrupted", "failed"].includes(followingAssistant.status)) {
          message.status = followingAssistant.status === "failed" ? "failed" : "completed";
          changed = true;
        }
      }
      if (changed) {
        conversation.updatedAt = new Date().toISOString();
        this.writeConversation(conversation);
      }
    }
    setImmediate(() => this.runNext());
  }

  nextQueued() {
    for (const metadata of this.store.listMetadata().reverse()) {
      if (metadata.archived || !metadata.busy) continue;
      const conversation = this.readConversation(metadata.id);
      if (!conversation) continue;
      const assistant = conversation.messages.find((message) =>
        message.role === "assistant" && message.status === "queued");
      if (!assistant) continue;
      const user = conversation.messages.find((message) => message.id === assistant.replyTo);
      if (user) return { conversation, user, assistant };
    }
    return null;
  }

  addActivity(assistant, type, label, status = "running") {
    const last = assistant.activity?.at(-1);
    if (last && last.type === type && last.label === label) {
      last.status = status;
      return;
    }
    assistant.activity = [...(assistant.activity || []), { type, label, status }].slice(-12);
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
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined && value !== null) entry[key] = value;
    }
    return entry;
  }

  approvalChoices(method, params = {}) {
    const makeChoice = (id, label, description, response, outcome = "accepted") => ({
      id, label, description, response, outcome,
    });
    if (method === "item/permissions/requestApproval") {
      const permissions = params.permissions || {};
      return [
        makeChoice(
          "allow-turn", "允许本轮", "只在当前这轮任务中授予请求的权限",
          { permissions, scope: "turn" }),
        makeChoice(
          "allow-session", "在本会话中允许", "本次 Codex 会话内不再重复询问相同权限",
          { permissions, scope: "session" }),
        makeChoice(
          "decline", "拒绝并继续", "不授予权限，让当前 AI 尝试其他做法",
          { permissions: {}, scope: "turn" }, "declined"),
      ];
    }
    if (method === "item/tool/requestUserInput") {
      // User questions always use the structured form so the client can add a
      // free-form "Other" answer and render multiple questions consistently.
      return [];
    }
    if (method === "mcpServer/elicitation/request") {
      const properties = params.requestedSchema?.properties;
      const isConfirmation = params.mode === "url" ||
        ((params.mode === "form" || params.mode === "openai/form") &&
          properties && typeof properties === "object" && !Object.keys(properties).length);
      if (!isConfirmation) return [];
      return [
        makeChoice("mcp-accept", params.mode === "url" ? "已完成并继续" : "允许一次",
          params.mode === "url" ? "确认已完成外部授权流程" : "允许这次连接器操作",
          { action: "accept", content: null, _meta: null }),
        makeChoice("mcp-decline", "拒绝", "不授权，继续当前任务",
          { action: "decline", content: null, _meta: null }, "declined"),
        makeChoice("mcp-cancel", "取消本轮", "取消这次连接器操作",
          { action: "cancel", content: null, _meta: null }, "declined"),
      ];
    }

    const hasAvailableDecisions = method === "item/commandExecution/requestApproval" &&
      Array.isArray(params.availableDecisions) && params.availableDecisions.length > 0;
    let decisions = hasAvailableDecisions
      ? params.availableDecisions
      : ["accept", "acceptForSession"];
    if (method === "item/commandExecution/requestApproval" &&
        !hasAvailableDecisions) {
      if (Array.isArray(params.proposedExecpolicyAmendment) &&
          params.proposedExecpolicyAmendment.length) {
        decisions.push({
          acceptWithExecpolicyAmendment: {
            execpolicy_amendment: params.proposedExecpolicyAmendment,
          },
        });
      }
      for (const amendment of params.proposedNetworkPolicyAmendments || []) {
        decisions.push({
          applyNetworkPolicyAmendment: { network_policy_amendment: amendment },
        });
      }
      decisions.push("decline", "cancel");
    } else if (method === "item/fileChange/requestApproval") {
      decisions = ["accept", "acceptForSession", "decline", "cancel"];
    }

    return decisions.map((decision, index) => {
      const id = `choice-${index + 1}`;
      if (decision === "accept") {
        return makeChoice(id, "允许一次", "仅批准当前这项操作", { decision });
      }
      if (decision === "acceptForSession") {
        return makeChoice(
          id, "在本会话中允许", "相同操作在本次 Codex 会话中不再询问", { decision });
      }
      if (decision === "decline") {
        return makeChoice(
          id, "拒绝并继续", "不执行这项操作，让当前 AI 尝试其他做法",
          { decision }, "declined");
      }
      if (decision === "cancel") {
        return makeChoice(
          id, "拒绝并停止本轮", "不执行操作，并立即停止当前任务",
          { decision }, "declined");
      }
      const execpolicy = decision?.acceptWithExecpolicyAmendment;
      if (Array.isArray(execpolicy?.execpolicy_amendment)) {
        const prefix = execpolicy.execpolicy_amendment.join(" ");
        return makeChoice(
          id, `允许并记住“${prefix.slice(0, 70)}”`,
          "以后匹配这条命令规则的操作不再询问",
          { decision: { acceptWithExecpolicyAmendment: execpolicy } });
      }
      const network = decision?.applyNetworkPolicyAmendment?.network_policy_amendment;
      if (network?.host && (network.action === "allow" || network.action === "deny")) {
        return makeChoice(
          id,
          `${network.action === "allow" ? "始终允许" : "始终拒绝"} ${network.host}`,
          `保存一条${network.action === "allow" ? "允许" : "拒绝"}访问该主机的网络规则`,
          { decision: { applyNetworkPolicyAmendment: { network_policy_amendment: network } } },
          network.action === "allow" ? "accepted" : "declined");
      }
      return null;
    }).filter(Boolean);
  }

  approvalPresentation(method, params = {}) {
    const compact = (value, limit = 1200) => String(value || "").trim().slice(0, limit);
    const network = params.networkApprovalContext || {};
    const requestedPermissions = params.permissions || params.additionalPermissions || {};
    const fileSystem = requestedPermissions.fileSystem || {};
    const readPaths = Array.isArray(fileSystem.read) ? fileSystem.read : [];
    const writePaths = Array.isArray(fileSystem.write) ? fileSystem.write : [];
    const entries = Array.isArray(fileSystem.entries) ? fileSystem.entries : [];
    const pathLabels = entries.map((entry) => {
      const target = entry?.path || {};
      const value = target.path || target.pattern || target.value?.path ||
        target.value?.kind || target.type || "";
      return `${entry?.access || "访问"} ${value}`.trim();
    });
    const permissionParts = [
      requestedPermissions.network?.enabled ? "访问网络" : "",
      ...readPaths.map((item) => `读取 ${item}`),
      ...writePaths.map((item) => `写入 ${item}`),
      ...pathLabels,
    ].filter(Boolean);
    if (method === "item/tool/requestUserInput") {
      const questions = (Array.isArray(params.questions) ? params.questions : [])
        .slice(0, 3).map((question, index) => ({
          id: String(question?.id || `question-${index + 1}`).slice(0, 120),
          header: compact(question?.header || `问题 ${index + 1}`, 120),
          question: compact(question?.question || "请选择如何继续", 500),
          allowOther: Array.isArray(question?.options) && question.options.length > 0,
          isSecret: Boolean(question?.isSecret),
          options: Array.isArray(question?.options)
            ? question.options.slice(0, 12).map((option) => ({
              label: compact(option?.label, 120),
              description: compact(option?.description, 300),
            })) : null,
        }));
      return {
        approvalType: "user_input",
        title: questions.length === 1 ? questions[0]?.header : "需要你的选择",
        reason: questions.length > 1 ? "回答以下问题后，Chloe 会继续当前任务。" : "",
        approvalQuestions: questions,
      };
    }
    if (method === "mcpServer/elicitation/request") {
      const schema = params.requestedSchema && typeof params.requestedSchema === "object"
        ? JSON.parse(JSON.stringify(params.requestedSchema)) : null;
      return {
        approvalType: "mcp",
        title: `${compact(params.serverName || "MCP", 120)} 请求确认`,
        reason: compact(params.message || "连接器需要你的确认才能继续。", 800),
        approvalUrl: params.mode === "url" ? compact(params.url, 1800) : "",
        approvalForm: params.mode === "form" || params.mode === "openai/form" ? schema : null,
        approvalMode: compact(params.mode, 30),
      };
    }
    if (method === "item/commandExecution/requestApproval") {
      const isNetwork = Boolean(network.host);
      return {
        approvalType: isNetwork ? "network" : "command",
        title: isNetwork ? "允许访问网络？" : "允许执行这条命令？",
        reason: compact(params.reason, 500),
        command: compact(params.command, 4000),
        cwd: compact(params.cwd, 800),
        host: compact(network.host, 300),
        protocol: compact(network.protocol, 30),
        permissionSummary: compact(permissionParts.join("\n"), 1800),
      };
    }
    if (method === "item/fileChange/requestApproval") {
      return {
        approvalType: "file",
        title: "允许修改这些文件？",
        reason: compact(params.reason, 500),
        grantRoot: compact(params.grantRoot, 800),
      };
    }
    return {
      approvalType: requestedPermissions.network?.enabled ? "network" : "permissions",
      title: requestedPermissions.network?.enabled ? "允许临时访问网络？" : "允许临时扩展权限？",
      reason: compact(params.reason, 500),
      cwd: compact(params.cwd, 800),
      permissionSummary: compact(permissionParts.join("\n") || "Codex 请求额外操作权限", 1800),
    };
  }

  handleServerRequest(conversationId, messageId, request) {
    const current = this.active;
    if (!current || current.conversationId !== conversationId ||
        current.messageId !== messageId) return;
    const supported = new Set([
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
      "item/tool/requestUserInput",
      "mcpServer/elicitation/request",
    ]);
    if (!supported.has(request.method)) {
      try { current.client.respond(request.id, { decision: "decline" }); } catch {}
      return;
    }
    const conversation = this.readConversation(conversationId);
    const assistant = conversation?.messages.find((message) => message.id === messageId);
    if (!conversation || !assistant) {
      try { current.client.respond(request.id, { decision: "decline" }); } catch {}
      return;
    }
    const approvalId = crypto.randomUUID();
    const choices = this.approvalChoices(request.method, request.params || {});
    const supportsStructuredInput = request.method === "item/tool/requestUserInput" ||
      request.method === "mcpServer/elicitation/request";
    if (!choices.length && !supportsStructuredInput) {
      try { current.client.respond(request.id, { decision: "decline" }); } catch {}
      return;
    }
    current.pendingApprovals.set(approvalId, {
      rpcId: request.id,
      method: request.method,
      params: request.params || {},
      choices: new Map(choices.map((choice) => [choice.id, choice])),
    });
    this.upsertStream(assistant, `approval-${approvalId}`, {
      kind: "approval",
      approvalId,
      status: "pending",
      approvalOptions: choices.map(({ id, label, description, outcome }) => ({
        id, label, description, tone: outcome,
      })),
      ...this.approvalPresentation(request.method, request.params || {}),
    });
    this.addActivity(
      assistant,
      "approval",
      request.method === "item/tool/requestUserInput" ? "等待你的选择" : "等待你确认权限",
      "running",
    );
    conversation.updatedAt = new Date().toISOString();
    this.writeConversation(conversation);
  }

  requestRemoteWorkspaceApproval(binding, approval) {
    const current = this.active;
    if (!current || current.conversationId !== binding.conversation_id || current.finished) {
      throw new Error("REMOTE_WORKSPACE_TURN_NOT_ACTIVE");
    }
    const conversation = this.readConversation(binding.conversation_id);
    const assistant = conversation?.messages.find((message) => message.id === current.messageId);
    if (!conversation || !assistant) throw new Error("REMOTE_WORKSPACE_TURN_NOT_ACTIVE");
    current.pendingApprovals.set(approval.id, {
      kind: "remote-workspace", workspaceId: binding.workspace_id, approvalId: approval.id,
      choices: new Map([
        ["accept", { id: "accept", label: "确认执行", outcome: "accepted" }],
        ["decline", { id: "decline", label: "拒绝", outcome: "declined" }],
      ]),
    });
    this.upsertStream(assistant, `approval-${approval.id}`, {
      kind: "approval", approvalId: approval.id, status: "pending",
      approvalOptions: [
        { id: "accept", label: "确认执行", description: "在客户工作区执行已展示的操作", tone: "accepted" },
        { id: "decline", label: "拒绝", description: "取消本次远程操作", tone: "declined" },
      ],
      title: "等待确认远程工作区操作",
      summary: `${approval.intent.operation} 需要确认后才会在客户电脑执行。`,
      details: { operation: approval.intent.operation, path: approval.intent.args?.path || approval.intent.args?.cwd || null },
    });
    this.addActivity(assistant, "approval", "等待你确认远程工作区操作", "running");
    conversation.updatedAt = new Date().toISOString();
    this.writeConversation(conversation);
  }

  resolveApproval(req, res, conversationId, approvalId, deviceId = "legacy") {
    this.readJsonBody(req, 8 * 1024, async (error, body) => {
      if (error) {
        this.sendJson(res, 400, { error: error.message });
        return;
      }
      const current = this.ensureActiveFor(conversationId);
      if (current?.conversationId === conversationId && current.ownerDeviceId &&
          current.ownerDeviceId !== deviceId) {
        this.sendJson(res, 409, { error: "这一轮由另一台设备发起，请在原设备上确认" });
        return;
      }
      if (current?.isWorker && this.workerClient) {
        const conversation = this.readConversation(conversationId);
        const assistant = conversation?.messages?.find((m) => m.id === current.messageId);
        const entry = assistant?.stream?.find((item) => item.kind === "approval" && item.approvalId === approvalId);
        if (!entry || entry.status !== "pending") {
          this.sendJson(res, 409, { error: "审批请求已处理或已失效" });
          return;
        }
        const decision = String(body?.choiceId || body?.decision || "");
        const result = await this.workerClient.resolveApproval(conversationId, current.messageId, approvalId, decision);
        if (!result.ok) {
          this.sendJson(res, result.status || 503, { error: result.error || "执行服务未确认审批" });
          return;
        }
        this.sendJson(res, 200, { ok: true, conversation: this.publicConversation(this.readConversation(conversationId)) });
        return;
      }
      const pending = current?.conversationId === conversationId
        ? current.pendingApprovals?.get(approvalId) : null;
      if (!pending) {
        this.sendJson(res, 409, { error: "这项权限请求已失效" });
        return;
      }
      const requestedChoice = String(body?.choiceId || body?.decision || "");
      if (pending.kind === "remote-workspace") {
        const accepted = requestedChoice === "accept" || requestedChoice === "allow-turn";
        const declined = requestedChoice === "decline" || requestedChoice === "deny";
        if (!accepted && !declined) {
          this.sendJson(res, 400, { error: "请选择确认或拒绝" });
          return;
        }
        const conversation = this.readConversation(conversationId);
        const assistant = conversation?.messages.find((message) => message.id === current.messageId);
        const entry = assistant?.stream?.find((item) => item.kind === "approval" && item.approvalId === approvalId);
        if (!conversation || !assistant || !entry || !this.remoteWorkspaceService) {
          this.sendJson(res, 409, { error: "这项权限请求已失效" });
          return;
        }
        try {
          this.remoteWorkspaceService.resolveApproval(pending.workspaceId, approvalId, accepted);
        } catch (resolveError) {
          this.sendJson(res, 409, { error: resolveError.code || "这项权限请求已失效" });
          return;
        }
        current.pendingApprovals.delete(approvalId);
        entry.status = accepted ? "accepted" : "declined";
        entry.resolutionLabel = accepted ? "已确认执行" : "已拒绝本次操作";
        entry.resolvedAt = new Date().toISOString();
        this.addActivity(assistant, "approval", entry.resolutionLabel, "completed");
        conversation.updatedAt = new Date().toISOString();
        this.writeConversation(conversation);
        this.sendJson(res, 200, { ok: true, conversation: this.publicConversation(conversation) });
        return;
      }
      let choice = pending.choices?.get(requestedChoice);
      if (!choice && (requestedChoice === "accept" || requestedChoice === "decline")) {
        choice = [...(pending.choices?.values() || [])].find((candidate) =>
          candidate.response?.decision === requestedChoice ||
          (requestedChoice === "accept" && candidate.id === "allow-turn") ||
          (requestedChoice === "decline" && candidate.id === "decline"));
      }
      let response = choice?.response;
      let outcome = choice?.outcome;
      let resolutionLabel = choice?.label;
      if (!choice && (pending.method === "item/tool/requestUserInput" ||
          pending.method === "mcpServer/elicitation/request")) {
        let payload;
        if (body?.answers && typeof body.answers === "object") {
          payload = { answers: body.answers };
        } else {
          try { payload = JSON.parse(requestedChoice); } catch {}
        }
        if (pending.method === "item/tool/requestUserInput") {
          const answers = payload?.answers;
          const questions = Array.isArray(pending.params?.questions) ? pending.params.questions : [];
          const valid = answers && typeof answers === "object" && questions.every((question) => {
            const value = answers[String(question?.id || "answer")]?.answers;
            return Array.isArray(value) && value.length > 0 && value.every((item) =>
              typeof item === "string" && item.length <= 2000);
          });
          if (valid) {
            response = { answers };
            outcome = "accepted";
            resolutionLabel = "已提交选择";
          }
        } else {
          const action = payload?.action;
          if (["accept", "decline", "cancel"].includes(action)) {
            response = {
              action,
              content: action === "accept" && payload.content && typeof payload.content === "object"
                ? payload.content : null,
              _meta: null,
            };
            outcome = action === "accept" ? "accepted" : "declined";
            resolutionLabel = action === "accept" ? "已提交 MCP 表单" :
              action === "cancel" ? "已取消连接器操作" : "已拒绝连接器操作";
          }
        }
      }
      if (!response) {
        this.sendJson(res, 400, {
          error: pending.method === "item/tool/requestUserInput"
            ? "请完成所有问题" : "请选择当前请求提供的操作",
        });
        return;
      }
      const conversation = this.readConversation(conversationId);
      const assistant = conversation?.messages.find((message) => message.id === current.messageId);
      const entry = assistant?.stream?.find((item) =>
        item.kind === "approval" && item.approvalId === approvalId);
      if (!conversation || !assistant || !entry) {
        this.sendJson(res, 409, { error: "找不到这项权限请求" });
        return;
      }
      try {
        current.client.respond(pending.rpcId, response);
      } catch (respondError) {
        this.sendJson(res, 500, { error: respondError.message || "权限确认发送失败" });
        return;
      }
      current.pendingApprovals.delete(approvalId);
      entry.status = outcome;
      entry.resolutionLabel = resolutionLabel;
      entry.resolvedAt = new Date().toISOString();
      this.addActivity(
        assistant, "approval", outcome === "accepted" ? resolutionLabel : "已拒绝本次操作",
        "completed");
      conversation.updatedAt = new Date().toISOString();
      this.writeConversation(conversation);
      this.sendJson(res, 200, {
        ok: true,
        conversation: this.publicConversation(conversation),
      });
    });
  }

  buildDeveloperInstructions(conversation) {
    const remote = this.remoteWorkspaceBinding(conversation);
    if (remote) {
      return [
        "你是 Chloe 的开发助手。Chloe 是当前应用的名称；内部 witt_* MCP 工具名和服务标识保持不变，不代表其他人的 Witt 实例。",
        "以本轮用户请求为准，不自动执行历史开发任务；新对话不自动继承其他对话，只使用实际提供的上下文和当前授权项目的信息。",
        "你正在操作一个 Remote Vibecoding Workspace。客户电脑上的项目只能通过 witt_remote_workspace MCP 工具访问。",
        "本会话已固定绑定到一个客户、一个设备和一个项目根目录；不要索取、猜测或尝试切换 device_id、磁盘路径、网络共享或其他目录。",
        "不要使用本机文件工具、shell、浏览器或 SSH 来替代 workspace MCP；它们不代表客户项目。",
        "先用 workspace_list/read/search/stat 理解代码。修改前读取 SHA-256，写入必须附带刚读取的 SHA-256；patch 必须使用唯一的 before/after 文本。",
        "执行操作只使用 program 加 argv，绝不拼接 shell 命令。遇到需要确认的安装、服务、外部 Git 操作或其他命令时，等待 Chloe 的确认界面，不要尝试绕过。",
        "写入或命令若返回 EXECUTION_STATE_UNKNOWN，立即停止重试，先读取文件和 git diff 重新确认状态。",
        "完成修改后用 workspace_git_status 和 workspace_git_diff 报告实际变化；不要提交、推送或触碰凭据。",
        "回答使用简洁自然的中文，禁止展示、记录或回传任何凭据原文。",
      ].join("\n");
    }
    const workDir = this.effectiveWorkDir(conversation);
    return [
      "你是 Chloe 的开发助手，通过 Chloe 应用运行在用户私人服务器上。Chloe 是本应用的产品名称，不是模型或 CLI 的名称。",
      "本应用与其他人的 Witt 实例独立；内部 witt.service、witt_* 工具名及既有路径保持不变。",
      `固定工作目录：${workDir}`,
      `Chloe 附件目录：${this.dataDir}`,
      "记住用户在本线程中的上下文，回答使用简洁自然的中文。",
      "以用户当前消息为准。普通问候或询问状态时只回答或只读检查，不自行续做旧开发任务，不因历史任务而修改文件或部署。",
      "只将本轮实际提供的历史和当前 CLI 会话上下文视为已知。新对话不自动继承其他对话；服务器保存了记录不等于你已经读过。需要旧任务信息时请用户提供交接摘要，或仅在已有工具与权限允许时读取当前用户明确指定的记录；不要访问其他用户记录。",
      "不得声称已读取历史、已完成测试或已部署，除非有实际证据。任务交接时简要列出目标、已完成与未完成事项、修改文件、验证结果和下一步；不要将密钥写入交接摘要。",
      "只处理用户明确要求的任务，保留现有数据和未提交修改。",
      "禁止展示、记录或回传凭据原文。用户明确授权时，允许认证程序使用指定的本地凭据文件完成认证，不将凭据或生成的 Token 输出到聊天及日志",
      "访问范围由本对话的权限设置决定。删除数据、对外发送消息等不可逆或对外动作仍需先向用户说明。",
      "开发与操作在指定工作区目录内完成，遵循最小修改原则。",
      "修改普通代码后先完成语法或构建校验。严禁在对话执行过程中直接执行 systemctl restart witt.service 或重启 Worker 自身；Chloe 自身的网页更新由开发工作流或独立部署脚本执行，避免打断当前执行。",
      "修改网页界面或浏览器交互后，必须使用 Playwright 浏览器工具在 390×844 手机视口和 1440×900 桌面视口完成真实验收；检查关键交互、布局溢出、控制台错误和页面错误，不能只做源码或静态字符串检查。",
      "删除大量数据、覆盖数据库、修改防火墙或其他难以恢复的操作，执行前仍需向用户明确说明目标和影响。",
      "兼容备用通道：修改 drop-vault 后端但不适合直接重启时，仍可写入 /data/drop-vault/restart-request 请求延迟校验重启。",
      "右上角交付区是用户主动索取文件时使用的下载通道，不是每轮回复存档。",
      "仅当用户明确要求交付、打包、下载，或要求把服务器上的某个文件放入交付区时，才在最终回复末尾逐行输出 [[deliver:/绝对/文件路径]]。普通回答或普通代码修改绝对不要输出该标记。只能交付普通文件，目录需先打包。",
      "用户明确要求制作或展示前端动画、交互网页、网页演示，或要求像 Claude Artifact 一样直接预览时，视为明确要求交付：请创建一个自包含的单文件 .html，且仅在这种情况下在最终回复末尾输出对应 [[deliver:/绝对/文件路径]]。不要使用外部 CDN、远程图片、网络请求或额外本地资源；Chloe 会在独立 Artifact 工作区运行页面，桌面端位于聊天右侧、手机端使用单栏工作区。页面只实现作品内容，不要自行重复宿主的标题栏、版本、预览/源码、复制、下载或返回控件。",
      "制作交互网页时使用 Claude Artifact 式增量预览协议：始终维护同一个自包含 .html 文件；完成第一个可独立运行且结构闭合的版本后，在 commentary 中单独输出 [[preview:/绝对/文件路径]]。此控制行不会展示给用户。之后每次完成一轮可独立运行的界面更新，再输出同一控制行。只有在 HTML、BODY 均完整闭合且当前版本可运行时才能发布；不要发布正在写入的半成品。",
      "Artifact 页面必须响应式适配手机宽度和横竖屏，避免固定桌面画布。聊天中直接展示内容本体，不要在 HTML 内再绘制外层设备框、预览卡标题栏、下载按钮或放大按钮。",
    ].join("\n");
  }

  buildPrompt(conversation, user, attachments) {
    const attachmentText = attachments.length
      ? [
          "",
          "本轮附件（用户已明确授权读取）：",
          ...attachments.map((file) => `- ${file.name}：${file.path}（${file.mimeType}）`),
        ].join("\n")
      : "";
    const userText = user.text || "请查看我附上的文件。";
    if (conversation.replayHistoryOnNextTurn) {
      const history = conversation.messages
        .filter((message) => message.id !== user.id &&
          ["user", "assistant"].includes(message.role) && message.text)
        .map((message) => `${message.role === "user" ? "用户" : "Chloe"}：${message.text}`)
        .join("\n\n")
        .slice(-120_000);
      return [
        this.buildDeveloperInstructions(conversation),
        "",
        "以下是当前 Chloe 会话在切换模型提供商前的历史，请以本轮用户请求为准参考这些记录，不自动执行旧任务：",
        history || "（暂无历史）",
        "",
        `用户：${userText}${attachmentText}`,
      ].join("\n");
    }
    if (conversation.codexThreadId) return `${userText}${attachmentText}`;
    return [
      this.buildDeveloperInstructions(conversation),
      "",
      `用户：${userText}${attachmentText}`,
    ].join("\n");
  }

  buildInputs(conversation, user, attachments, firstTurn) {
    const text = firstTurn
      ? this.buildPrompt(conversation, user, attachments)
      : this.buildPrompt(conversation, user, attachments);
    const inputs = [{ type: "text", text }];
    for (const file of attachments) {
      if (/^image\//.test(file.mimeType)) inputs.push({ type: "localImage", path: file.path });
    }
    return inputs;
  }

  async runNext() {
    await this.recovery;
    if (this.runningNext) return;
    this.runningNext = true;
    try { await this.runNextInternal(); } finally { this.runningNext = false; }
  }

  async runNextInternal() {
    if (this.active) {
      if (this.active.isWorker && this.workerClient) {
        try {
          const workerStatus = await this.workerClient.getTurnStatus(this.active.conversationId, this.active.messageId);
          if (workerStatus?.unavailable) return;
          if (workerStatus?.ok && workerStatus.status !== "running") {
            this.completeWorkerTurn(this.active.messageId, workerStatus);
          } else return;
        } catch {
          return;
        }
      } else {
        return;
      }
    }
    const queued = this.nextQueued();
    if (!queued) return;
    const { conversation, user, assistant } = queued;
    if (!this.profileAllowed(conversation)) {
      const completedAt = new Date().toISOString();
      user.status = "failed";
      assistant.status = "failed";
      assistant.completedAt = completedAt;
      assistant.text = "该对话属于未授权的 Codex 账号，请新建玄遇对话";
      assistant.activity = [{ type: "error", label: assistant.text, status: "failed" }];
      conversation.updatedAt = new Date().toISOString();
      this.writeConversation(conversation);
      setImmediate(() => this.runNext());
      return;
    }
    if (this.quotaExhausted) {
      const completedAt = new Date().toISOString();
      user.status = "failed";
      assistant.status = "failed";
      assistant.completedAt = completedAt;
      assistant.text = QUOTA_EXHAUSTED_MESSAGE;
      assistant.activity = [{ type: "error", label: QUOTA_EXHAUSTED_MESSAGE, status: "failed" }];
      conversation.updatedAt = new Date().toISOString();
      this.writeConversation(conversation);
      setImmediate(() => this.runNext());
      return;
    }
    const attachments = (user.attachments || []).map((file) => this.readUpload(file.id)).filter(Boolean);
    user.status = "running";
    assistant.status = "running";
    if (this.workerClient && !this.remoteWorkspaceBinding(conversation) &&
        ["grok-build", "google-antigravity"].includes(conversation.harnessId)) {
      assistant.workerDispatchPending = true;
    }
    assistant.startedAt = new Date().toISOString();
    assistant.activity = [{ type: "thinking", label: "正在阅读并理解消息", status: "running" }];
    assistant.stream = Array.isArray(assistant.stream) ? assistant.stream : [];
    conversation.updatedAt = new Date().toISOString();
    this.writeConversation(conversation);

    // A paused runtime is reported explicitly. The stored model is never swapped
    // for another harness's model just to keep the turn running.
    const storedModel = String(conversation.model || this.defaultModel);
    const blockedReason = this.modelBlockReason(storedModel);
    if (blockedReason) {
      const completedAt = new Date().toISOString();
      const message = `${storedModel} 不可用于新回合（${blockedReason}），本轮不会改用其他模型。`
        + "请新建会话或选择其他模型。";
      user.status = "failed";
      assistant.status = "failed";
      assistant.completedAt = completedAt;
      assistant.text = message;
      assistant.activity = [{ type: "error", label: message, status: "failed" }];
      conversation.updatedAt = completedAt;
      this.writeConversation(conversation);
      setImmediate(() => this.runNext());
      return;
    }
    if (this.sub2api && storedModel.startsWith("gpt-")) {
      try { createSub2ApiRoute({ model: storedModel, sub2api: this.sub2api }); }
      catch (routeError) {
        const completedAt = new Date().toISOString();
        user.status = "failed";
        assistant.status = "failed";
        assistant.completedAt = completedAt;
        assistant.text = routeError.code === "unsupported_sub2api_model_route"
          ? "该 GPT 模型没有配置 Sub2API 分组路由，本轮未启动。"
          : routeError.code === "sub2api_group_key_missing"
            ? `Sub2API ${routeError.group} 分组凭据未配置，本轮未启动。`
            : "Sub2API 路由配置不完整，本轮未启动。";
        assistant.activity = [{ type: "error", label: assistant.text, status: "failed" }];
        conversation.updatedAt = completedAt;
        this.writeConversation(conversation);
        setImmediate(() => this.runNext());
        return;
      }
      if (!this.modelAllowed(storedModel, this.profileFor(conversation).id)) {
        const completedAt = new Date().toISOString();
        user.status = "failed";
        assistant.status = "failed";
        assistant.completedAt = completedAt;
        assistant.text = "当前账号或服务器环境未开放此 Sub2API 模型，本轮未启动。";
        assistant.activity = [{ type: "error", label: assistant.text, status: "failed" }];
        conversation.updatedAt = completedAt;
        this.writeConversation(conversation);
        setImmediate(() => this.runNext());
        return;
      }
    }
    const model = this.modelAllowed(storedModel, this.profileFor(conversation).id)
      ? storedModel : this.defaultModel;
    const reasoning = ALLOWED_REASONING.has(conversation.reasoning) ? conversation.reasoning : "medium";
    const accessMode = ALLOWED_ACCESS.has(conversation.accessMode)
      ? conversation.accessMode : "danger-full-access";
    const workDir = this.effectiveWorkDir(conversation);
    const remoteWorkspace = this.remoteWorkspaceBinding(conversation);
    let gitBaseline = null;
    let gitBaselineError = "git_baseline_unavailable";
    if (!remoteWorkspace) {
      try {
        gitBaseline = await createGitChangeBaseline(workDir);
        gitBaselineError = null;
      } catch {}
    }
    const profile = this.profileFor(conversation);
    const harnessId = conversation.harnessId || resolveHarness(model, "auto");
    if (harnessId !== resolveHarness(model, "auto")) {
      const completedAt = new Date().toISOString();
      user.status = "failed";
      assistant.status = "failed";
      assistant.completedAt = completedAt;
      assistant.text = "模型与 Harness 不匹配，本轮未启动。请新建会话：Grok 使用 Grok Build，GPT 使用 Codex。";
      assistant.activity = [{ type: "error", label: assistant.text, status: "failed" }];
      conversation.updatedAt = completedAt;
      this.writeConversation(conversation);
      setImmediate(() => this.runNext());
      return;
    }
    if (this.sub2api && SUB2API_CODEX_MODELS[model] && conversation.codexThreadId &&
        conversation.providerId !== "sub2api") {
      // A pre-gateway Codex thread belongs to the old CODEX_HOME. Start a fresh
      // gateway thread and replay this conversation's visible history instead.
      conversation.codexThreadId = null;
      conversation.replayHistoryOnNextTurn = true;
      conversation.providerId = "sub2api";
      this.writeConversation(conversation);
    }
    if (harnessId === "grok-build" || harnessId === "google-antigravity") {
      const workerAvail = this.workerClient ? await this.workerClient.isAvailable() : false;
      console.log(`[ChatService] Dispatching turn for conv ${conversation.id}: harness=${harnessId}, workerAvail=${workerAvail}`);
      if (workerAvail && !remoteWorkspace) {
        await this.runWorkerTurn(conversation, user, assistant, model, reasoning, accessMode, workDir, attachments,
          gitBaseline, gitBaselineError);
        return;
      }
      if (this.workerClient && !remoteWorkspace) {
        this.finishRun(conversation, user, assistant, false, "", "执行服务暂时不可用，请稍后重试");
        setImmediate(() => this.runNext());
        return;
      }
      if (harnessId === "grok-build") {
        await this.runGrokTurn(conversation, user, assistant, model, reasoning, attachments,
          gitBaseline, gitBaselineError);
        return;
      }
      if (harnessId === "google-antigravity") {
        await this.runAntigravityTurn(conversation, user, assistant, model, reasoning, attachments,
          gitBaseline, gitBaselineError);
        return;
      }
    }
    if (harnessId !== "codex") {
      const completedAt = new Date().toISOString();
      user.status = "failed";
      assistant.status = "failed";
      assistant.completedAt = completedAt;
      assistant.text = "Google Antigravity runtime is not available on this host.";
      assistant.activity = [{ type: "error", label: assistant.text, status: "failed" }];
      conversation.updatedAt = completedAt;
      this.writeConversation(conversation);
      setImmediate(() => this.runNext());
      return;
    }
    const client = this.clientFor(profile, model);
    this.active = {
      conversationId: conversation.id,
      messageId: assistant.id,
      userId: user.id,
      ownerDeviceId: user.senderDeviceId || null,
      client,
      threadId: conversation.codexThreadId,
      turnId: null,
      turnStarted: false,
      finalResponse: "",
      finished: false,
      pendingSteers: [],
      pendingApprovals: new Map(),
      previewMessageBuffers: new Map(),
      codexHome: profile.codexHome,
      gitBaseline,
      gitBaselineError,
    };
    try {
      await client.start();
      if (!this.active || this.active.messageId !== assistant.id) return;
      const threadOptions = {
        cwd: workDir,
        model,
        sandbox: accessMode,
        approvalPolicy: "on-request",
        developerInstructions: this.buildDeveloperInstructions(conversation),
      };
      const threadResult = conversation.codexThreadId
        ? await client.request("thread/resume", {
            ...threadOptions, threadId: conversation.codexThreadId, excludeTurns: true,
          })
        : await client.request("thread/start", {
            ...threadOptions,
          });
      const latestConversation = this.readConversation(conversation.id) || conversation;
      latestConversation.codexThreadId = threadResult.thread.id;
      this.active.threadId = threadResult.thread.id;
      this.active.generatedImageFiles =
        this.generatedImageFiles(threadResult.thread.id, profile.codexHome);
      this.writeConversation(latestConversation);
      const turnResult = await client.request("turn/start", {
        threadId: threadResult.thread.id,
        input: this.buildInputs(latestConversation, user, attachments, false),
        model,
        effort: reasoning,
        cwd: workDir,
        approvalPolicy: "on-request",
      });
      if (latestConversation.replayHistoryOnNextTurn) {
        delete latestConversation.replayHistoryOnNextTurn;
        this.writeConversation(latestConversation);
      }
      this.active.turnId = turnResult.turn.id;
      this.requestActiveInterrupt();
      const runningConversation = this.readConversation(conversation.id) || latestConversation;
      const runningAssistant = runningConversation.messages.find(
        (message) => message.id === assistant.id);
      if (runningAssistant) {
        this.addActivity(runningAssistant, "thinking", "正在理解并处理你的要求", "running");
      }
      this.writeConversation(runningConversation);
      this.flushPendingSteers();
    } catch (error) {
      if (this.active?.messageId === assistant.id) {
        this.failActive(`无法启动 Codex：${error.message}`);
      }
    }
  }

  async appendGitChanges(current) {
    if (!current || current.gitChangesCollected) return;
    current.gitChangesCollected = true;
    const conversation = this.readConversation(current.conversationId);
    const assistant = conversation?.messages.find((message) => message.id === current.messageId);
    if (!conversation || !assistant) return;
    try {
      if (!current.gitBaseline) throw new Error(current.gitBaselineError || "git_baseline_unavailable");
      const summary = await collectGitChanges(current.gitBaseline);
      const count = summary.changes.length;
      this.upsertStream(assistant, "turn-git-changes", {
        kind: "file",
        label: count ? `本轮修改 ${count} 个文件` : "本轮没有检测到文件修改",
        status: "completed",
        count,
        branch: summary.branch || null,
        baselineBranch: current.gitBaseline.branch || null,
        branchChanged: summary.branchChanged,
        details: {
          changes: summary.changes,
          omitted: summary.omitted,
          total: summary.total,
          baselineAt: new Date(current.gitBaseline.createdAt).toISOString(),
          branch: summary.branch,
          baselineBranch: current.gitBaseline.branch,
          branchChanged: summary.branchChanged,
          baselineUnavailable: summary.baselineUnavailable,
          baselineDirty: current.gitBaseline.preexisting.size > 0 || summary.baselineUnavailable > 0 ||
            summary.changes.some((change) => change.baselineDirty),
        },
      });
    } catch {
      this.upsertStream(assistant, "turn-git-changes", {
        kind: "file", label: "无法收集本轮文件差异", status: "failed",
        details: { error: "git_change_collection_failed" },
      });
      this.addActivity(assistant, "file", "无法核对本轮文件差异", "failed");
    }
    conversation.updatedAt = new Date().toISOString();
    this.writeConversation(conversation);
  }



  async runWorkerTurn(conversation, user, assistant, model, reasoning, accessMode, workDir, attachments,
      gitBaseline = null, gitBaselineError = "git_baseline_unavailable") {
    const binding = this.remoteWorkspaceBinding(conversation);
    const remoteWorkspace = binding ? this.remoteWorkspaceService.runtimeFor(binding) : null;
    const existingSession = binding && !conversation.remoteWorkspaceStarted ? null : (conversation.harnessSessionId || null);
    const promptConversation = { ...conversation, codexThreadId: existingSession };
    const prompt = this.buildPrompt(promptConversation, user, attachments);
    const harnessId = conversation.harnessId || resolveHarness(model, "auto");

    this.active = {
      conversationId: conversation.id,
      messageId: assistant.id,
      userId: user.id,
      ownerDeviceId: user.senderDeviceId || null,
      harnessId,
      isWorker: true,
      threadId: existingSession,
      turnStarted: true,
      finalResponse: "",
      finished: false,
      pendingSteers: [],
      pendingApprovals: new Map(),
      gitBaseline,
      gitBaselineError,
    };

    const startResult = await this.workerClient.startTurn({
      userId: this.ownerUserId,
      conversationId: conversation.id,
      userMessageId: user.id,
      assistantMessageId: assistant.id,
      harnessId,
      model,
      reasoning,
      accessMode,
      workDir,
      prompt,
      attachments: attachments.map((a) => ({ id: a.id, name: a.name, path: a.path, mimeType: a.mimeType })),
      gitBaseline: gitBaseline ? { ...gitBaseline,
        preexisting: [...gitBaseline.preexisting], preexistingSnapshots: [...(gitBaseline.preexistingSnapshots || [])] } : null,
      gitBaselineError,
      existingSession,
      chatDir: this.chatDir,
      dataDir: this.dataDir,
      harnessOptions: this.harnessOptions,
      remoteWorkspace,
    });

    if (!startResult.ok) {
      this.failActive(`Worker 调度失败: ${startResult.error || "unknown"}`);
      return;
    }

    this.requestActiveInterrupt();

    this.active.unsubscribe = this.workerClient.subscribeTurnEvents(conversation.id, assistant.id, {
      fromSeq: 0,
      onEvent: (type, payload) => {
        const current = this.active;
        if (!current || current.messageId !== assistant.id || current.finished) return;
        this.scheduleConversationEvent(conversation.id);
      },
      onFinish: (result) => {
        const current = this.active;
        if (!current || current.messageId !== assistant.id || current.finished) return;
        this.completeWorkerTurn(assistant.id, result);
      },
      onError: () => {},
      onEnd: () => this.checkWorkerTurn(assistant.id),
    });
  }

  ensureActiveFor(conversationId) {
    if (this.active && this.active.conversationId === conversationId && !this.active.finished) {
      return this.active;
    }
    const conversation = this.readConversation(conversationId);
    if (!conversation || !this.workerClient || this.remoteWorkspaceBinding(conversation) ||
        !["google-antigravity", "grok-build"].includes(conversation.harnessId)) return null;
    const runningAssistant = conversation.messages?.findLast((m) => m.role === "assistant" && m.status === "running");
    if (!runningAssistant) return null;
    this.resumeWorkerTurn(conversation, runningAssistant);
    return this.active;
  }

  resumeWorkerTurn(conversation, assistant) {
    if (this.active) return;
    const replyToUser = conversation.messages?.find((m) => m.id === assistant.replyTo);
    this.active = {
      conversationId: conversation.id,
      messageId: assistant.id,
      userId: replyToUser?.id || null,
      ownerDeviceId: replyToUser?.senderDeviceId || null,
      harnessId: conversation.harnessId || "google-antigravity",
      isWorker: true,
      turnStarted: true,
      finished: false,
      pendingSteers: [],
      pendingApprovals: new Map(),
    };
    this.active.unsubscribe = this.workerClient.subscribeTurnEvents(conversation.id, assistant.id, {
      fromSeq: 0,
      onEvent: () => {
        this.scheduleConversationEvent(conversation.id);
      },
      onFinish: (result) => {
        const current = this.active;
        if (!current || current.messageId !== assistant.id || current.finished) return;
        this.completeWorkerTurn(assistant.id, result);
      },
      onError: () => {},
      onEnd: () => this.checkWorkerTurn(assistant.id),
    });
  }

  async checkWorkerTurn(messageId) {
    const current = this.active;
    if (!current?.isWorker || current.messageId !== messageId || current.finished) return;
    const status = await this.workerClient.getTurnStatus(current.conversationId, messageId);
    if (status?.unavailable) return;
    if (!status) this.completeWorkerTurn(messageId, { status: "failed", error: "执行服务已重启，本轮未自动重放；请检查工作区" });
    else if (status.status !== "running") this.completeWorkerTurn(messageId, status);
  }

  completeWorkerTurn(messageId, result) {
    const current = this.active;
    if (!current || current.messageId !== messageId || current.finished) return;
    const conversation = this.readConversation(current.conversationId);
    const assistant = conversation?.messages.find((message) => message.id === messageId);
    current.unsubscribe?.();
    this.finishActive(result.status === "completed", assistant?.text || result.text || "",
      result.error || "执行失败", result.status === "interrupted");
  }


  antigravityAdapter(model, conversation) {
    const options = this.harnessOptions?.antigravity || {};
    // A global runtime option must not override a session's access policy.
    const skipPermissions = conversation?.accessMode === "danger-full-access";
    return new AntigravityAdapter({
      bin: options.bin,
      model,
      cwd: this.effectiveWorkDir(conversation),
      apiKeyEnv: options.apiKeyEnv || "GEMINI_API_KEY",
      apiKeyValue: options.apiKeyValue || "",
      baseUrl: options.baseUrl || "",
      printTimeoutMs: options.timeoutMs || 300000,
      skipPermissions,
      logger: this.runtimeLogger,
    });
  }

  async runAntigravityTurn(conversation, user, assistant, model, reasoning, attachments,
      gitBaseline = null, gitBaselineError = "git_baseline_unavailable") {
    const workDir = this.effectiveWorkDir(conversation);
    const adapter = this.antigravityAdapter(model, conversation);
    const remoteWorkspace = this.remoteWorkspaceBinding(conversation);
    const existingSession = conversation.harnessSessionId || null;
    const promptConversation = { ...conversation, codexThreadId: existingSession };
    const prompt = this.buildPrompt(promptConversation, user, attachments);

    this.active = {
      conversationId: conversation.id,
      messageId: assistant.id,
      userId: user.id,
      ownerDeviceId: user.senderDeviceId || null,
      harnessId: "google-antigravity",
      harnessAdapter: adapter,
      harnessHandle: null,
      client: { request: () => Promise.reject(new Error("google-antigravity has no app-server client")) },
      threadId: existingSession,
      turnId: null,
      turnStarted: false,
      finalResponse: "",
      finished: false,
      pendingSteers: [],
      pendingApprovals: new Map(),
      codexHome: null,
      gitBaseline,
      gitBaselineError,
    };

    try {
      await adapter.startRuntime();
    } catch (error) {
      this.failActive(`Failed to start Google Antigravity: ${String(error.message || error).slice(0, 200)}`);
      return;
    }
    if (!this.active || this.active.messageId !== assistant.id) return;
    if (this.active.interruptRequested) {
      this.finishActive(false, "", "interrupted", true);
      return;
    }

    const skipPermissions = adapter.skipPermissions;
    const handle = adapter.sendPrompt({
      prompt,
      model,
      cwd: workDir,
      effort: normalizeEffort(reasoning || "medium"),
      skipPermissions,
      ...(existingSession ? { conversationId: existingSession } : {}),
    });
    this.active.harnessHandle = handle;
    this.active.turnStarted = true;
    this.active.toolEntries = new Map();
    this.requestActiveInterrupt();

    handle.events.on("event", (event) => {
      const current = this.active;
      if (!current || current.messageId !== assistant.id || current.finished) return;
      const live = this.readConversation(conversation.id) || conversation;
      const liveAssistant = live.messages.find((message) => message.id === assistant.id);
      if (!liveAssistant) return;
      const discoveredSessionId = event.sessionId || event.raw?.sessionId;
      if (discoveredSessionId) {
        live.harnessSessionId = String(discoveredSessionId);
        live.harnessId = "google-antigravity";
        live.providerId = "google-antigravity";
        if (remoteWorkspace) live.remoteWorkspaceStarted = true;
      }
      if (event.type === "text_delta") {
        const entry = this.upsertStream(liveAssistant, "harness-message",
          { kind: "message", phase: "final_answer", status: "running" });
        entry.text = `${entry.text || ""}${event.text || ""}`;
      } else if (event.type === "reasoning_delta") {
        if (!current.reasoningNoted) {
          current.reasoningNoted = true;
          this.addActivity(liveAssistant, "thinking", "reasoning", "running");
        }
      } else if (event.type === "result") {
        if (event.text) {
          const entry = this.upsertStream(liveAssistant, "harness-message",
            { kind: "message", phase: "final_answer", status: "running" });
          entry.text = event.text;
        }
        current.harnessUsage = event.usage || null;
      } else if (event.type === "error") {
        current.harnessEventError = String(event.error || "run_error").slice(0, 200);
        this.addActivity(liveAssistant, "error", "Antigravity error event", "failed");
      }
      live.updatedAt = new Date().toISOString();
      this.writeConversation(live);
      if (discoveredSessionId) this.store.save(live, { immediate: true });
    });

    const result = await handle.done;
    if (!this.active || this.active.messageId !== assistant.id || this.active.finished) return;

    const finalConversation = this.readConversation(conversation.id) || conversation;
    const finalAssistant = finalConversation.messages.find((message) => message.id === assistant.id);
    const text = (finalAssistant?.stream || [])
      .filter((entry) => entry.kind === "message")
      .map((entry) => entry.text || "").join("").trim() || (result.text || "").trim();

    if (result.sessionId) {
      finalConversation.harnessSessionId = result.sessionId;
      finalConversation.harnessId = "google-antigravity";
      finalConversation.providerId = "google-antigravity";
      if (remoteWorkspace) finalConversation.remoteWorkspaceStarted = true;
    }
    if (result.sessionId) this.writeConversation(finalConversation);

    // 1. Append git changes before finishActive
    if (!remoteWorkspace) await this.appendGitChanges(this.active);

    // 2. Timeout check
    if (result.timedOut) {
      finalConversation.updatedAt = new Date().toISOString();
      this.writeConversation(finalConversation);
      this.finishActive(false, text, "Google Antigravity timeout");
      return;
    }

    // 3. Interrupt check
    if (this.active.interruptRequested) {
      finalConversation.updatedAt = new Date().toISOString();
      this.writeConversation(finalConversation);
      this.finishActive(false, text, "interrupted", true);
      return;
    }

    finalConversation.updatedAt = new Date().toISOString();
    this.writeConversation(finalConversation);

    // 4. Strict error check: if exit code not ok or error event received, always fail
    if (!result.ok || this.active.harnessEventError) {
      this.finishActive(false, text, `Google Antigravity ${result.errorType || "failed"}`);
      return;
    }

    // 5. Empty output check
    if (!text) {
      this.finishActive(false, "", "Google Antigravity produced no response");
      return;
    }

    // 6. Success completion
    this.finishActive(true, text, "");
  }


  grokAdapter(model, conversation) {
    const options = this.harnessOptions.grok || {};
    const binding = this.remoteWorkspaceBinding(conversation);
    const remoteWorkspace = binding ? this.remoteWorkspaceService.runtimeFor(binding) : null;
    return new GrokBuildAdapter({
      bin: options.bin,
      model,
      cwd: this.effectiveWorkDir(conversation),
      envKey: options.envKey || "WITT_CPA_KEY",
      envValue: options.envValue || "",
      remoteDeviceMcpEnabled: !remoteWorkspace && options.remoteDeviceMcpEnabled === true,
      remoteDeviceTokenFile: options.remoteDeviceTokenFile || "",
      remoteWorkspace,
      browserMcpEnabled: options.browserMcpEnabled === true,
      permissionMode: options.permissionMode || grokPermissionMode(conversation.accessMode),
      reasoningEffort: options.reasoningEffort || null,
      timeoutMs: options.timeoutMs,
      logger: this.runtimeLogger,
    });
  }

  // Runs one Grok Build turn through the real official CLI and maps its NDJSON
  // events onto the same assistant stream shape the Codex path produces, so the
  // existing UI renders it without a second code path.
  async runGrokTurn(conversation, user, assistant, model, reasoning, attachments,
      gitBaseline = null, gitBaselineError = "git_baseline_unavailable") {
    const workDir = this.effectiveWorkDir(conversation);
    const adapter = this.grokAdapter(model, conversation);
    const remoteWorkspace = this.remoteWorkspaceBinding(conversation);
    // Remote Workspace reserves its session id at binding time, but Grok must
    // receive --session-id (not --resume) until that first turn actually runs.
    const existingSession = remoteWorkspace && !conversation.remoteWorkspaceStarted
      ? null : (conversation.harnessSessionId || null);
    const promptConversation = { ...conversation, codexThreadId: existingSession };
    const prompt = this.buildPrompt(promptConversation, user, attachments);

    this.active = {
      conversationId: conversation.id,
      messageId: assistant.id,
      userId: user.id,
      ownerDeviceId: user.senderDeviceId || null,
      harnessId: "grok-build",
      harnessAdapter: adapter,
      harnessHandle: null,
      client: { request: () => Promise.reject(new Error("grok-build has no app-server client")) },
      threadId: existingSession,
      turnId: null,
      turnStarted: false,
      finalResponse: "",
      finished: false,
      pendingSteers: [],
      pendingApprovals: new Map(),
      codexHome: null,
      gitBaseline,
      gitBaselineError,
    };

    try {
      await adapter.startRuntime();
    } catch (error) {
      // A missing or broken runtime fails this turn only; the backend keeps running.
      this.failActive(`无法启动 Grok Build：${String(error.message || error).slice(0, 200)}`);
      return;
    }
    if (!this.active || this.active.messageId !== assistant.id) return;
    if (this.active.interruptRequested) {
      this.finishActive(false, "", "已暂停", true);
      return;
    }

    const handle = adapter.sendPrompt({
      prompt,
      model,
      cwd: workDir,
      reasoningEffort: HARNESS_REASONING[reasoning] || "medium",
      ...(existingSession ? { resumeSessionId: existingSession } : {
        sessionId: remoteWorkspace ? conversation.harnessSessionId : crypto.randomUUID(),
      }),
    });
    this.active.harnessHandle = handle;
    this.active.turnStarted = true;
    this.active.toolEntries = new Map();
    this.requestActiveInterrupt();

    handle.events.on("event", (event) => {
      const current = this.active;
      if (!current || current.messageId !== assistant.id || current.finished) return;
      const live = this.readConversation(conversation.id) || conversation;
      const liveAssistant = live.messages.find((message) => message.id === assistant.id);
      if (!liveAssistant) return;
      const discoveredSessionId = event.sessionId || event.raw?.sessionId;
      if (discoveredSessionId) {
        live.harnessSessionId = String(discoveredSessionId);
        live.harnessId = "grok-build";
        live.providerId = providerForModel(model) || live.providerId || null;
        if (remoteWorkspace) live.remoteWorkspaceStarted = true;
      }
      if (event.type === "text_delta") {
        const entry = this.upsertStream(liveAssistant, "harness-message",
          { kind: "message", phase: "final_answer", status: "running" });
        entry.text = `${entry.text || ""}${event.text || ""}`;
      } else if (event.type === "reasoning_delta") {
        if (!current.reasoningNoted) {
          current.reasoningNoted = true;
          this.addActivity(liveAssistant, "thinking", "正在推理", "running");
        }
      } else if (event.type === "tool_call") {
        const presented = adapter.formatToolCall(event, workDir);
        this.addActivity(liveAssistant, presented.kind, presented.label, "running");
        const key = event.id || `tool-${current.toolEntries.size}`;
        current.toolEntries.set(key, { kind: presented.kind, label: presented.label });
        this.upsertStream(liveAssistant, key, presented);
      } else if (event.type === "tool_call_update") {
        const key = event.id || [...current.toolEntries.keys()].at(-1);
        if (key) {
          const presented = adapter.formatToolUpdate(event, current.toolEntries.get(key));
          const { details, ...fields } = presented;
          const entry = this.upsertStream(liveAssistant, key, fields);
          if (details) entry.details = { ...(entry.details || {}), ...details };
        }
      } else if (event.type === "plan") {
        this.upsertStream(liveAssistant, "harness-plan", {
          kind: "plan", label: "计划进度", status: "running",
          steps: (event.entries || []).map((step) => ({
            step: String(step.step || step.title || step.content || ""),
            status: String(step.status || "pending"),
          })).filter((step) => step.step),
        });
      } else if (event.type === "error") {
        current.harnessEventError = String(event.error || "运行失败").slice(0, 200);
        this.addActivity(liveAssistant, "error", "Grok Build 返回错误事件", "failed");
      } else if (event.type === "end") {
        current.harnessUsage = event.usage || null;
        current.harnessStopReason = event.stopReason || null;
      }
      live.updatedAt = new Date().toISOString();
      this.writeConversation(live);
      if (discoveredSessionId) this.store.save(live, { immediate: true });
    });

    const result = await handle.done;
    if (!this.active || this.active.messageId !== assistant.id || this.active.finished) return;

    const finalConversation = this.readConversation(conversation.id) || conversation;
    const finalAssistant = finalConversation.messages.find((message) => message.id === assistant.id);
    const text = (finalAssistant?.stream || [])
      .filter((entry) => entry.kind === "message")
      .map((entry) => entry.text || "").join("").trim();

    // Persist the harness session id so the next turn resumes instead of restarting.
    if (result.sessionId) {
      finalConversation.harnessSessionId = result.sessionId;
      finalConversation.harnessId = "grok-build";
      // Derived from the model family actually used, not from whichever gateway
      // happens to be configured, so a stored binding is never mislabelled.
      finalConversation.providerId = providerForModel(model) || finalConversation.providerId || null;
      if (remoteWorkspace) finalConversation.remoteWorkspaceStarted = true;
    }
    if (result.sessionId) this.writeConversation(finalConversation);
    if (!remoteWorkspace) await this.appendGitChanges(this.active);

    if (result.timedOut) {
      finalConversation.updatedAt = new Date().toISOString();
      this.writeConversation(finalConversation);
      this.finishActive(false, text, "Grok Build 运行超时");
      return;
    }
    // Only an interrupt this session actually asked for is a pause. A runtime that
    // died on its own must surface as a failure, not as a user-requested pause.
    if (this.active.interruptRequested) {
      finalConversation.updatedAt = new Date().toISOString();
      this.writeConversation(finalConversation);
      this.finishActive(false, text, "已暂停", true);
      return;
    }
    finalConversation.updatedAt = new Date().toISOString();
    this.writeConversation(finalConversation);
    if (!result.ok || this.active.harnessEventError) {
      // stderr stays server-side and passes through RuntimeLogger redaction. It may
      // contain gateway diagnostics or credential-shaped values, so never return
      // it through the browser API/SSE surface.
      this.finishActive(false, text, `Grok Build ${result.errorType || "failed"}`);
      return;
    }
    if (!text) {
      this.finishActive(false, "", "Grok Build 未返回有效结果");
      return;
    }
    this.finishActive(true, text, "");
  }

  handleNotification(conversationId, messageId, method, params) {
    if (!this.active || this.active.conversationId !== conversationId ||
        this.active.messageId !== messageId) return;
    const conversation = this.readConversation(conversationId);
    if (!conversation) return;
    const assistant = conversation.messages.find((message) => message.id === messageId);
    if (!assistant) return;
    const item = params.item || {};
    if (method === "thread/tokenUsage/updated") {
      const total = params.tokenUsage?.total || {};
      const last = params.tokenUsage?.last || {};
      const contextWindow = Number(params.tokenUsage?.modelContextWindow || 0);
      // `total` is the lifetime sum for this thread, not its live context footprint.
      // The latest turn's input is the closest app-server signal for the prompt currently
      // occupying the model window; using `total.totalTokens` makes every long thread read 0%.
      const liveContextTokens = Number(last.inputTokens || 0);
      conversation.contextUsage = contextWindow > 0 ? {
        usedTokens: liveContextTokens > 0 ? Math.max(0, liveContextTokens) : null,
        contextWindow,
        source: "last-input",
        updatedAt: new Date().toISOString(),
      } : null;
    } else if (method === "turn/started") {
      this.active.turnId = params.turn?.id || this.active.turnId;
      assistant.codexTurnId = this.active.turnId;
      this.active.turnStarted = true;
      this.addActivity(assistant, "thinking", "正在理解并处理你的要求", "running");
      this.requestActiveInterrupt();
      this.flushPendingSteers();
    } else if (method === "turn/plan/updated") {
      const steps = (params.plan || []).map((step) => ({
        step: String(step.step || ""),
        status: String(step.status || "pending"),
      })).filter((step) => step.step);
      const completed = steps.filter((step) => step.status === "completed").length;
      this.upsertStream(assistant, `plan-${params.turnId || this.active.turnId}`, {
        kind: "plan",
        label: steps.length ? `计划进度 ${completed}/${steps.length}` : "正在制定计划",
        status: completed === steps.length && steps.length ? "completed" : "running",
        steps,
        explanation: String(params.explanation || ""),
      });
    } else if (method === "model/rerouted") {
      conversation.model = String(params.toModel || conversation.model);
      this.addActivity(assistant, "model", `模型已切换为 ${conversation.model}`, "completed");
    } else if (method === "model/safetyBuffering/updated") {
      this.addActivity(assistant, "safety", params.showBufferingUi
        ? "正在完成安全校验" : "安全校验完成", params.showBufferingUi ? "running" : "completed");
    } else if (method === "item/agentMessage/delta") {
      const entry = this.upsertStream(assistant, params.itemId, {
        kind: "message",
        phase: "unknown",
        status: "running",
      });
      const buffers = this.active.previewMessageBuffers || new Map();
      this.active.previewMessageBuffers = buffers;
      const raw = `${buffers.get(params.itemId) || ""}${String(params.delta || "")}`;
      buffers.set(params.itemId, raw);
      entry.text = this.parsePreviewMarkers(raw).text;
    } else if (method === "item/started" || method === "item/completed") {
      const status = method === "item/completed" ? "completed" : "running";
      if (item.type === "commandExecution") {
        const label = String(item.command || "执行命令").replace(/\s+/g, " ").slice(0, 120);
        this.addActivity(
          assistant, "command", label.slice(0, 90), status);
        this.upsertStream(assistant, item.id, {
          kind: "command", label, status,
          exitCode: Number.isInteger(item.exitCode) ? item.exitCode : null,
          error: item.error ? String(item.error).slice(0, 500) : null,
          failureReason: item.failureReason ? String(item.failureReason).slice(0, 300) : null,
          details: {
            command: String(item.command || ""),
            cwd: String(item.cwd || ""),
            exitCode: Number.isInteger(item.exitCode) ? item.exitCode : null,
            durationMs: Number.isInteger(item.durationMs) ? item.durationMs : null,
            output: String(item.aggregatedOutput || "").slice(-64 * 1024),
          },
        });
        if (method === "item/completed" && this.active.previewSourcePath) {
          this.publishPreviewSnapshot(assistant, this.active.previewSourcePath);
        }
      } else if (item.type === "fileChange") {
        // Keep the live signal in the activity list; the authoritative file list
        // is produced once at turn completion by the shared Git baseline collector.
        this.addActivity(assistant, "file",
          status === "completed" ? "文件变更已收到，正在核对本轮差异" : "正在修改项目文件", status);
        if (method === "item/completed" && this.active.previewSourcePath) {
          this.publishPreviewSnapshot(assistant, this.active.previewSourcePath);
        }
      } else if (item.type === "mcpToolCall") {
        const label = item.tool ? `调用工具：${item.tool}` : "正在调用已连接的工具";
        this.addActivity(assistant, "tool", label, status);
        this.upsertStream(assistant, item.id, {
          kind: "tool", label, status,
        });
        if (method === "item/completed") {
          this.captureToolImages(assistant, item).forEach((image, index) => {
            this.upsertStream(assistant, `${item.id}-image-${index}`, {
              kind: "image",
              imageId: image.id,
              name: image.name,
              mimeType: image.mimeType,
              status: "completed",
            });
          });
        }
      } else if (item.type === "dynamicToolCall") {
        const label = item.tool ? `调用工具：${item.tool}` : "正在调用工具";
        this.addActivity(assistant, "tool", label, status);
        this.upsertStream(assistant, item.id, {
          kind: "tool", label, status,
        });
        if (method === "item/completed") {
          this.captureToolImages(assistant, item).forEach((image, index) => {
            this.upsertStream(assistant, `${item.id}-image-${index}`, {
              kind: "image",
              imageId: image.id,
              name: image.name,
              mimeType: image.mimeType,
              status: "completed",
            });
          });
        }
      } else if (item.type === "collabToolCall") {
        const label = item.tool === "spawn_agent" ? "正在委派子任务"
          : item.tool === "wait" ? "正在等待并行任务" : "正在协调并行任务";
        this.addActivity(assistant, "collab", label, status);
        this.upsertStream(assistant, item.id, {
          kind: "collab", label, status,
          agentStatus: String(item.agentStatus || ""),
        });
      } else if (item.type === "contextCompaction") {
        this.upsertStream(assistant, item.id, {
          kind: "compact", label: status === "completed" ? "上下文压缩完成" : "正在压缩上下文",
          status,
        });
        conversation.contextCompaction = {
          status, updatedAt: new Date().toISOString(),
        };
      } else if (item.type === "enteredReviewMode") {
        this.upsertStream(assistant, item.id, {
          kind: "review", label: "正在进行代码审查", status,
        });
      } else if (item.type === "exitedReviewMode") {
        const review = String(item.review || "");
        this.upsertStream(assistant, item.id, {
          kind: "message", phase: "final_answer", text: review, status,
        });
        if (review) this.active.finalResponse = review;
      } else if (item.type === "webSearch") {
        const label = item.query ? `搜索：${String(item.query).slice(0, 100)}` : "正在查找最新资料";
        this.addActivity(assistant, "web", label, status);
        this.upsertStream(assistant, item.id, {
          kind: "web", label, status,
        });
      } else if (item.type === "imageView") {
        if (method === "item/completed") {
          const image = this.attachImage(
            assistant, this.storeImagePath(item.path, "execution"));
          if (image) {
            this.upsertStream(assistant, item.id, {
              kind: "image",
              imageId: image.id,
              name: image.name,
              mimeType: image.mimeType,
              status: "completed",
            });
          }
        }
      } else if (["imageGeneration", "image_generation", "image_generation_end"].includes(item.type)) {
        if (method === "item/completed") {
          const image = this.captureGeneratedImage(assistant, item);
          if (image) {
            this.upsertStream(assistant, item.id, {
              kind: "image",
              imageId: image.id,
              name: image.name,
              mimeType: image.mimeType,
              status: "completed",
            });
          }
        }
      } else if (item.type === "agentMessage") {
        const entry = this.upsertStream(assistant, item.id, {
          kind: "message",
          phase: item.phase || "unknown",
          status,
        });
        if (item.text) {
          const parsed = this.parsePreviewMarkers(item.text);
          entry.text = parsed.text;
          for (const previewPath of parsed.paths) {
            this.publishPreviewSnapshot(assistant, previewPath);
          }
          this.active.previewMessageBuffers?.delete(item.id);
        }
        if (item.phase === "final_answer" && entry.text) {
          this.active.finalResponse = entry.text;
        }
      }
    } else if (method === "turn/completed") {
      const messageEntries = (assistant.stream || []).filter(
        (entry) => entry.kind === "message" && String(entry.text || "").trim());
      const finalEntry = messageEntries.filter((entry) => entry.phase === "final_answer").at(-1)
        || messageEntries.at(-1);
      const response = String(finalEntry?.text || this.active.finalResponse || "");
      const interrupted = params.turn?.status === "interrupted";
      const success = params.turn?.status === "completed" && Boolean(response.trim());
      const detail = params.turn?.error?.message || "Codex 未返回有效结果";
      const current = this.active;
      if (current.finishingTurn) return;
      current.finishingTurn = true;
      this.appendGitChanges(current).catch(() => {}).finally(() => {
        if (this.active === current && !current.finished) {
          this.finishActive(success, response, interrupted ? "已暂停" : detail, interrupted);
        }
      });
      return;
    } else {
      return;
    }
    conversation.updatedAt = new Date().toISOString();
    this.writeConversation(conversation);
  }

  failActive(error) {
    const current = this.active;
    if (current?.gitBaseline && !current.gitChangesCollected && !current.finishingTurn) {
      current.finishingTurn = true;
      this.appendGitChanges(current).finally(() => {
        if (this.active === current && !current.finished) this.finishActive(false, "", error);
      });
      return;
    }
    this.finishActive(false, "", error);
  }

  finishActive(success, response, error, interrupted = false) {
    const current = this.active;
    if (!current || current.finished) return;
    current.finished = true;
    clearTimeout(current.timeout);
    const conversation = this.readConversation(current.conversationId);
    if (!conversation) {
      this.active = null;
      return;
    }
    const user = conversation.messages.find((message) => message.id === current.userId);
    const assistant = conversation.messages.find((message) => message.id === current.messageId);
    if (!assistant) {
      this.active = null;
      setImmediate(() => this.runNext());
      return;
    }
    for (const entry of assistant.stream || []) {
      if (entry.kind === "approval" && entry.status === "pending") {
        entry.status = "expired";
        entry.resolvedAt = new Date().toISOString();
      }
    }
    current.pendingApprovals?.clear();
    this.finishRun(conversation, user, assistant, success, response, error, interrupted);
  }

  finishRun(conversation, user, assistant, success, response, error, interrupted = false) {
    if (user) user.status = success || interrupted ? "completed" : "failed";
    const assistantIndex = conversation.messages.findIndex((message) => message.id === assistant.id);
    for (let index = 0; index < conversation.messages.length; index += 1) {
      const message = conversation.messages[index];
      if (message.role === "user" && message.status === "running") {
        message.status = success || interrupted ? "completed" : "failed";
      } else if (message.role === "user" &&
          (message.status === "queued" || message.status === "running") &&
          message.steeredInto === assistant.id) {
        message.status = success || interrupted ? "completed" : "failed";
      } else if (message.role === "user" && message.status === "queued" &&
          index < assistantIndex &&
          !conversation.messages.some((candidate) =>
            candidate.role === "assistant" && candidate.replyTo === message.id)) {
        message.status = success || interrupted ? "completed" : "failed";
      }
    }
    assistant.status = interrupted ? "interrupted" : success ? "completed" : "failed";
    assistant.completedAt = new Date().toISOString();
    const parsedResponse = this.parsePreviewMarkers(response);
    if (success) {
      for (const previewPath of parsedResponse.paths) {
        this.publishPreviewSnapshot(assistant, previewPath);
      }
    }
    const delivery = success
      ? this.extractDeliveries(parsedResponse.text)
      : { text: parsedResponse.text, artifacts: [] };
    assistant.text = interrupted
      ? "已暂停本轮执行。已完成的修改和命令结果会保留。"
      : success ? delivery.text : `本轮没有完成：${error}`;
    assistant.artifacts = delivery.artifacts;
    if (assistant.livePreview) assistant.livePreview.live = false;
    for (const artifact of delivery.artifacts) {
      if (!String(artifact.mimeType || "").startsWith("image/")) continue;
      this.attachImage(
        assistant,
        this.storeImagePath(artifact.sourcePath, "delivery", artifact.id),
      );
    }
    if (success && this.active?.threadId === conversation.codexThreadId) {
      this.captureNewGeneratedImages(assistant, this.active.threadId,
        this.active.generatedImageFiles, this.active.codexHome).forEach((image, index) => {
        this.upsertStream(assistant, `generated-image-${image.id}-${index}`, {
          kind: "image", imageId: image.id, name: image.name,
          mimeType: image.mimeType, status: "completed",
        });
      });
    }
    assistant.stream = Array.isArray(assistant.stream) ? assistant.stream : [];
    for (const entry of assistant.stream) {
      if (entry.status === "running") entry.status = success || interrupted ? "completed" : "failed";
    }
    if (success) {
      const messageEntries = assistant.stream.filter((entry) => entry.kind === "message");
      const finalEntry = messageEntries.filter((entry) => entry.phase === "final_answer").at(-1)
        || messageEntries.at(-1);
      if (finalEntry) {
        finalEntry.text = delivery.text;
        finalEntry.phase = "final_answer";
        finalEntry.status = "completed";
      } else if (delivery.text) {
        assistant.stream.push({
          id: crypto.randomUUID(),
          kind: "message",
          phase: "final_answer",
          text: delivery.text,
          status: "completed",
          createdAt: new Date().toISOString(),
        });
      }
    } else {
      assistant.stream.push({
        id: crypto.randomUUID(),
        kind: "message",
        phase: "final_answer",
        text: assistant.text,
        status: interrupted ? "interrupted" : "failed",
        createdAt: new Date().toISOString(),
      });
    }
    for (const activity of assistant.activity || []) {
      if (activity.status === "running") {
        activity.status = success || interrupted ? "completed" : "failed";
      }
    }
    this.addActivity(
      assistant,
      interrupted ? "pause" : success ? "done" : "error",
      interrupted ? "已暂停" : success ? "处理完成" : "处理未完成",
      interrupted || success ? "completed" : "failed");
    conversation.updatedAt = assistant.completedAt;
    this.writeConversation(conversation);
    this.active = null;
    setImmediate(() => this.runNext());
  }

  extractDeliveries(response) {
    const lines = String(response || "").split("\n");
    const artifacts = [];
    const visible = [];
    for (const line of lines) {
      const match = line.trim().match(/^\[\[deliver:(\/.+)\]\]$/);
      if (!match) {
        visible.push(line);
        continue;
      }
      const artifact = this.deliveryArtifact(match[1].trim());
      if (artifact && !artifacts.some((item) => item.sourcePath === artifact.sourcePath)) {
        artifacts.push(artifact);
      }
    }
    return { text: visible.join("\n").trim(), artifacts };
  }

  deliveryArtifact(requestedPath) {
    try {
      const sourcePath = fs.realpathSync(requestedPath);
      if (!this.deliveryRoots.some((root) =>
        sourcePath === root || sourcePath.startsWith(`${root}${path.sep}`))) return null;
      const lower = sourcePath.toLowerCase();
      if (/(^|\/)(\.ssh|\.gnupg|\.aws|\.codex)(\/|$)/.test(lower) ||
          /(^|\/)(\.env($|\.)|[^/]*(token|credential|secret|private[_-]?key)[^/]*)$/.test(lower) ||
          /\.(pem|key|p12|pfx)$/i.test(lower)) return null;
      const stat = fs.statSync(sourcePath);
      if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES) return null;
      return {
        id: crypto.randomUUID(),
        name: path.basename(sourcePath),
        size: stat.size,
        mimeType: this.mimeType(sourcePath),
        sourcePath,
      };
    } catch {
      return null;
    }
  }

  mimeType(filePath) {
    const extension = path.extname(filePath).toLowerCase();
    return ({
      ".apk": "application/vnd.android.package-archive",
      ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".xlsb": "application/vnd.ms-excel.sheet.binary.macroEnabled.12",
      ".zip": "application/zip",
      ".pdf": "application/pdf",
      ".csv": "text/csv",
      ".txt": "text/plain",
      ".json": "application/json",
      ".html": "text/html",
      ".htm": "text/html",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".gif": "image/gif",
    })[extension] || "application/octet-stream";
  }

  downloadArtifact(res, conversationId, messageId, artifactId) {
    const conversation = this.readConversation(conversationId);
    const message = conversation?.messages.find((item) => item.id === messageId);
    const artifact = message?.artifacts?.find((item) => item.id === artifactId);
    if (!artifact?.sourcePath) {
      this.sendJson(res, 404, { error: "交付文件不存在" });
      return;
    }
    const verified = this.deliveryArtifact(artifact.sourcePath);
    if (!verified) {
      this.sendJson(res, 410, { error: "交付文件已移动或不可下载" });
      return;
    }
    const encoded = encodeURIComponent(artifact.name).replace(/['()]/g, escape);
    res.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": artifact.mimeType || verified.mimeType,
      "Content-Length": verified.size,
      "Content-Disposition": `attachment; filename*=UTF-8''${encoded}`,
      "X-Content-Type-Options": "nosniff",
    });
    const stream = fs.createReadStream(verified.sourcePath);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  }

  previewArtifact(res, conversationId, messageId, artifactId) {
    if (this.previewArtifactByIds(res, conversationId, messageId, artifactId)) return;
    this.sendJson(res, 404, { error: "该交付文件不支持预览" });
  }

  previewArtifactByIds(res, conversationId, messageId, artifactId) {
    const conversation = this.readConversation(conversationId);
    const message = conversation?.messages.find((item) => item.id === messageId);
    const artifact = message?.artifacts?.find((item) => item.id === artifactId);
    if (!artifact) return false;
    this.sendArtifactPreview(res, artifact);
    return true;
  }

  previewArtifactForToken(res, entry) {
    const ownerId = this.store.findConversationIdByMessageId(entry.messageId);
    const owner = ownerId ? this.readConversation(ownerId) : null;
    for (const conversation of owner ? [owner] : []) {
      const message = conversation.messages.find((item) => item.id === entry.messageId);
      const candidates = [
        ...(message?.artifacts || []),
        ...(message?.previewVersions || []),
        ...(message?.livePreview ? [message.livePreview] : []),
      ];
      const artifact = candidates.find((item) => item.id === entry.artifactId);
      if (!artifact) continue;
      this.sendArtifactPreview(res, artifact);
      return true;
    }
    artifactPreviewTokens.delete([...artifactPreviewTokens.entries()]
      .find(([, candidate]) => candidate === entry)?.[0]);
    return false;
  }

  artifactForToken(entry) {
    const ownerId = this.store.findConversationIdByMessageId(entry.messageId);
    const owner = ownerId ? this.readConversation(ownerId) : null;
    for (const conversation of owner ? [owner] : []) {
      const message = conversation.messages.find((item) => item.id === entry.messageId);
      const candidates = [
        ...(message?.artifacts || []),
        ...(message?.previewVersions || []),
        ...(message?.livePreview ? [message.livePreview] : []),
      ];
      const artifact = candidates.find((item) => item.id === entry.artifactId);
      if (artifact) return artifact;
    }
    return null;
  }

  sourceArtifactForToken(res, entry) {
    const artifact = this.artifactForToken(entry);
    if (!artifact) return false;
    const verified = this.deliveryArtifact(artifact.sourcePath);
    const extension = path.extname(String(artifact.name || "")).toLowerCase();
    if (!verified || !['.html', '.htm'].includes(extension) ||
        verified.size > MAX_INLINE_PREVIEW_BYTES) return false;
    let source;
    try { source = fs.readFileSync(verified.sourcePath, "utf8"); } catch { return false; }
    res.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": Buffer.byteLength(source),
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'self'",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(source);
    return true;
  }

  sendArtifactPreview(res, artifact) {
    const extension = path.extname(String(artifact?.name || "")).toLowerCase();
    if (!artifact?.sourcePath || !['.html', '.htm'].includes(extension)) {
      this.sendJson(res, 404, { error: "该交付文件不支持预览" });
      return;
    }
    const verified = this.deliveryArtifact(artifact.sourcePath);
    if (!verified) {
      this.sendJson(res, 410, { error: "交付文件已移动或不可预览" });
      return;
    }
    if (verified.size > MAX_INLINE_PREVIEW_BYTES) {
      this.sendJson(res, 413, { error: "交互预览文件不能超过 5 MB" });
      return;
    }
    let source;
    try {
      source = fs.readFileSync(verified.sourcePath, "utf8");
    } catch {
      this.sendJson(res, 410, { error: "交付文件已移动或不可预览" });
      return;
    }
    const bridge = `<script>(()=>{const post=(value)=>parent.postMessage(value,"*");const send=()=>{const d=document.documentElement,b=document.body;post({type:"witt-artifact-ready",height:Math.max(d.scrollHeight,d.offsetHeight,b?b.scrollHeight:0,b?b.offsetHeight:0)})};addEventListener("error",e=>post({type:"witt-artifact-error",message:e.message||"页面运行错误",line:e.lineno||0}));addEventListener("unhandledrejection",e=>post({type:"witt-artifact-error",message:String(e.reason?.message||e.reason||"页面运行错误")}));addEventListener("load",send);addEventListener("resize",send);if(typeof ResizeObserver!=="undefined")new ResizeObserver(send).observe(document.documentElement);setTimeout(send,0);setTimeout(send,250)})()<\/script>`;
    source = /<\/body\s*>/i.test(source)
      ? source.replace(/<\/body\s*>/i, `${bridge}</body>`)
      : `${source}${bridge}`;
    const payload = Buffer.from(source, "utf8");
    const encoded = encodeURIComponent(artifact.name).replace(/['()]/g, escape);
    res.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": payload.length,
      "Content-Disposition": `inline; filename*=UTF-8''${encoded}`,
      "Content-Security-Policy": "sandbox allow-scripts; default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data: blob:; connect-src 'none'; child-src 'none'; object-src 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(payload);
  }

  streamDetails(res, conversationId, messageId, entryId) {
    const conversation = this.readConversation(conversationId);
    const message = conversation?.messages.find((item) => item.id === messageId);
    const entry = message?.stream?.find((item) => item.id === entryId);
    if (!entry?.details || !["command", "file", "tool"].includes(entry.kind)) {
      this.sendJson(res, 404, { error: "这条过程记录没有可查看的详情" });
      return;
    }
    const { details, ...summary } = entry;
    this.sendJson(res, 200, { entry: { ...summary, details } });
  }
}

module.exports = {
  ChatService,
  servePublicArtifactPreview,
  servePublicArtifactSource,
  ADMIN_MODELS,
  NON_ADMIN_MODELS,
  ALL_MODELS,
  SELECTABLE_MODELS,
  SELECTABLE_HARNESS_MODELS,
  LEGACY_KNOWN_MODELS,
  PAUSED_RUNTIME_MODELS,
  PAUSED_RUNTIME_REASON,
  RETIRED_UNVERIFIED_MODELS,
  RETIRED_MODEL_REASON,
  BLOCK_REASON_CODES,
  providerForModel,
  DEFAULT_HARNESS_MODEL,
  DEFAULT_PROVIDER_ID,
  codexUnavailableReason,
  CODEX_REASON_CODES,
  QUOTA_EXHAUSTED_MESSAGE,
  DEFAULT_WORKDIR_ROOTS,
  buildWorkDirRoots,
  normalizeRootList,
  isWithinRoots,
  grokPermissionMode,
};
