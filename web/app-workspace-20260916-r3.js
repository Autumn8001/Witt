(() => {
  const $ = (selector) => document.querySelector(selector);
  const nativeBridge = new Proxy({}, {
    get(_target, method) {
      return (...args) => window.WittNative?.postMessage(JSON.stringify({ method, args }));
    },
  });
  const bridge = () => window.WittNative ? nativeBridge : (window.DropVaultAndroid || null);
  const CODEX_PROFILE_IDS = ["default", "xuanyu", "account3", "account4", "account5"];
  const MVP_DEFAULT_MODEL = "grok-4.7-high";
  const MVP_MODEL_MIGRATION_KEY = "wit_grok_mvp_model_migrated_v1";
  const LEGACY_DEFAULT_MODELS = new Set([
    "gpt-6-astra", "gpt-6-sol", "gpt-6-luna",
    "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
  ]);
  const previousModel = localStorage.getItem("wit_model_preference") || localStorage.getItem("wit_model");
  const shouldMigrateModelPreference = !localStorage.getItem(MVP_MODEL_MIGRATION_KEY) &&
    (!previousModel || LEGACY_DEFAULT_MODELS.has(previousModel));
  const savedModel = shouldMigrateModelPreference ? MVP_DEFAULT_MODEL : (previousModel || MVP_DEFAULT_MODEL);
  if (!localStorage.getItem(MVP_MODEL_MIGRATION_KEY)) {
    localStorage.setItem(MVP_MODEL_MIGRATION_KEY, "1");
    // The migration only touches the preference. Existing conversations are
    // always restored with their own model and harness below.
    if (shouldMigrateModelPreference) {
      localStorage.setItem("wit_model", savedModel);
      localStorage.setItem("wit_model_preference", savedModel);
    }
  }
  const savedReasoning = localStorage.getItem("wit_reasoning_preference") || localStorage.getItem("wit_reasoning") || "medium";
  const savedAccessMode = localStorage.getItem("wit_access_preference") || localStorage.getItem("wit_access") || "danger-full-access";
  const state = {
    conversations: [],
    activeId: localStorage.getItem("wit_active_conversation") || null,
    active: null,
    attachments: new Map(),
    pendingSend: null,
    sending: false,
    archiveId: null,
    lastCompletedId: null,
    model: savedModel,
    reasoning: savedReasoning,
    accessMode: savedAccessMode,
    preferredModel: savedModel,
    preferredReasoning: savedReasoning,
    preferredAccessMode: savedAccessMode,
    codexProfile: localStorage.getItem("wit_codex_profile") || "default",
    allowedCodexProfiles: ["default"],
    workDir: "",
    optimisticMessage: null,
    draftModel: null,
    draftReasoning: null,
    draftAccessMode: null,
    busy: false,
    transmitting: false,
    pausing: false,
    lastSubmittedText: "",
    supports21: false,
    nativeInitialized: false,
    nativeVersion: "",
    detailRequest: null,
    detailEntry: null,
    pendingDevelopmentWorkflowKey: "",
    developmentWorkflowJobs: new Map(),
    pendingDevelopmentAction: "",
    usage: null,
    usageLoading: false,
    authenticated: false,
    admin: false,
    bootstrapClaiming: false,
    expandedMessages: new Set(),
    cacheScope: "",
    cacheHydrated: false,
    codexAccounts: [],
    codexLoginUrl: "",
    codexLoginProfile: "",
    codexLoginTimer: null,
    appVisible: !document.hidden,
    supportsSse: false,
    capabilities: null,
    harness: "auto",
    runtimeProfiles: [],
    runtimeProfilesError: "",
    serverOverviewError: "",
    artifactOpen: false,
    artifactKey: "",
    artifactVersionIndex: -1,
    artifactMode: "preview",
    artifactFollowLatest: true,
    artifactAutoOpened: "",
    artifactDismissed: "",
    artifactSource: "",
    artifactSourceVersion: "",
    localSsh: { connected: false, connecting: false },
    localSshProfiles: [],
    localSshAdding: false,
    localSshLost: false,
    localSftpOpen: false,
    localSftpPath: ".",
    workspaceFeatures: false,
    historyResults: null,
    historyRequest: 0,
    loadingOlder: false,
    attachmentDrafts: new Map(),
    sendRequest: null,
  };
  let historySearchTimer;
  let draftSaveTimer;
  let completionReminder = false;
  try { completionReminder = localStorage.getItem("witt_completion_reminder") === "1"; } catch {}

  function draftKey(id = state.activeId) {
    return `witt_draft:${state.cacheScope || "device"}:${id || "new"}`;
  }

  function saveDraft() {
    clearTimeout(draftSaveTimer);
    try {
      const text = $("#messageInput").value;
      if (text) localStorage.setItem(draftKey(), text);
      else localStorage.removeItem(draftKey());
      state.attachmentDrafts.set(draftKey(), new Map(state.attachments));
    } catch { /* Storage may be disabled or full; keep the visible draft. */ }
  }

  function restoreDraft() {
    try { $("#messageInput").value = localStorage.getItem(draftKey()) || ""; } catch { $("#messageInput").value = ""; }
    state.attachments = new Map(state.attachmentDrafts.get(draftKey()) || []);
    $("#messageInput").style.height = "";
    renderAttachments();
  }

  function pinnedIds() {
    if (state.workspaceFeatures) return new Set(state.conversations.filter((item) => item.pinned).map((item) => item.id));
    try { return new Set(JSON.parse(localStorage.getItem(`wit_pinned_conversations:${state.cacheScope}`) || "[]")); } catch { return new Set(); }
  }

  function historyProjectName(item) {
    return item.project || "未分组";
  }

  const autumnHistoryIcons = ["leaf", "acorn", "sprout", "document-leaf"];
  function autumnHistoryIcon(item) {
    const seed = String(item?.id || item?.title || "history");
    let hash = 0;
    for (let index = 0; index < seed.length; index += 1) hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
    const icon = autumnHistoryIcons[hash % autumnHistoryIcons.length];
    return `<svg class="autumn-history-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#autumn-icon-${icon}"></use></svg>`;
  }

  function autumnPinnedIcon() {
    return '<svg class="autumn-history-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#autumn-icon-leaf"></use></svg>';
  }

  function refreshHistorySearch() {
    clearTimeout(historySearchTimer);
    const q = $("#historySearch").value.trim();
    const project = $("#historyProject").value;
    const attachments = $("#historyAttachments").checked;
    state.historyRequest += 1;
    state.historyResults = null;
    if (state.workspaceFeatures && (q || project || attachments)) {
      $("#historySearchHint").textContent = "正在搜索完整历史…";
      bridge()?.searchConversations?.(q, project, attachments, String(state.historyRequest));
    } else {
      $("#historySearchHint").textContent = state.workspaceFeatures ? "按项目整理，置顶跨设备同步" : "搜索标题与摘要 · 置顶仅保存在此设备";
    }
    renderConversations();
  }

  function renderTaskStatus() {
    const strip = $("#taskStatusStrip");
    const approval = pendingApproval();
    const last = state.active?.messages?.findLast((message) => message.role === "assistant");
    const status = approval ? { state: "waiting_confirmation", label: "等你确认" }
      : state.active?.taskStatus || { state: state.busy ? "running" : last?.status || "idle", label: state.busy ? "处理中" : last?.status === "failed" ? "执行失败" : last?.status === "interrupted" ? "已暂停" : last ? "已完成" : "准备就绪" };
    // A fresh conversation is the welcome surface, not an idle task.
    // Running tasks and approvals can precede the first assistant message.
    strip.hidden = !state.activeId || (!state.busy && !approval && !state.active?.messages?.length && (!state.active?.taskStatus || state.active.taskStatus.state === "idle"));
    strip.dataset.state = status.state;
    strip.innerHTML = `<span class="task-state-dot"></span><strong>${escapeHtml(status.label)}</strong><span class="task-origin">${escapeHtml(state.active?.activeDeviceLabel ? `${state.active.activeDeviceLabel} 发起 · 同一会话会同步` : "不同任务请使用独立对话")}</span>${approval ? '<button id="jumpToApproval" type="button">查看并确认 ↓</button>' : ""}`;
    strip.querySelector("#jumpToApproval")?.addEventListener("click", () => $("#approvalDock")?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
    const older = $("#loadOlderMessages");
    older.hidden = !state.workspaceFeatures || !state.active?.hasMore;
    older.disabled = state.loadingOlder;
    older.textContent = state.loadingOlder ? "正在加载…" : `加载更早消息${Number.isFinite(state.active?.messageOffset) ? `（还有 ${state.active.messageOffset} 条）` : ""}`;
  }

  function requestWorkspaceOverview() {
    $("#workspaceOverviewContent").textContent = state.workspaceFeatures ? "正在检查连接…" : "此功能需要支持工作区的新客户端，当前安装版本暂不支持。";
    if (state.workspaceFeatures) bridge()?.requestWorkspaceOverview?.();
  }

  function openWorkspaceOverview() {
    closeDrawer();
    $("#workspaceOverview").classList.add("open");
    $("#workspaceOverview").setAttribute("aria-hidden", "false");
    $("#closeWorkspace").focus();
    requestWorkspaceOverview();
  }

  function closeWorkspaceOverview() {
    $("#workspaceOverview").classList.remove("open");
    $("#workspaceOverview").setAttribute("aria-hidden", "true");
  }
  let pollTimer;
  let toastTimer;
  let collapseResizeTimer;
  let composerResizeObserver;
  let localTerminal;
  let localTerminalFit;
  let localTerminalResizeObserver;
  let localTerminalControlArmed = false;
  let localTerminalResizeTimer;
  let localTerminalLongPressTimer;
  let localTerminalTouchState;
  let localTerminalSuppressLinkUntil = 0;
  let localSshViewportBaseline = 0;
  let localSshManualDisconnect = false;
  const systemThemeQuery = matchMedia("(prefers-color-scheme: dark)");

  function syncComposerInset() {
    const shell = $(".app-shell");
    const composer = $(".composer-wrap");
    if (!shell || !composer) return;
    const height = Math.ceil(composer.getBoundingClientRect().height);
    if (height > 0) shell.style.setProperty("--composer-inset", `${height}px`);
  }

  function watchComposerInset() {
    syncComposerInset();
    if (typeof ResizeObserver !== "function") return;
    composerResizeObserver?.disconnect();
    composerResizeObserver = new ResizeObserver(syncComposerInset);
    composerResizeObserver.observe($(".composer-wrap"));
  }
  function applyTheme(mode, persist = false) {
    const preference = ["system", "light", "colorful", "dark"].includes(mode) ? mode : "system";
    const selected = preference === "system"
      ? (systemThemeQuery.matches ? "dark" : "light")
      : preference;
    const commit = () => {
      document.documentElement.dataset.themeMode = selected;
      document.documentElement.dataset.theme = selected;
      document.documentElement.dataset.themePreference = preference;
      if (persist) localStorage.setItem("wit_theme", preference);
      $("#themeColor")?.setAttribute("content",
        selected === "dark" ? "#1f1f1c" : "#ffffff");
      document.querySelectorAll("[data-theme-choice]").forEach((button) => {
        const active = button.dataset.themeChoice === preference;
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", String(active));
      });
      const nightButton = $("#nightModeButton");
      if (nightButton) {
        const dark = selected === "dark";
        nightButton.setAttribute("aria-pressed", String(dark));
        nightButton.setAttribute("aria-label", dark ? "关闭夜间模式" : "开启夜间模式");
      }
      if (state.nativeInitialized) bridge()?.contentReady?.(selected);
    };
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (persist && document.startViewTransition && !reducedMotion) {
      document.startViewTransition(commit);
    } else {
      commit();
    }
  }

  applyTheme(localStorage.getItem("wit_theme") ||
    document.documentElement.dataset.themePreference || "system");
  const syncSystemTheme = () => {
    if (document.documentElement.dataset.themePreference === "system") applyTheme("system");
  };
  if (typeof systemThemeQuery.addEventListener === "function") {
    systemThemeQuery.addEventListener("change", syncSystemTheme);
  } else {
    systemThemeQuery.addListener(syncSystemTheme);
  }
  requestAnimationFrame(watchComposerInset);
  function escapeHtml(value) {
    const node = document.createElement("span");
    node.textContent = String(value ?? "");
    return node.innerHTML;
  }

  function formatBytes(bytes) {
    if (!Number(bytes)) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / Math.pow(1024, index)).toFixed(index ? 1 : 0)} ${units[index]}`;
  }

  function formatDate(iso) {
    const date = new Date(iso);
    const now = new Date();
    if (date.toDateString() === now.toDateString()) {
      return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    }
    return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
  }

  function taskDurationMs(message) {
    const start = Date.parse(message.startedAt || message.createdAt || "");
    let end = Date.parse(message.completedAt || "");
    if (!Number.isFinite(end)) {
      end = Math.max(...(message.stream || [])
        .map((entry) => Date.parse(entry.createdAt || ""))
        .filter(Number.isFinite), start);
    }
    return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
  }

  function formatTaskDuration(durationMs) {
    if (!Number.isFinite(durationMs)) return "用时未知";
    const seconds = Math.max(1, Math.round(durationMs / 1000));
    if (seconds < 60) return `用时 ${seconds} 秒`;
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    if (minutes < 60) return `用时 ${minutes} 分${remainder ? ` ${remainder} 秒` : ""}`;
    const hours = Math.floor(minutes / 60);
    const minuteRemainder = minutes % 60;
    return `用时 ${hours} 小时${minuteRemainder ? ` ${minuteRemainder} 分` : ""}`;
  }

  const cacheDatabase = (() => {
    if (!("indexedDB" in window)) return Promise.resolve(null);
    return new Promise((resolve) => {
      const request = indexedDB.open("witt-local-conversations", 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("records")) {
          request.result.createObjectStore("records", { keyPath: "key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
  })();

  async function cacheRecord(key, value) {
    if (!state.cacheScope || !key) return;
    const database = await cacheDatabase;
    if (!database) return;
    await new Promise((resolve) => {
      const transaction = database.transaction("records", "readwrite");
      transaction.objectStore("records").put({
        key: `${state.cacheScope}:${key}`,
        value,
        savedAt: Date.now(),
      });
      transaction.oncomplete = resolve;
      transaction.onerror = resolve;
      transaction.onabort = resolve;
    });
  }

  async function readCachedRecord(key) {
    if (!state.cacheScope || !key) return null;
    const database = await cacheDatabase;
    if (!database) return null;
    return new Promise((resolve) => {
      const request = database.transaction("records", "readonly")
        .objectStore("records").get(`${state.cacheScope}:${key}`);
      request.onsuccess = () => resolve(request.result?.value || null);
      request.onerror = () => resolve(null);
    });
  }

  async function deleteCachedRecord(key) {
    if (!state.cacheScope || !key) return;
    const database = await cacheDatabase;
    if (!database) return;
    await new Promise((resolve) => {
      const transaction = database.transaction("records", "readwrite");
      transaction.objectStore("records").delete(`${state.cacheScope}:${key}`);
      transaction.oncomplete = resolve;
      transaction.onerror = resolve;
      transaction.onabort = resolve;
    });
  }

  function persistConversationList() {
    cacheRecord("list", state.conversations);
  }

  function persistConversation(conversation = state.active) {
    if (conversation?.id) cacheRecord(`conversation:${conversation.id}`, conversation);
  }

  async function hydrateConversationCache() {
    if (state.cacheHydrated) return;
    const scope = state.cacheScope || "";
    if (!/^[a-f0-9]{24,64}$/.test(scope)) return;
    state.cacheScope = scope;
    const cachedList = await readCachedRecord("list");
    if (Array.isArray(cachedList)) {
      state.conversations = cachedList;
      renderConversations();
    }
    const preferredId = state.activeId &&
      state.conversations.some((item) => item.id === state.activeId)
      ? state.activeId
      : state.conversations[0]?.id;
    if (preferredId) {
      const cachedConversation = await readCachedRecord(`conversation:${preferredId}`);
      if (cachedConversation?.id === preferredId) {
        state.activeId = preferredId;
        state.active = cachedConversation;
        state.model = cachedConversation.model || state.model;
        state.reasoning = cachedConversation.reasoning || state.reasoning;
        state.accessMode = cachedConversation.accessMode || state.accessMode;
        state.codexProfile = cachedConversation.codexProfile || state.codexProfile;
        state.workDir = cachedConversation.workDir || "";
        localStorage.setItem("wit_active_conversation", preferredId);
        restoreDraft();
        updateModelControls();
        setConnected(true, "已载入本地记录 · 正在同步");
        dismissBoot();
        renderMessages();
      }
    }
    state.cacheHydrated = true;
  }

  function versionLessThan(current, target) {
    const left = String(current || "").split(".").map((part) => Number.parseInt(part, 10) || 0);
    const right = String(target || "").split(".").map((part) => Number.parseInt(part, 10) || 0);
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
      if ((left[index] || 0) !== (right[index] || 0)) {
        return (left[index] || 0) < (right[index] || 0);
      }
    }
    return false;
  }

  function extension(name) {
    const ext = String(name || "").split(".").pop();
    return ext && ext !== name ? ext.slice(0, 5).toUpperCase() : "FILE";
  }

  function toast(message) {
    const node = $("#toast");
    node.textContent = message;
    node.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove("show"), 2600);
  }

  function formulaHtml(source, displayMode = false) {
    const formula = String(source || "").trim();
    if (!formula) return "";
    if (!window.katex?.renderToString) {
      return `<code class="math-fallback">${escapeHtml(formula)}</code>`;
    }
    try {
      return `<span class="math-render${displayMode ? " display" : ""}">${window.katex.renderToString(formula, {
        displayMode,
        throwOnError: false,
        strict: "ignore",
        trust: false,
        output: "htmlAndMathml",
      })}</span>`;
    } catch {
      return `<code class="math-fallback">${escapeHtml(formula)}</code>`;
    }
  }

  function safeWebUrl(value) {
    try {
      const url = new URL(String(value || "").trim());
      return ["http:", "https:"].includes(url.protocol) ? url.href : "";
    } catch {
      return "";
    }
  }

  function chatLinkHtml(label, target) {
    const url = safeWebUrl(target);
    if (!url) return escapeHtml(label || target);
    return `<a class="chat-link" href="${escapeHtml(url)}" rel="noopener noreferrer" aria-label="${escapeHtml(label || url)}，打开链接">${escapeHtml(label || url)}<span aria-hidden="true">↗</span></a>`;
  }

  function inlineRichHtml(value) {
    const fragments = [];
    const hold = (html) => {
      const token = `WITTRICH${fragments.length}TOKEN`;
      fragments.push({ token, html });
      return token;
    };
    let source = String(value || "");
    source = source.replace(/`([^`\n]+)`/g, (_, code) =>
      hold(`<code class="inline-code">${escapeHtml(code)}</code>`));
    source = source.replace(/\$\$([\s\S]+?)\$\$/g, (_, formula) =>
      hold(formulaHtml(formula, true)));
    source = source.replace(/\\\[([\s\S]+?)\\\]/g, (_, formula) =>
      hold(formulaHtml(formula, true)));
    source = source.replace(/\\\(([\s\S]+?)\\\)/g, (_, formula) =>
      hold(formulaHtml(formula, false)));
    source = source.replace(/(^|[^\\$])\$([^$\n]+?)\$/g, (_, prefix, formula) =>
      `${prefix}${hold(formulaHtml(formula, false))}`);
    source = source.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/gi, (_, label, url) =>
      hold(chatLinkHtml(label, url)));
    source = source.replace(/(^|[\s（(])((?:https?:\/\/)[^\s<>"'）)]+)/gi,
      (_, prefix, rawUrl) => {
        let url = rawUrl;
        let suffix = "";
        while (/[.,!?;:，。！？；：]$/.test(url)) {
          suffix = url.slice(-1) + suffix;
          url = url.slice(0, -1);
        }
        return `${prefix}${hold(chatLinkHtml(url, url))}${suffix}`;
      });
    let html = escapeHtml(source)
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\n/g, "<br>");
    for (const fragment of fragments) html = html.split(fragment.token).join(fragment.html);
    return html;
  }

  function codeBlockHtml(source, language = "") {
    const labels = {
      js: "JavaScript", javascript: "JavaScript", ts: "TypeScript", typescript: "TypeScript",
      jsx: "JSX", tsx: "TSX", html: "HTML", css: "CSS", json: "JSON", bash: "Bash",
      sh: "Shell", shell: "Shell", python: "Python", py: "Python", java: "Java",
      kotlin: "Kotlin", dart: "Dart", sql: "SQL", yaml: "YAML", yml: "YAML",
      markdown: "Markdown", md: "Markdown", text: "TEXT",
    };
    const rawLanguage = String(language || "").trim().split(/\s+/)[0].toLowerCase();
    const label = labels[rawLanguage] || (rawLanguage ? rawLanguage.toUpperCase() : "CODE");
    const code = String(source || "").replace(/^\n|\n$/g, "");
    return `<section class="chat-code-block">
      <header><span>${escapeHtml(label)}</span><button type="button" data-copy-code aria-label="复制代码">复制</button></header>
      <pre><code>${escapeHtml(code)}</code></pre>
    </section>`;
  }

  function markdownTableCells(line) {
    let source = String(line || "").trim();
    if (source.startsWith("|")) source = source.slice(1);
    if (source.endsWith("|") && !source.endsWith("\\|")) source = source.slice(0, -1);
    const cells = [];
    let cell = "";
    let inCode = false;
    for (let index = 0; index < source.length; index += 1) {
      const character = source[index];
      if (character === "\\" && source[index + 1] === "|") {
        cell += "|";
        index += 1;
      } else if (character === "`") {
        inCode = !inCode;
        cell += character;
      } else if (character === "|" && !inCode) {
        cells.push(cell.trim());
        cell = "";
      } else {
        cell += character;
      }
    }
    cells.push(cell.trim());
    return cells;
  }

  function markdownTableAlignment(delimiter) {
    const value = String(delimiter || "").replace(/\s/g, "");
    if (/^:-{3,}:$/.test(value)) return "center";
    if (/^-{3,}:$/.test(value)) return "right";
    return "left";
  }

  function isMarkdownTableDelimiter(line) {
    const cells = markdownTableCells(line);
    return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, "")));
  }

  function markdownTableHtml(headerLine, delimiterLine, bodyLines) {
    const headers = markdownTableCells(headerLine);
    const delimiters = markdownTableCells(delimiterLine);
    const alignments = headers.map((_, index) =>
      markdownTableAlignment(delimiters[index] || delimiters.at(-1)));
    const cellHtml = (tag, value, index) =>
      `<${tag} class="align-${alignments[index]}">${inlineRichHtml(value)}</${tag}>`;
    const head = headers.map((value, index) => cellHtml("th", value, index)).join("");
    const body = bodyLines.map((line) => {
      const cells = markdownTableCells(line);
      return `<tr>${headers.map((_, index) => cellHtml("td", cells[index] || "", index)).join("")}</tr>`;
    }).join("");
    return `<div class="chat-table-scroll" role="region" aria-label="表格，可横向滚动" tabindex="0">
      <table class="chat-table"><thead><tr>${head}</tr></thead>${body ? `<tbody>${body}</tbody>` : ""}</table>
    </div>`;
  }

  function richBlockHtml(value) {
    const lines = String(value || "").replace(/\r\n?/g, "\n").split("\n");
    const rendered = [];
    let plain = [];
    const flushPlain = () => {
      if (!plain.length) return;
      rendered.push(inlineRichHtml(plain.join("\n")));
      plain = [];
    };
    for (let index = 0; index < lines.length; index += 1) {
      const hasTableHeader = lines[index].includes("|") &&
        index + 1 < lines.length && isMarkdownTableDelimiter(lines[index + 1]);
      if (!hasTableHeader) {
        plain.push(lines[index]);
        continue;
      }
      flushPlain();
      const bodyLines = [];
      index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
        bodyLines.push(lines[index]);
        index += 1;
      }
      rendered.push(markdownTableHtml(lines[index - bodyLines.length - 2],
        lines[index - bodyLines.length - 1], bodyLines));
      index -= 1;
    }
    flushPlain();
    return rendered.join("");
  }

  function textHtml(text) {
    const source = String(text || "");
    const pattern = /```([^`\n]*)\n?([\s\S]*?)```/g;
    const rendered = [];
    let cursor = 0;
    let match;
    while ((match = pattern.exec(source))) {
      if (match.index > cursor) rendered.push(richBlockHtml(source.slice(cursor, match.index)));
      rendered.push(codeBlockHtml(match[2], match[1]));
      cursor = pattern.lastIndex;
    }
    if (cursor < source.length) rendered.push(richBlockHtml(source.slice(cursor)));
    return rendered.join("");
  }

  function setConnected(connected, label) {
    const connectionLabel = $("#connectionLabel");
    if (connectionLabel) connectionLabel.textContent = label || (connected ? "服务器在线" : "等待网络");
  }

  const modelNames = {
    [MVP_DEFAULT_MODEL]: "Grok 4.7 High",
    "gpt-6-astra": "Astra",
    "gpt-6-sol": "Sol",
    "gpt-6-luna": "Luna",
    "gpt-6.1-sol": "GPT-6.1 Sol",
    "gpt-5.6-sol": "Sol",
    "gpt-5.6-terra": "Terra",
    "gpt-5.6-luna": "Luna",
  };

  const modelDescriptions = {
    [MVP_DEFAULT_MODEL]: "Grok Build · 复杂任务",
    "gpt-6-astra": "旗舰智能 · 复杂任务",
    "gpt-6-sol": "专业编码 · 均衡推理",
    "gpt-6.1-sol": "Plus 账号组额度 · 专业编码",
    "gpt-5.6-sol": "复杂任务 · 深度推理",
    "gpt-5.6-terra": "Free 账号组额度 · 日常工作",
    "gpt-5.6-luna": "Free 账号组额度 · 快速响应",
    "gpt-6-luna": "Free 账号组额度 · 快速高效",
  };

  const sub2apiProfileNames = {
    "codex-plus": "Sol · Plus 账号额度",
    "codex-free": "Luna · Free 账号额度",
    "codex-terra": "Terra · Free 账号额度",
  };

  const reasoningMeta = {
    low: { label: "快速", code: "LOW", description: "轻量响应，适合明确、直接和低复杂度的任务。", intensity: 0 },
    medium: { label: "均衡", code: "MEDIUM", description: "适合大多数任务，在速度与分析深度之间取得平衡。", intensity: 1 },
    high: { label: "深入", code: "HIGH", description: "增加推理深度，适合多步骤分析、调试和复杂改动。", intensity: 2 },
    xhigh: { label: "极致", code: "EXTRA HIGH", description: "投入更多推理时间，处理高难度架构、审查与综合任务。", intensity: 3 },
    max: { label: "巅峰", code: "MAX", description: "接近模型的最大推理预算，适合非常复杂且高价值的任务。", intensity: 4 },
    ultra: { label: "超维", code: "ULTRA", description: "最高强度推理，优先追求完整性、深度与多路径验证。", intensity: 5 },
  };
  const quickReasoningNames = {
    low: "轻度", medium: "中", high: "高", xhigh: "极高", max: "最高", ultra: "超维",
  };

  function selectedModelCapability() {
    const models = Array.isArray(state.capabilities?.models) ? state.capabilities.models : [];
    return models.find((model) => model.id === (state.draftModel || state.model)) || null;
  }

  function serviceableModelIds() {
    return (Array.isArray(state.capabilities?.models) ? state.capabilities.models : [])
      .map((model) => String(model?.id || "").trim())
      .filter(Boolean);
  }

  function reconcileModelPreference() {
    const available = serviceableModelIds();
    if (!available.length) return;
    const preferred = String(state.preferredModel || state.model || "");
    const next = available.includes(preferred)
      ? preferred
      : available.includes(MVP_DEFAULT_MODEL) ? MVP_DEFAULT_MODEL : available[0];
    if (next !== state.preferredModel) {
      state.preferredModel = next;
      try {
        localStorage.setItem("wit_model", next);
        localStorage.setItem("wit_model_preference", next);
      } catch { /* Keep the in-memory preference when storage is unavailable. */ }
    }
    // Never replace a loaded conversation's model here. This function runs as
    // capabilities arrive, often before the conversation snapshot does.
    if (!state.activeId || !state.active) {
      state.model = next;
      state.draftModel = next;
    }
  }

  function prepareNewConversationSettings() {
    const available = serviceableModelIds();
    const preferred = String(state.preferredModel || MVP_DEFAULT_MODEL);
    const model = available.length
      ? (available.includes(preferred) ? preferred : available.includes(MVP_DEFAULT_MODEL) ? MVP_DEFAULT_MODEL : available[0])
      : preferred;
    state.model = model;
    state.preferredModel = model;
    state.reasoning = state.preferredReasoning || "high";
    state.accessMode = state.preferredAccessMode || "danger-full-access";
    state.draftModel = model;
    state.draftReasoning = state.reasoning;
    state.draftAccessMode = state.accessMode;
    state.harness = "auto";
  }

  function modelDisplayName(modelId) {
    const capability = (state.capabilities?.models || []).find((model) => model.id === modelId);
    return capability?.displayName || modelNames[modelId] || modelId;
  }

  function runtimeProfileDisplayName(profile) {
    return sub2apiProfileNames[profile?.id] || profile?.name || profile?.id || "模型配置";
  }

  function renderReasoningControl() {
    const selectedModel = selectedModelCapability();
    const offered = (selectedModel?.reasoningEfforts || [])
      .map((effort) => effort.id)
      .filter((effort) => reasoningMeta[effort]);
    const efforts = offered.length ? offered : ["low", "medium", "high", "xhigh"];
    let current = state.draftReasoning || state.reasoning;
    if (!efforts.includes(current)) {
      const preferred = selectedModel?.defaultReasoningEffort;
      current = efforts.includes(preferred) ? preferred : efforts.includes("medium") ? "medium" : efforts[0];
      state.draftReasoning = current;
    }
    const index = Math.max(0, efforts.indexOf(current));
    const meta = reasoningMeta[current] || reasoningMeta.medium;
    const control = $("#reasoningControl");
    if (!control) return;
    control.dataset.level = current;
    control.dataset.intensity = String(meta.intensity);
    control.style.setProperty("--reasoning-progress", `${((index + 0.5) / efforts.length) * 100}%`);
    control.style.setProperty("--reasoning-count", String(efforts.length));
    control.style.setProperty("--reasoning-intensity", String(meta.intensity));
    const segments = $("#reasoningSegments");
    if (segments) {
      segments.style.setProperty("--reasoning-count", String(efforts.length));
      segments.innerHTML = `
        <span class="reasoning-liquid-fill" aria-hidden="true"></span>
        <span class="reasoning-liquid-sheen" aria-hidden="true"></span>
        <i class="reasoning-liquid-orb" aria-hidden="true"></i>
        <div class="reasoning-liquid-hitbox" role="radiogroup" aria-label="在轨道上选择智能程度">
          ${efforts.map((effort) => {
            const option = reasoningMeta[effort];
            const selected = effort === current;
            return `<button type="button" data-reasoning="${escapeHtml(effort)}" role="radio" aria-checked="${selected}" aria-label="${escapeHtml(option.label)}，${escapeHtml(option.code)}"></button>`;
          }).join("")}
        </div>`;
    }
    $("#reasoningCurrentLabel").textContent = meta.label;
    $("#reasoningCurrentCode").textContent = meta.code;
    $("#reasoningDescription").textContent = meta.description;
    $("#reasoningSupportLabel").textContent = `${efforts.length} 档可用`;
    $("#reasoningStops").innerHTML = efforts.map((effort) => {
      const option = reasoningMeta[effort];
      const selected = effort === current;
      return `<button type="button" class="${selected ? "selected" : ""}" data-reasoning="${effort}" role="radio" aria-checked="${selected}" aria-label="${escapeHtml(option.label)}，${escapeHtml(option.code)}"><strong>${escapeHtml(option.label)}</strong><small>${escapeHtml(option.code)}</small></button>`;
    }).join("");
    renderQuickModelPicker();
  }

  function availableReasoningEfforts() {
    const selectedModel = selectedModelCapability();
    const offered = (selectedModel?.reasoningEfforts || [])
      .map((effort) => effort.id)
      .filter((effort) => reasoningMeta[effort]);
    return offered.length ? offered : ["low", "medium", "high", "xhigh"];
  }

  function activeRemoteWorkspace(conv = state.active) {
    if (!conv) return null;
    if (conv.remoteWorkspace) return conv.remoteWorkspace;
    if (conv.workspace_device_id) {
      return {
        deviceId: conv.workspace_device_id,
        deviceLabel: conv.workspace_device_label || conv.workspace_device_id,
        rootAlias: conv.workspace_root_alias || "workspace",
        displayPath: conv.workspace_root_display_path || "受控项目根目录",
        status: conv.workspace_binding_status || "ready",
      };
    }
    return null;
  }

  function renderQuickModelPicker() {
    const menu = $("#quickModelMenu");
    if (!menu) return;
    const models = Array.isArray(state.capabilities?.models) && state.capabilities.models.length
      ? state.capabilities.models
      : [{ id: MVP_DEFAULT_MODEL, displayName: modelNames[MVP_DEFAULT_MODEL] }];
    const selectedModel = state.draftModel || state.model;
    const selectedReasoning = state.draftReasoning || state.reasoning;
    const remote = activeRemoteWorkspace(state.active);
    const remoteLocked = Boolean(remote);

    // 远程工作区环境锁定横幅
    let lockedBanner = menu.querySelector(".quick-locked-banner");
    if (remoteLocked) {
      if (!lockedBanner) {
        lockedBanner = document.createElement("div");
        lockedBanner.className = "quick-locked-banner";
        menu.prepend(lockedBanner);
      }
      lockedBanner.hidden = false;
      const devLabel = remote.deviceLabel || remote.deviceId || "远程电脑";
      const pathLabel = remote.displayPath || remote.rootAlias || "工作区目录";
      lockedBanner.innerHTML = `
        <div class="quick-locked-head">
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          <strong>远程工作区 · 环境已锁定</strong>
        </div>
        <p class="quick-locked-desc">当前会话已绑定受控环境，设备、项目范围、Harness 与模型不可在对话中更换。</p>
        <div class="quick-locked-tags">
          <span>设备：<b>${escapeHtml(devLabel)}</b></span>
          <span>范围：<b>${escapeHtml(pathLabel)}</b></span>
          <span>Harness：<b>Grok Build</b></span>
        </div>
      `;
    } else if (lockedBanner) {
      lockedBanner.hidden = true;
    }

    const expandBtn = $("#quickModelExpand");
    if (expandBtn) {
      expandBtn.disabled = remoteLocked;
      expandBtn.classList.toggle("locked", remoteLocked);
      expandBtn.title = remoteLocked ? "远程工作区已固定模型" : "展开选择模型";
    }

    $("#quickModelCurrent").textContent = remoteLocked
      ? `${modelDisplayName(selectedModel)}（已锁定）`
      : modelDisplayName(selectedModel);

    $("#quickModelOptions").innerHTML = models.map((model) => {
      const selected = model.id === selectedModel;
      return `<button type="button" data-quick-model="${escapeHtml(model.id)}" role="radio" aria-checked="${selected}" class="quick-model-option-btn ${selected ? "selected" : ""}${remoteLocked ? " locked" : ""}" ${remoteLocked ? 'disabled aria-disabled="true"' : ""}>
        <span class="quick-option-dot" aria-hidden="true"></span>
        <span class="quick-option-label">${escapeHtml(model.displayName || modelNames[model.id] || model.id)}</span>
        <i class="quick-option-check">${selected ? "✓" : ""}</i>
      </button>`;
    }).join("");

    const efforts = availableReasoningEfforts().slice().reverse();
    $("#quickReasoningOptions").innerHTML = efforts.map((effort) => {
      const selected = effort === selectedReasoning;
      const meta = reasoningMeta[effort] || { label: effort, code: effort.toUpperCase(), description: "" };
      const shortLabel = quickReasoningNames[effort] || meta.label || effort;
      return `
        <button type="button"
          class="quick-reasoning-card ${selected ? "selected" : ""}${remoteLocked ? " locked" : ""}"
          data-quick-reasoning="${escapeHtml(effort)}"
          role="radio"
          aria-checked="${selected}"
          ${remoteLocked ? 'disabled aria-disabled="true"' : ""}>
          <span class="reasoning-radio-dot" aria-hidden="true"></span>
          <div class="reasoning-card-content">
            <div class="reasoning-card-title-row">
              <strong class="reasoning-card-name">${escapeHtml(shortLabel)} · ${escapeHtml(meta.label)}推理</strong>
              <code class="reasoning-card-code">${escapeHtml(meta.code)}</code>
            </div>
            <small class="reasoning-card-desc">${escapeHtml(meta.description)}</small>
          </div>
        </button>
      `;
    }).join("");
  }

  function renderRuntimeControls() {
    const runtime = state.capabilities?.runtime || {};
    const codexAccounts = $("#codexAccountsButton");
    if (codexAccounts && state.capabilities?.runtime) {
      codexAccounts.hidden = runtime.codex?.available !== true ||
        (!state.admin && state.allowedCodexProfiles.length < 2);
    }
    if (state.harness && state.harness !== "auto" && runtime[state.harness]?.available === false) {
      state.harness = "auto";
    }
    const profileHost = $("#runtimeProfileOptions");
    const remote = activeRemoteWorkspace(state.active);
    const remoteLocked = Boolean(remote);
    if (profileHost) {
      if (state.runtimeProfilesError) {
        profileHost.innerHTML = `
          <div class="runtime-status-card error" role="status">
            <span class="runtime-status-text">${escapeHtml(state.runtimeProfilesError)}</span>
            <button type="button" class="runtime-retry-btn" id="retryRuntimeProfiles">重试读取</button>
          </div>
        `;
        const retryBtn = $("#retryRuntimeProfiles");
        if (retryBtn) {
          retryBtn.addEventListener("click", (event) => {
            event.stopPropagation();
            retryBtn.disabled = true;
            retryBtn.textContent = "正在读取…";
            void loadRuntimeExtras();
          });
        }
      } else if (!state.runtimeProfiles.length) {
        profileHost.innerHTML = '<span class="runtime-empty" role="status">暂无可用 Runtime Profile</span>';
      } else {
        const selectedModel = state.draftModel || state.model;
        const availableModels = serviceableModelIds();
        const capabilitiesKnown = Boolean(state.capabilities);
        const hasSub2ApiRouting = state.runtimeProfiles.some((profile) => sub2apiProfileNames[profile?.id]);
        const routingHelp = hasSub2ApiRouting
          ? '<p class="runtime-routing-help">自动分配额度：GPT-6.1 Sol 使用 Plus；Luna、Terra 使用 Free。</p>'
          : "";
        profileHost.innerHTML = routingHelp + state.runtimeProfiles.map((profile) => {
          const selected = profile.model === selectedModel && (state.harness || "auto") === "auto";
          const runtimeUnavailable = capabilitiesKnown
            ? Boolean(profile.harness && runtime[profile.harness]?.available !== true)
            : profile.harness !== "grok-build";
          const modelUnavailable = capabilitiesKnown
            ? !availableModels.includes(profile.model)
            : profile.model !== MVP_DEFAULT_MODEL;
          const unavailable = remoteLocked || runtimeUnavailable || modelUnavailable;
          const profileName = runtimeProfileDisplayName(profile);
          const label = remoteLocked
            ? `${profileName}（已锁定）`
            : (unavailable ? `${profileName}（暂不可用）` : profileName);
          return `<button type="button" data-runtime-profile="${escapeHtml(profile.id)}" role="radio" aria-checked="${selected}" aria-disabled="${unavailable}" class="${selected ? "selected" : ""}${unavailable ? " unavailable" : ""}${remoteLocked ? " locked" : ""}"${unavailable ? " disabled" : ""}><span>${escapeHtml(label)}</span><small>${escapeHtml(modelDisplayName(profile.model))}</small></button>`;
        }).join("");
      }
    }
    document.querySelectorAll("[data-harness]").forEach((button) => {
      const id = button.dataset.harness || "auto";
      const status = id === "auto" ? null : runtime[id];
      const runtimeUnavailable = Boolean(status && status.available === false);
      const unavailable = remoteLocked || runtimeUnavailable;
      button.disabled = unavailable;
      button.setAttribute("aria-disabled", String(unavailable));
      button.classList.toggle("unavailable", unavailable);
      button.classList.toggle("locked", remoteLocked);
      const note = button.querySelector("small");
      if (note) {
        note.dataset.defaultText ||= note.textContent;
        note.textContent = remoteLocked
          ? "远程会话已固定"
          : (unavailable
            ? (id === "google-antigravity" ? "Gemini 暂未启用" : "当前不可用")
            : note.dataset.defaultText);
      }
      button.classList.toggle("selected", id === (state.harness || "auto"));
    });
  }

  function renderServerOverview(payload) {
    const host = $("#serverCenterStatus");
    if (!host) return;
    if (!payload) {
      host.textContent = state.serverOverviewError || "服务器概览暂时不可用，聊天功能不受影响。";
      return;
    }
    const memory = payload.memory || {};
    const totalBytes = Number(memory.totalBytes || memory.total || 0);
    const usedBytes = Number(memory.usedBytes || memory.used || 0);
    const used = totalBytes ? Math.round((usedBytes / totalBytes) * 100) : 0;
    const services = Array.isArray(payload.http) ? payload.http : (Array.isArray(payload.services) ? payload.services : []);
    host.innerHTML = `<div class="app-server-metrics"><div><strong>${Number(payload.cpu?.count || 0)}</strong><small>CPU</small></div><div><strong>${used}%</strong><small>Memory</small></div><div><strong>${Math.round(Number(payload.uptimeSeconds || 0) / 3600)}h</strong><small>Uptime</small></div></div><small>${services.map((service) => `${escapeHtml(service.name || "服务")}: ${escapeHtml(service.status || "unknown")}`).join(" · ") || "暂无服务状态"}</small>`;
    const checked = $("#serverCenterChecked");
    if (checked) checked.textContent = payload.checkedAt ? new Date(payload.checkedAt).toLocaleString("zh-CN") : "已检查";
    const link = $("#openWebuiLink");
    if (link) {
      if (payload.openWebuiUrl) {
        link.hidden = false;
        link.href = payload.openWebuiUrl;
        link.target = "_blank";
          link.rel = "noopener noreferrer";
      } else {
        link.hidden = true;
      }
    }
  }

  async function loadVersionInfo() {
    const readSha = async (url, field) => {
      const response = await fetch(url, { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) return "";
      const body = await response.json();
      const sha = String(body?.[field] || "").toLowerCase();
      return /^[a-f0-9]{7,40}$/.test(sha) ? sha : "";
    };
    const [backend, frontend] = await Promise.allSettled([
      readSha("/vault-api/version", "backendSha"),
      readSha("/vault/version.json", "frontendSha"),
    ]);
    const backendSha = backend.status === "fulfilled" ? backend.value : "";
    const frontendSha = frontend.status === "fulfilled" ? frontend.value : "";
    $("#backendVersionSha").textContent = backendSha ? backendSha.slice(0, 8) : "unknown";
    $("#frontendVersionSha").textContent = frontendSha ? frontendSha.slice(0, 8) : "unknown";
    $("#deploymentVersionStatus").textContent = !backendSha || !frontendSha
      ? "版本未知" : backendSha === frontendSha ? "前后端一致" : "前后端不一致";
  }

  function friendlyRuntimeError(error, defaultMsg = "Runtime Profile 暂时不可用（聊天功能不受影响）") {
    const raw = String(error?.message || error || "").trim();
    if (!raw || /failed to fetch|networkerror|load failed|network request failed|fetch failed/i.test(raw)) {
      return defaultMsg;
    }
    if (/404/.test(raw)) {
      return defaultMsg.includes("服务器概览")
        ? "未检测到服务器概览接口（404）"
        : "未检测到配置的 Runtime Profile（404）";
    }
    if (/500|502|503|504/.test(raw)) return "服务暂时无响应，请稍后重试";
    if (/timeout|timed out/i.test(raw)) return "网络请求超时，请稍后重试";
    if (/unauthorized|forbidden|401|403/i.test(raw)) return "访问未授权或权限不足";
    return defaultMsg;
  }

  async function loadRuntimeExtras() {
    void loadVersionInfo();
    state.runtimeProfilesError = "";
    state.serverOverviewError = "";
    renderRuntimeControls();
    try {
      const profiles = await fetch("/vault-api/runtime/profiles", { credentials: "same-origin", cache: "no-store" });
      if (!profiles.ok) throw new Error(`Runtime Profile 暂时不可用（${profiles.status}）`);
      const body = await profiles.json();
      state.runtimeProfiles = Array.isArray(body.profiles) ? body.profiles : [];
    } catch (error) {
      state.runtimeProfiles = [];
      state.runtimeProfilesError = friendlyRuntimeError(error, "Runtime Profile 暂时不可用（聊天功能不受影响）");
    }
    renderRuntimeControls();
    try {
      const overview = await fetch("/vault-api/servers/overview", { credentials: "same-origin", cache: "no-store" });
      if (!overview.ok) throw new Error(`服务器概览暂时不可用（${overview.status}）`);
      renderServerOverview(await overview.json());
    } catch (error) {
      state.serverOverviewError = friendlyRuntimeError(error, "服务器概览暂时不可用，聊天功能不受影响。");
      renderServerOverview(null);
    }
  }

  function renderCapabilities() {
    const capabilities = state.capabilities;
    const serverLive = $("#appServerLive");
    if (serverLive) {
      serverLive.classList.remove("offline");
      serverLive.innerHTML = "<i></i>ONLINE";
    }
    const actions = ["#forkConversationButton", "#compactConversationButton", "#reviewConversationButton"];
    actions.forEach((selector) => {
      const button = $(selector);
      if (button) button.disabled = !state.activeId || state.busy || !state.active?.hasCodexContext;
    });
    if (!capabilities) {
      renderReasoningControl();
      renderRuntimeControls();
      return;
    }
    const models = Array.isArray(capabilities.models) ? capabilities.models : [];
    reconcileModelPreference();
    if (models.length) {
      models.forEach((model) => {
        modelNames[model.id] = modelNames[model.id] || model.displayName || model.id;
      });
      $(".model-options").innerHTML = models.map((model) => {
        const name = model.displayName || model.id;
        const shortName = modelNames[model.id] || name;
        const glyph = shortName.slice(0, 1).toUpperCase() || "✦";
        const efforts = (model.reasoningEfforts || []).length;
        const description = modelDescriptions[model.id] || "由 App Server 动态提供";
        const selectedClass = model.id === (state.draftModel || state.model) ? "selected" : "";
        const selected = Boolean(selectedClass);
        return `<button type="button" class="${selectedClass}" data-model="${escapeHtml(model.id)}" role="radio" aria-checked="${selected}"><span class="model-glyph ${escapeHtml(shortName.toLowerCase())}">${escapeHtml(glyph)}</span><span><strong>${escapeHtml(shortName)}</strong><small>${escapeHtml(description)}</small><em>${efforts || 4} 档智能程度</em></span><i></i></button>`;
      }).join("");
    }
    renderReasoningControl();
    renderQuickModelPicker();
    renderRuntimeControls();
    const enabledSkills = (capabilities.skills || []).filter((skill) => skill.enabled).length;
    const connectedMcp = (capabilities.mcpServers || []).filter((server) =>
      !["failed", "error", "disabled"].includes(server.status)).length;
    const enabledFeatures = (capabilities.features || []).filter((feature) => feature.enabled).length;
    const featureNames = (capabilities.features || [])
      .filter((feature) => feature.enabled)
      .map((feature) => feature.displayName || feature.name)
      .filter(Boolean)
      .slice(0, 3)
      .map((name) => String(name).replaceAll("_", " "));
    $("#appServerStatus").innerHTML = `
      <div class="app-server-metrics">
        <div><strong>${models.length}</strong><small>动态模型</small></div>
        <div><strong>${enabledSkills}</strong><small>Skills</small></div>
        <div><strong>${connectedMcp}</strong><small>MCP 在线</small></div>
        <div><strong>${enabledFeatures}</strong><small>运行特性</small></div>
      </div>
      <div class="app-server-sync">
        <span><i></i>能力已实时同步</span>
        <small>${escapeHtml(featureNames.join(" · ") || "Codex runtime ready")}</small>
      </div>`;
  }
  const reasoningNames = Object.fromEntries(Object.entries(reasoningMeta).map(([id, meta]) => [id, meta.label]));
  const accessNames = {
    "danger-full-access": "完全访问",
    "workspace-write": "项目读写",
    "read-only": "只读",
  };
  const projects = {
    "": "空白",
    "/home/ubuntu/Documents/Codex/2026-07-20-skill/upload-app": "Chloe",
    "/home/ubuntu/Documents/Codex/2026-07-26-xlsb": "年报",
    "/data/xuanyu-build-console/repo": "玄遇",
  };

  function projectName(workDir) {
    const remote = activeRemoteWorkspace(state.active);
    if (remote) return `远程 · ${remote.displayPath || remote.rootAlias || "工作区"}`;
    return projects[String(workDir || "")] || "自定义项目";
  }

  function formatTokens(value) {
    const tokens = Math.max(0, Number(value || 0));
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}M`;
    if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 100_000 ? 0 : 1)}K`;
    return Math.round(tokens).toLocaleString("zh-CN");
  }

  function isProPlan(rate = {}) {
    const plan = String(rate.planType || "").trim().toLowerCase().replace(/[_-]+/g, " ");
    return plan === "prolite" || plan.split(/\s+/).includes("pro");
  }

  function rateLimitWindows(rate = {}) {
    const windows = [rate.primary, rate.secondary, ...(Array.isArray(rate.additional) ? rate.additional : [])]
      .filter(Boolean);
    const duration = (item) => Math.max(0, Number(item?.windowDurationMins || 0));
    const pro = isProPlan(rate);
    const fiveHour = pro ? null : windows.find((item) => duration(item) >= 240 && duration(item) <= 360)
      || (rate.primary && duration(rate.primary) < 24 * 60 ? rate.primary : null);
    const weekly = windows.find((item) => duration(item) >= 6 * 24 * 60 && duration(item) <= 8 * 24 * 60)
      || (rate.secondary && rate.secondary !== fiveHour ? rate.secondary : null);
    return { fiveHour, weekly, pro };
  }

  function rateLimitUsed(item) {
    return item ? Math.max(0, Math.min(100, Math.round(Number(item.usedPercent || 0)))) : null;
  }

  function rateLimitResetAt(item) {
    return item?.resetsAt ? new Date(item.resetsAt * 1000).toLocaleString("zh-CN", {
      month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
    }) : "暂未提供";
  }

  function updateQuotaStatus() {
    const button = $("#quotaButton");
    const { fiveHour, weekly, pro } = rateLimitWindows(state.usage?.rateLimits || {});
    const fiveHourUsed = rateLimitUsed(fiveHour);
    const weeklyUsed = rateLimitUsed(weekly);
    if (fiveHourUsed === null && weeklyUsed === null) {
      button.hidden = true;
      return;
    }
    button.hidden = false;
    button.classList.toggle("pro-quota", pro);
    const fiveHourLabel = $("#fiveHourQuotaLabel");
    const weeklyLabel = $("#weeklyQuotaLabel");
    fiveHourLabel.hidden = pro || fiveHourUsed === null;
    weeklyLabel.hidden = weeklyUsed === null;
    if (fiveHourUsed !== null) fiveHourLabel.textContent = `5小时 ${fiveHourUsed}%`;
    if (weeklyUsed !== null) weeklyLabel.textContent = `${pro ? "Pro · 本周" : "本周"} ${weeklyUsed}%`;
    button.setAttribute("aria-label", `查看 Codex 额度：${[
      pro || fiveHourUsed === null ? "" : `五小时已用 ${fiveHourUsed}%`,
      weeklyUsed === null ? "" : `${pro ? "Pro " : ""}本周已用 ${weeklyUsed}%`,
    ].filter(Boolean).join("，")}`);
  }

  function refreshUsage() {
    const selected = selectedModelCapability();
    const harness = selected?.harness || (/^(gpt|deepseek)-/.test(state.model) ? "codex" : "");
    if (harness && harness !== "codex") {
      state.usage = null;
      state.usageLoading = false;
      updateQuotaStatus();
      renderUsage();
      return;
    }
    if (state.usageLoading || typeof bridge()?.requestUsage !== "function") return;
    state.usageLoading = true;
    bridge().requestUsage(state.activeId || "");
  }

  function dismissBoot() {
    const boot = $("#bootScreen");
    if (!boot || boot.classList.contains("leaving")) return;
    bridge()?.contentReady?.(document.documentElement.dataset.themeMode || "light");
    boot.classList.add("leaving");
    setTimeout(() => boot.remove(), 520);
  }

  function applyPrincipalPolicy(principal = {}) {
    const profiles = principal.admin
      ? [...CODEX_PROFILE_IDS]
      : Array.isArray(principal.codexProfiles) && principal.codexProfiles.length
        ? principal.codexProfiles.filter((profile) => CODEX_PROFILE_IDS.includes(profile))
        : ["default"];
    state.allowedCodexProfiles = profiles.length ? profiles : ["default"];
    if (!state.allowedCodexProfiles.includes(state.codexProfile)) {
      state.codexProfile = state.allowedCodexProfiles[0];
      localStorage.setItem("wit_codex_profile", state.codexProfile);
    }
    const xuanyuOnly = state.allowedCodexProfiles.length === 1 &&
      state.allowedCodexProfiles[0] === "xuanyu";
    const title = $("#drawerNewChat strong");
    const subtitle = $("#drawerNewChat small");
    if (title) title.textContent = xuanyuOnly ? "新建玄遇对话" : "新建对话";
    if (subtitle) subtitle.textContent =
      xuanyuOnly ? "使用玄遇专用 Codex 账号" : "开启一个独立上下文";
  }

  function updateModelControls() {
    const remote = activeRemoteWorkspace(state.active);
    const envPill = $("#composerEnvPill");
    if (envPill) {
      if (remote) {
        envPill.textContent = `远程 · ${remote.deviceLabel || remote.rootAlias || "工作区"}`;
        envPill.classList.add("is-remote");
        envPill.title = `已绑定远程设备：${remote.deviceLabel || ""}，项目：${remote.displayPath || remote.rootAlias || ""}`;
      } else {
        envPill.textContent = state.workDir ? `本地 · ${projectName(state.workDir)}` : "服务器";
        envPill.classList.remove("is-remote");
        envPill.title = "服务器运行环境";
      }
    }
    $("#modelLabel").textContent = modelDisplayName(state.model) || "Grok";
    $("#reasoningLabel").textContent = reasoningNames[state.reasoning] || "均衡";
    $("#accessLabel").textContent = accessNames[state.accessMode] || "完全访问";
    $("#projectLabel").textContent = projectName(state.workDir);
    $("#moreProjectLabel").textContent = projectName(state.workDir);
    const remoteLocked = Boolean(remote);
    ["#projectButton", "#moreProjectButton"].forEach((selector) => {
      const button = $(selector);
      if (button) button.disabled = remoteLocked;
    });
    const modelBtn = $("#modelButton");
    if (modelBtn) {
      modelBtn.disabled = false;
      modelBtn.classList.toggle("is-remote-locked", remoteLocked);
      modelBtn.title = remoteLocked ? "远程开发工作区（环境与模型已锁定，点击查看）" : "选择模型与智能程度";
    }

    // 同步抽屉设置面板锁定状态
    let sheetBanner = $("#settingsLockedBanner");
    const settingsScroll = $(".settings-panel .settings-scroll");
    if (remoteLocked && remote) {
      if (!sheetBanner && settingsScroll) {
        sheetBanner = document.createElement("div");
        sheetBanner.id = "settingsLockedBanner";
        sheetBanner.className = "settings-locked-banner";
        settingsScroll.prepend(sheetBanner);
      }
      if (sheetBanner) {
        sheetBanner.hidden = false;
        sheetBanner.innerHTML = `
          <div class="settings-locked-head">
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            <strong>远程开发工作区 · 配置已锁定</strong>
          </div>
          <p class="settings-locked-desc">当前对话已固定绑定受控环境，设备、项目范围、Harness 与模型不可在对话中更换。</p>
          <div class="settings-locked-tags">
            <span>设备：<b>${escapeHtml(remote.deviceLabel || remote.deviceId || "受控电脑")}</b></span>
            <span>范围：<b>${escapeHtml(remote.displayPath || remote.rootAlias || "项目根目录")}</b></span>
            <span>Harness：<b>Grok Build</b></span>
            <span>模型：<b>${escapeHtml(modelDisplayName(state.model))}</b></span>
          </div>
        `;
      }
      document.querySelectorAll(".model-options > button, #harnessOptions > button, .access-options > button").forEach((btn) => {
        btn.disabled = true;
        btn.setAttribute("aria-disabled", "true");
        btn.classList.add("locked");
      });
      const reasoningConsole = $("#reasoningControl");
      if (reasoningConsole) reasoningConsole.classList.add("locked");
      const saveBtn = $("#saveSettings");
      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.innerHTML = "<span>当前配置已锁定</span><i>远程工作区配置在会话创建时固定</i>";
      }
    } else {
      if (sheetBanner) sheetBanner.hidden = true;
      document.querySelectorAll(".model-options > button.locked, #harnessOptions > button.locked, .access-options > button.locked").forEach((btn) => {
        btn.disabled = false;
        btn.removeAttribute("aria-disabled");
        btn.classList.remove("locked");
      });
      const reasoningConsole = $("#reasoningControl");
      if (reasoningConsole) reasoningConsole.classList.remove("locked");
      const saveBtn = $("#saveSettings");
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.innerHTML = "<span>应用到当前对话</span><i>当前设置将立即生效</i>";
      }
    }

    document.querySelectorAll("[data-model]").forEach((button) =>
      button.classList.toggle("selected", button.dataset.model === (state.draftModel || state.model)));
    document.querySelectorAll("[data-access]").forEach((button) =>
      button.classList.toggle("selected", button.dataset.access === state.draftAccessMode));
    renderCapabilities();
  }

  function persistModelPreference() {
    state.preferredModel = state.model;
    state.preferredReasoning = state.reasoning;
    state.preferredAccessMode = state.accessMode;
    localStorage.setItem("wit_model", state.model);
    localStorage.setItem("wit_reasoning", state.reasoning);
    localStorage.setItem("wit_access", state.accessMode);
    localStorage.setItem("wit_model_preference", state.model);
    localStorage.setItem("wit_reasoning_preference", state.reasoning);
    localStorage.setItem("wit_access_preference", state.accessMode);
  }

  function openProject() {
    if (!state.activeId) {
      toast("请稍候，正在创建新对话");
      return;
    }
    if (state.busy) {
      toast("当前任务完成后再切换项目");
      return;
    }
    document.querySelectorAll("[data-project-path]").forEach((button) =>
      button.classList.toggle("selected", button.dataset.projectPath === (state.workDir || "")));
    $("#projectSheet").classList.add("open");
    $("#projectSheet").setAttribute("aria-hidden", "false");
  }

  function closeProject() {
    $("#projectSheet").classList.remove("open");
    $("#projectSheet").setAttribute("aria-hidden", "true");
  }

  function renderUsage() {
    const payload = state.usage;
    if (!payload) {
      const codex = selectedModelCapability()?.harness === "codex" || /^(gpt|deepseek)-/.test(state.model);
      $("#usageContent").innerHTML = codex
        ? `<div class="usage-loading"><i></i><span>正在读取 Codex 用量</span></div>`
        : `<div class="usage-error"><strong>当前模型使用 CPA 服务</strong><small>Grok 与 Gemini 额度见上方。Codex 用量会在使用 GPT 时读取。</small></div>`;
      return;
    }
    const summary = payload.summary || {};
    const rate = payload.rateLimits || {};
    const { fiveHour, weekly, pro } = rateLimitWindows(rate);
    const resetCredits = Math.max(0, Number(rate.resetCredits || 0));
    const renderRateLimit = (label, item, colorful = false) => {
      const used = rateLimitUsed(item);
      const remaining = used === null ? null : 100 - used;
      return item ? `<section class="weekly-quota-summary${colorful ? " pro-quota-summary" : ""}"><div><small>${label} · 已用 ${used}%</small><strong>剩余 ${remaining}%</strong></div><span>下次重置：${rateLimitResetAt(item)}</span><i role="progressbar" aria-label="剩余额度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${remaining}"><b style="width:${remaining}%"></b></i></section>` : "";
    };
    const rateLimitSummary = [
      pro ? "" : renderRateLimit("五小时额度", fiveHour),
      renderRateLimit(pro ? "Pro 本周额度" : "本周额度", weekly, pro),
    ]
      .filter(Boolean).join("");
    const actionCard = `
      <section class="quota-actions quota-compact">
        ${rateLimitSummary ? `<div class="rate-limit-summaries">${rateLimitSummary}</div>` : ""}
        <div class="quota-action-row">
          <div><b>重置额度窗口</b><small>${resetCredits ? `可用 ${resetCredits} 次 · ${pro ? "重置本周额度" : "重置当前额度窗口"}` : "当前没有可用的重置额度"}</small></div>
          ${resetCredits ? `<button class="quota-reset glow-reset" data-reset-rate-limit><i></i><span>确认重置</span><em>✦</em></button>` : `<button class="quota-reset" disabled>暂无额度</button>`}
        </div>
      </section>`;
    const buckets = new Map((payload.dailyUsageBuckets || [])
      .map((bucket) => [bucket.startDate, Math.max(0, Number(bucket.tokens || 0))]));
    const peak = Math.max(1, ...buckets.values());
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const mondayOffset = (today.getDay() + 6) % 7;
    const currentMonday = new Date(today);
    currentMonday.setDate(today.getDate() - mondayOffset);
    let recentTokens = 0;
    let recentActiveDays = 0;
    for (let offset = 0; offset < 7; offset += 1) {
      const date = new Date(today);
      date.setDate(today.getDate() - offset);
      const key = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
      const tokens = buckets.get(key) || 0;
      recentTokens += tokens;
      if (tokens > 0) recentActiveDays += 1;
    }
    const recentActivity = Math.round(recentActiveDays / 7 * 100);
    const start = new Date(currentMonday);
    start.setDate(currentMonday.getDate() - (15 * 7));
    const weeks = [];
    for (let week = 0; week < 16; week += 1) {
      const days = [];
      for (let day = 0; day < 7; day += 1) {
        const date = new Date(start);
        date.setDate(start.getDate() + week * 7 + day);
        const key = [
          date.getFullYear(),
          String(date.getMonth() + 1).padStart(2, "0"),
          String(date.getDate()).padStart(2, "0"),
        ].join("-");
        const tokens = buckets.get(key) || 0;
        const level = tokens ? Math.max(1, Math.min(4, Math.ceil(tokens / peak * 4))) : 0;
        const future = date > today;
        days.push(`<button class="usage-day level-${future ? 0 : level}" data-usage-date="${key}" data-usage-tokens="${tokens}" ${future ? "disabled" : ""} aria-label="${key} ${tokens} tokens"></button>`);
      }
      weeks.push(`<span class="usage-week">${days.join("")}</span>`);
    }
    $("#usageContent").innerHTML = `
      <section class="usage-stats">
        <article class="usage-stat lifetime"><i>Σ</i><small>累计 Token</small><strong>${formatTokens(summary.lifetimeTokens)}</strong></article>
        <article class="usage-stat streak"><i>↗</i><small>连续使用</small><strong>${Number(summary.currentStreakDays || 0)}<em> 天</em></strong></article>
        <article class="usage-stat peak"><i>◆</i><small>单日峰值</small><strong>${formatTokens(summary.peakDailyTokens)}</strong></article>
      </section>
      ${actionCard}
      <section class="usage-card">
        <header><div><strong>每日使用</strong><small>最近 16 周</small></div><span>${Number(summary.longestStreakDays || 0)} 天最长连续</span></header>
        <div class="usage-board">
          <div class="usage-weekdays"><span>一</span><span>三</span><span>五</span><span>日</span></div>
          <div class="usage-grid">${weeks.join("")}</div>
          <aside class="usage-insight"><i style="--activity:${recentActivity}%"><b>${recentActiveDays}<small>/7</small></b></i><span><small>近 7 天</small><strong>${formatTokens(recentTokens)}</strong><em>${recentActiveDays ? `${recentActiveDays} 天有记录` : "等待首次使用"}</em></span></aside>
        </div>
        <footer><span>每天完成一点，就会在这里留下颜色</span><div>少<i class="level-0"></i><i class="level-1"></i><i class="level-2"></i><i class="level-3"></i><i class="level-4"></i>多</div></footer>
      </section>`;
  }

  function openProfile() {
    closeDrawer();
    $("#profileSheet").classList.add("open");
    $("#profileSheet").setAttribute("aria-hidden", "false");
    renderUsage();
    refreshUsage();
    $("#profileSheet .profile-panel").scrollTop = 0;
  }

  function renderAdminDevices(devices = []) {
    $("#deviceList").innerHTML = devices.length ? devices.map((device) => `
      <article class="device-row"><span>⌁</span><div><strong>${escapeHtml(device.label || "未命名设备")}</strong><small>${device.disabled ? "已停止访问" : `最近活跃：${formatDate(device.lastSeenAt || device.createdAt)}`}</small></div>${device.disabled ? "" : `<button data-disable-device="${escapeHtml(device.id)}">停止</button>`}</article>`).join("")
      : `<small>还没有已激活的设备。</small>`;
  }

  function closeProfile() {
    $("#profileSheet").classList.remove("open");
    $("#profileSheet").setAttribute("aria-hidden", "true");
  }

  function syncLocalSshPanels() {
    const connected = Boolean(state.localSsh.connected);
    const hasProfiles = state.localSshProfiles.length > 0;
    const sftpOpen = connected && state.localSftpOpen;
    $("#localSshLibrary").hidden = connected || state.localSshAdding || state.localSshLost;
    $("#localSshConnectForm").hidden = connected || !state.localSshAdding || state.localSshLost;
    $("#localTerminal").hidden = sftpOpen || (!connected && !state.localSshLost);
    $("#localSftp").hidden = !sftpOpen;
    $("#cancelLocalSshProfile").hidden = !hasProfiles;
    $("#disconnectLocalSsh").hidden = !connected;
  }

  function setLocalSshAdding(adding) {
    state.localSshAdding = Boolean(adding) || state.localSshProfiles.length === 0;
    syncLocalSshPanels();
  }

  function renderLocalSshProfiles(payload = {}) {
    state.localSshProfiles = Array.isArray(payload.profiles) ? payload.profiles : [];
    if (!state.localSshProfiles.length && !state.localSsh.connected) state.localSshAdding = true;
    const activeId = state.localSsh.profileId || "";
    $("#localSshProfiles").innerHTML = state.localSshProfiles.length
      ? state.localSshProfiles.map((profile) => {
          const connecting = Boolean(state.localSsh.connecting) && profile.id === activeId;
          const label = profile.label || profile.host || "服务器";
          const mark = label.trim().slice(0, 2).toUpperCase();
          return `<article class="local-ssh-profile${connecting ? " connecting" : ""}">
            <button class="local-ssh-profile-connect" type="button" data-connect-ssh-profile="${escapeHtml(profile.id)}">
              <i class="local-ssh-profile-mark">${escapeHtml(mark)}</i>
              <span class="local-ssh-profile-copy"><strong>${escapeHtml(label)}</strong><small>${escapeHtml(profile.username || "root")}@${escapeHtml(profile.host)}:${Number(profile.port || 22)}</small></span>
              <em class="local-ssh-profile-state">${connecting ? "连接中" : "连接"}</em>
            </button>
            <button class="local-ssh-profile-delete" type="button" data-delete-ssh-profile="${escapeHtml(profile.id)}" aria-label="删除 ${escapeHtml(label)}">×</button>
          </article>`;
        }).join("")
      : `<p class="local-ssh-empty">添加第一台服务器，连接成功后即可一触登录。</p>`;
    syncLocalSshPanels();
  }

  function localSftpChild(directory, name) {
    const base = directory === "/" ? "" : String(directory || ".").replace(/\/$/, "");
    return `${base}/${name}`;
  }

  function localSftpParent(path) {
    const normalized = String(path || "/").replace(/\/+$/, "") || "/";
    if (normalized === "/") return "/";
    const slash = normalized.lastIndexOf("/");
    return slash <= 0 ? "/" : normalized.slice(0, slash);
  }

  function renderLocalSftp(payload = {}) {
    const path = payload.path || state.localSftpPath || ".";
    const entries = Array.isArray(payload.entries) ? payload.entries : [];
    state.localSftpPath = path;
    $("#localSftpPath").textContent = path;
    $("#localSftpParent").disabled = path === "/";
    $("#localSftpList").innerHTML = entries.length ? entries.map((entry) => {
      const child = localSftpChild(path, entry.name);
      const details = entry.directory ? "文件夹" : `${formatBytes(entry.size)} · ${formatDate(entry.modifiedAt)}`;
      return `<article class="local-sftp-entry">
        <button class="local-sftp-open" type="button" data-sftp-${entry.directory ? "directory" : "file"}="${escapeHtml(child)}">
          <i>${entry.directory ? "▰" : "▤"}</i><span><strong>${escapeHtml(entry.name)}</strong><small>${escapeHtml(details)}</small></span>
        </button>
        ${entry.directory ? "" : `<button class="local-sftp-download" type="button" data-sftp-download="${escapeHtml(child)}" data-sftp-name="${escapeHtml(entry.name)}">下载</button>`}
      </article>`;
    }).join("") : `<p>这个目录是空的。</p>`;
  }

  function openLocalSftp(path = state.localSftpPath || ".") {
    if (!state.localSsh.connected) return;
    hideLocalTerminalContext(true);
    state.localSftpOpen = true;
    syncLocalSshPanels();
    $("#localSftpList").innerHTML = "<p>正在读取远程文件…</p>";
    bridge()?.requestLocalSftp?.(path);
  }

  function closeLocalSftp() {
    state.localSftpOpen = false;
    syncLocalSshPanels();
    requestAnimationFrame(() => {
      fitLocalTerminal();
      localTerminal?.focus();
    });
  }

  function syncLocalSshViewport() {
    const sheet = $("#localSshSheet");
    if (!sheet.classList.contains("open")) return;
    const viewport = window.visualViewport;
    const visibleHeight = Math.round(viewport?.height || window.innerHeight);
    const offsetTop = Math.round(viewport?.offsetTop || 0);
    if (!localSshViewportBaseline) localSshViewportBaseline = window.innerHeight;
    const overlayInset = Math.max(0, Math.round(window.innerHeight - visibleHeight - offsetTop));
    const resizedInset = Math.max(0, localSshViewportBaseline - window.innerHeight);
    const keyboardOpen = Math.max(overlayInset, resizedInset) > 72;
    sheet.style.setProperty("--local-visible-height", `${visibleHeight}px`);
    sheet.style.setProperty("--local-viewport-top", `${offsetTop}px`);
    sheet.classList.toggle("keyboard-open", keyboardOpen);
    fitLocalTerminal();
  }

  function renderLocalSsh(payload = state.localSsh) {
    state.localSsh = { ...state.localSsh, ...payload };
    const connected = Boolean(state.localSsh.connected);
    const connecting = Boolean(state.localSsh.connecting);
    if (connected) state.localSshLost = false;
    if (!connected) state.localSftpOpen = false;
    $("#localSshConnectButton").disabled = connecting;
    $("#localSshConnectButton span").textContent = connecting ? "正在连接" : "保存并连接";
    $("#localSshDrawerStatus").textContent = connected
      ? `${state.localSsh.username || "root"}@${state.localSsh.host}` : "本地终端";
    $("#localTerminalTarget").textContent = connected
      ? `${state.localSsh.username || "root"}@${state.localSsh.host}` : "服务器";
    syncLocalSshPanels();
    if (connected) {
      requestAnimationFrame(() => {
        ensureLocalTerminal();
        fitLocalTerminal();
        localTerminal?.focus();
      });
    }
    requestAnimationFrame(syncLocalSshViewport);
  }

  function setLocalTerminalControl(armed) {
    localTerminalControlArmed = Boolean(armed);
    $("#localTerminalControl")?.classList.toggle("active", localTerminalControlArmed);
    $("#localTerminalControl")?.setAttribute("aria-pressed", String(localTerminalControlArmed));
  }

  function sendLocalTerminalInput(data) {
    if (!data) return;
    if (state.localSshLost) return;
    let input = data;
    if (localTerminalControlArmed && data.length === 1) {
      const code = data.toUpperCase().charCodeAt(0);
      if (code >= 64 && code <= 95) input = String.fromCharCode(code - 64);
      setLocalTerminalControl(false);
    }
    bridge()?.sendLocalSshInput?.(input);
  }

  function fitLocalTerminal() {
    if (!localTerminal || !localTerminalFit || $("#localTerminal").hidden) return;
    clearTimeout(localTerminalResizeTimer);
    localTerminalResizeTimer = setTimeout(() => {
      try {
        localTerminalFit.fit();
        bridge()?.resizeLocalSsh?.(localTerminal.cols, localTerminal.rows);
      } catch (_error) {}
    }, 40);
  }

  function hideLocalTerminalContext(clearSelection = false) {
    const menu = $("#localTerminalContext");
    if (menu) menu.hidden = true;
    if (clearSelection) localTerminal?.clearSelection();
  }

  function localTerminalCellAt(clientX, clientY) {
    if (!localTerminal) return null;
    const screen = $("#localTerminalOutput .xterm-screen");
    const rect = screen?.getBoundingClientRect();
    if (!rect?.width || !rect.height) return null;
    const pointX = Number.isFinite(Number(clientX)) ? Number(clientX) : rect.left + rect.width / 2;
    const pointY = Number.isFinite(Number(clientY)) ? Number(clientY) : rect.top + rect.height / 2;
    const column = Math.max(0, Math.min(localTerminal.cols - 1,
      Math.floor(((pointX - rect.left) / rect.width) * localTerminal.cols)));
    const viewportRow = Math.max(0, Math.min(localTerminal.rows - 1,
      Math.floor(((pointY - rect.top) / rect.height) * localTerminal.rows)));
    const viewportY = Number(localTerminal.buffer.active.viewportY) || 0;
    return { column: Math.trunc(column), row: Math.trunc(viewportY + viewportRow) };
  }

  function localTerminalAdjacentCell(position, direction) {
    if (!localTerminal) return null;
    const buffer = localTerminal.buffer.active;
    if (direction < 0) {
      if (position.column > 0) return { row: position.row, column: position.column - 1 };
      if (position.row > 0 && buffer.getLine(position.row)?.isWrapped) {
        return { row: position.row - 1, column: localTerminal.cols - 1 };
      }
      return null;
    }
    if (position.column < localTerminal.cols - 1) {
      return { row: position.row, column: position.column + 1 };
    }
    if (position.row + 1 < buffer.length && buffer.getLine(position.row + 1)?.isWrapped) {
      return { row: position.row + 1, column: 0 };
    }
    return null;
  }

  function localTerminalCellText(position) {
    return localTerminal?.buffer.active.getLine(position.row)
      ?.getCell(position.column)?.getChars() || " ";
  }

  function selectLocalTerminalWordAt(clientX, clientY) {
    const touched = localTerminalCellAt(clientX, clientY);
    if (!touched || !localTerminal) return false;
    if (/\s/.test(localTerminalCellText(touched))) {
      localTerminal.select(touched.column, touched.row, 1);
      return true;
    }
    let start = touched;
    let end = touched;
    for (let previous = localTerminalAdjacentCell(start, -1);
      previous && !/\s/.test(localTerminalCellText(previous));
      previous = localTerminalAdjacentCell(start, -1)) start = previous;
    for (let next = localTerminalAdjacentCell(end, 1);
      next && !/\s/.test(localTerminalCellText(next));
      next = localTerminalAdjacentCell(end, 1)) end = next;
    const length = ((end.row - start.row) * localTerminal.cols) + end.column - start.column + 1;
    localTerminal.select(Math.trunc(start.column), Math.trunc(start.row),
      Math.max(1, Math.trunc(length)));
    return true;
  }

  function showLocalTerminalContext(clientX, clientY) {
    const menu = $("#localTerminalContext");
    if (!menu) return;
    if (menu.parentElement !== document.body) document.body.appendChild(menu);
    menu.hidden = false;
    const viewport = window.visualViewport;
    const bounds = {
      left: viewport?.offsetLeft || 0,
      top: viewport?.offsetTop || 0,
      width: viewport?.width || window.innerWidth,
      height: viewport?.height || window.innerHeight,
    };
    const anchorX = Number.isFinite(Number(clientX)) ? Number(clientX) : bounds.left + bounds.width / 2;
    const anchorY = Number.isFinite(Number(clientY)) ? Number(clientY) : bounds.top + bounds.height / 2;
    const terminalTop = $("#localTerminalOutput")?.getBoundingClientRect().top;
    const safeTop = Math.max(bounds.top + 8,
      Number.isFinite(terminalTop) ? terminalTop + 8 : bounds.top + 8);
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const left = Math.max(bounds.left + 8,
      Math.min(anchorX - width / 2, bounds.left + bounds.width - width - 8));
    let top = anchorY - height - 14;
    if (top < safeTop) top = anchorY + 14;
    top = Math.max(safeTop,
      Math.min(top, bounds.top + bounds.height - height - 8));
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
  }

  async function copyLocalTerminalSelection() {
    const text = localTerminal?.getSelection() || "";
    if (!text) {
      toast("请先长按选择终端内容");
      return false;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast("已复制选中内容");
      return true;
    } catch (_error) {
      toast("复制失败，请重试");
      return false;
    }
  }

  async function pasteLocalTerminalClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) {
        toast("剪贴板里没有文字");
        return false;
      }
      localTerminal?.paste(text);
      return true;
    } catch (_error) {
      toast("无法读取剪贴板，请检查系统权限");
      return false;
    }
  }

  function installLocalTerminalContextMenu() {
    const output = $("#localTerminalOutput");
    if (!output || output.dataset.contextMenuReady === "true") return;
    output.dataset.contextMenuReady = "true";
    const cancelLongPress = () => {
      clearTimeout(localTerminalLongPressTimer);
      localTerminalLongPressTimer = null;
    };
    output.addEventListener("touchstart", (event) => {
      if (event.touches.length !== 1) {
        cancelLongPress();
        return;
      }
      const touch = event.touches[0];
      hideLocalTerminalContext();
      localTerminalTouchState = {
        x: touch.clientX,
        y: touch.clientY,
        longPressed: false,
      };
      cancelLongPress();
      localTerminalLongPressTimer = setTimeout(() => {
        if (!localTerminalTouchState) return;
        localTerminalTouchState.longPressed = selectLocalTerminalWordAt(
          localTerminalTouchState.x, localTerminalTouchState.y);
        if (!localTerminalTouchState.longPressed) return;
        localTerminalSuppressLinkUntil = Date.now() + 900;
        navigator.vibrate?.(12);
        showLocalTerminalContext(localTerminalTouchState.x, localTerminalTouchState.y);
      }, 520);
    }, { capture: true, passive: true });
    output.addEventListener("touchmove", (event) => {
      if (!localTerminalTouchState || event.touches.length !== 1) return;
      const touch = event.touches[0];
      const distance = Math.hypot(
        touch.clientX - localTerminalTouchState.x,
        touch.clientY - localTerminalTouchState.y,
      );
      if (distance > 9 && !localTerminalTouchState.longPressed) cancelLongPress();
      if (localTerminalTouchState.longPressed) {
        event.preventDefault();
        event.stopPropagation();
      }
    }, { capture: true, passive: false });
    const finishTouch = (event) => {
      cancelLongPress();
      if (localTerminalTouchState?.longPressed) {
        event.preventDefault();
        event.stopPropagation();
        localTerminalSuppressLinkUntil = Date.now() + 900;
      }
      localTerminalTouchState = null;
    };
    output.addEventListener("touchend", finishTouch, { capture: true, passive: false });
    output.addEventListener("touchcancel", finishTouch, { capture: true, passive: false });
    output.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!localTerminal?.hasSelection()) selectLocalTerminalWordAt(event.clientX, event.clientY);
      showLocalTerminalContext(event.clientX, event.clientY);
    }, true);
    output.addEventListener("click", (event) => {
      if (Date.now() < localTerminalSuppressLinkUntil) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
  }

  function openLocalTerminalLink(_event, uri) {
    if (Date.now() < localTerminalSuppressLinkUntil || !/^https?:\/\//i.test(uri)) return;
    hideLocalTerminalContext(true);
    window.location.href = uri;
  }

  async function handleLocalTerminalContextAction(action) {
    if (action === "select-all") {
      localTerminal?.selectAll();
      return;
    }
    if (action === "copy") await copyLocalTerminalSelection();
    if (action === "paste") await pasteLocalTerminalClipboard();
    hideLocalTerminalContext();
    if (action === "paste") localTerminal?.focus();
  }

  function ensureLocalTerminal() {
    if (localTerminal) return localTerminal;
    if (typeof window.Terminal !== "function" || !window.FitAddon?.FitAddon ||
        !window.WebLinksAddon?.WebLinksAddon) {
      toast("终端组件加载失败，请重新打开");
      return null;
    }
    localTerminal = new window.Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      cursorWidth: 2,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 7,
      lineHeight: 1.22,
      letterSpacing: 0,
      scrollback: 6000,
      allowTransparency: true,
      theme: {
        background: "#e5eaed",
        foreground: "#292d3d",
        cursor: "#303444",
        cursorAccent: "#e5eaed",
        selectionBackground: "#9eb6c099",
        black: "#252936",
        red: "#a84f59",
        green: "#36735d",
        yellow: "#8a6e2f",
        blue: "#365e8a",
        magenta: "#76518c",
        cyan: "#2f7077",
        white: "#d5dbdf",
        brightBlack: "#68737c",
        brightRed: "#b76069",
        brightGreen: "#43866e",
        brightYellow: "#9b7e3a",
        brightBlue: "#46709d",
        brightMagenta: "#89649d",
        brightCyan: "#3f8289",
        brightWhite: "#f5f7f8",
      },
    });
    localTerminalFit = new window.FitAddon.FitAddon();
    localTerminal.loadAddon(localTerminalFit);
    localTerminal.loadAddon(new window.WebLinksAddon.WebLinksAddon(openLocalTerminalLink));
    localTerminal.open($("#localTerminalOutput"));
    installLocalTerminalContextMenu();
    localTerminal.onData(sendLocalTerminalInput);
    if (typeof ResizeObserver === "function") {
      localTerminalResizeObserver = new ResizeObserver(fitLocalTerminal);
      localTerminalResizeObserver.observe($("#localTerminalOutput"));
    }
    return localTerminal;
  }

  function openLocalSsh() {
    closeDrawer();
    if (versionLessThan(state.nativeVersion, "2.2.16")) {
      toast("请先更新 Chloe 后使用本地终端");
      bridge()?.checkForUpdates?.();
      return;
    }
    $("#localSshSheet").classList.add("open");
    $("#localSshSheet").setAttribute("aria-hidden", "false");
    localSshViewportBaseline = window.innerHeight;
    bridge()?.requestLocalSshStatus?.();
    bridge()?.requestLocalSshProfiles?.();
    requestAnimationFrame(syncLocalSshViewport);
  }

  function closeLocalSsh() {
    hideLocalTerminalContext(true);
    $("#localSshSheet").classList.remove("open");
    $("#localSshSheet").classList.remove("keyboard-open");
    $("#localSshSheet").style.removeProperty("--local-visible-height");
    $("#localSshSheet").style.removeProperty("--local-viewport-top");
    $("#localSshSheet").setAttribute("aria-hidden", "true");
    localSshViewportBaseline = 0;
  }

  function appendLocalTerminal(text) {
    ensureLocalTerminal()?.write(String(text || ""));
  }

  function openAdminSettings() {
    if (!state.admin) return;
    closeDrawer();
    $("#adminSettingsSheet").classList.add("open");
    $("#adminSettingsSheet").setAttribute("aria-hidden", "false");
    bridge()?.requestAdminDevices?.();
  }

  function closeAdminSettings() {
    $("#adminSettingsSheet").classList.remove("open");
    $("#adminSettingsSheet").setAttribute("aria-hidden", "true");
  }

  function codexAccountLabel(profileId) {
    return state.codexAccounts.find((account) => account.id === profileId)?.label || profileId || "子账号";
  }

  function codexAccountAvatar(profileId) {
    if (profileId === "default") return "W";
    if (profileId === "xuanyu") return "玄";
    const number = String(profileId || "").match(/\d+$/)?.[0];
    return number || "·";
  }

  function renderCodexAccounts(accounts = []) {
    state.codexAccounts = accounts;
    $("#codexAccountList").innerHTML = accounts.map((account) => {
      const signedIn = Boolean(account.authenticated);
      const canLogin = state.admin && account.id !== "default";
      const detail = signedIn
        ? `${account.account?.email || "已登录"}${account.account?.planType ? ` · ${account.account.planType}` : ""}`
        : "尚未登录";
      const action = signedIn
        ? `<div class="codex-account-actions">${canLogin
          ? `<button class="relogin" data-login-codex="${escapeHtml(account.id)}">重新登录</button>` : ""}
          <button class="new-chat" data-new-codex-chat="${escapeHtml(account.id)}">新建对话</button></div>`
        : canLogin
          ? `<div class="codex-account-actions"><button class="login" data-login-codex="${escapeHtml(account.id)}">登录账号</button></div>`
          : "";
      return `<article class="codex-account-card ${account.id === "default" ? "primary" : "additional"}">
        <span class="codex-account-avatar">${escapeHtml(codexAccountAvatar(account.id))}</span>
        <div class="codex-account-identity"><strong>${escapeHtml(account.label || account.id)}</strong><small>${escapeHtml(detail)}</small></div>
        ${action}
      </article>`;
    }).join("") || `<article class="codex-account-card"><span class="codex-account-avatar">!</span><div class="codex-account-identity"><strong>暂无账号信息</strong><small>请稍后重试</small></div></article>`;
  }

  function setCodexLoginFlow(open) {
    const active = Boolean(open);
    $("#codexAccountList").hidden = active;
    $("#codexAccountSheet .codex-account-intro").hidden = active;
    $("#codexLoginFlow").hidden = !active;
    if (active) requestAnimationFrame(() => $("#codexLoginFlow").scrollIntoView({ block: "start" }));
  }

  function openCodexAccounts() {
    if (!state.admin && !state.allowedCodexProfiles.length) return;
    closeDrawer();
    $("#codexAccountSheet").classList.add("open");
    $("#codexAccountSheet").setAttribute("aria-hidden", "false");
    setCodexLoginFlow(Boolean(state.codexLoginTimer));
    bridge()?.requestCodexAccounts?.();
  }

  function stopCodexLoginPolling() {
    if (state.codexLoginTimer) clearInterval(state.codexLoginTimer);
    state.codexLoginTimer = null;
  }

  function closeCodexAccounts() {
    $("#codexAccountSheet").classList.remove("open");
    $("#codexAccountSheet").setAttribute("aria-hidden", "true");
  }

  function codexLoginAction(action, profileId = state.codexLoginProfile) {
    const profile = CODEX_PROFILE_IDS.includes(profileId) ? profileId : "xuanyu";
    const modernMethods = {
      start: "startCodexLogin",
      status: "requestCodexLoginStatus",
      cancel: "cancelCodexLogin",
    };
    const legacyMethods = {
      start: "startXuanyuCodexLogin",
      status: "requestXuanyuCodexLoginStatus",
      cancel: "cancelXuanyuCodexLogin",
    };
    const currentBridge = bridge();
    if (versionLessThan(state.nativeVersion, "2.2.19")) {
      if (profile !== "xuanyu") {
        toast("请先更新 Chloe 后登录更多账号");
        currentBridge?.checkForUpdates?.();
        return false;
      }
      currentBridge?.[legacyMethods[action]]?.();
      return true;
    }
    currentBridge?.[modernMethods[action]]?.(profile);
    return true;
  }

  function pollCodexLogin() {
    codexLoginAction("status");
  }

  function startCodexLoginPolling() {
    stopCodexLoginPolling();
    state.codexLoginTimer = setInterval(pollCodexLogin, 2200);
  }

  function openQuotaResetConfirm() {
    $("#quotaConfirm").classList.add("open");
    $("#quotaConfirm").setAttribute("aria-hidden", "false");
  }

  function closeQuotaResetConfirm() {
    $("#quotaConfirm").classList.remove("open");
    $("#quotaConfirm").setAttribute("aria-hidden", "true");
  }

  function consumeQuotaReset() {
    closeQuotaResetConfirm();
    if (typeof bridge()?.consumeRateLimitReset !== "function") {
      toast("请先更新 Chloe 后再使用重置额度");
      bridge()?.checkForUpdates?.();
      return;
    }
    bridge().consumeRateLimitReset(state.activeId || "");
  }

  function openSettings() {
    if (state.busy) {
      toast("当前任务完成后再切换设置");
      return;
    }
    state.draftModel = state.model;
    state.draftReasoning = state.reasoning;
    state.draftAccessMode = state.accessMode;
    updateModelControls();
    void loadVersionInfo();
    $("#settingsSheet").classList.add("open");
    $("#settingsSheet").setAttribute("aria-hidden", "false");
  }

  function setQuickModelMenu(open) {
    const menu = $("#quickModelMenu");
    const expanded = Boolean(open);
    menu.classList.toggle("open", expanded);
    menu.classList.remove("models-open");
    menu.setAttribute("aria-hidden", String(!expanded));
    $("#modelButton").setAttribute("aria-expanded", String(expanded));
    $("#quickModelExpand").setAttribute("aria-expanded", "false");
  }

  function applySettings({ closeSheet = true, announce = true } = {}) {
    if (Boolean(activeRemoteWorkspace(state.active))) {
      if (closeSheet) closeSettings();
      return;
    }
    state.model = state.draftModel || state.model;
    state.reasoning = state.draftReasoning || state.reasoning;
    state.accessMode = state.draftAccessMode || state.accessMode;
    persistModelPreference();
    updateModelControls();
    if (state.activeId) {
      if (state.supports21) {
        bridge()?.updateConversationSettings?.(
          state.activeId, state.model, state.reasoning, state.accessMode, state.harness || "auto");
      } else {
        bridge()?.updateConversationSettings?.(state.activeId, state.model, state.reasoning);
      }
    }
    if (closeSheet) closeSettings();
    if (announce) toast(`已切换 · ${modelDisplayName(state.model)} · ${reasoningNames[state.reasoning]}`);
  }

  function closeSettings() {
    $("#settingsSheet").classList.remove("open");
    $("#settingsSheet").setAttribute("aria-hidden", "true");
  }

  function setChatMoreMenu(open) {
    const menu = $("#chatMoreMenu");
    const visible = Boolean(open);
    if (visible) {
      $("#chatMoreTitle").textContent = state.active?.title || "当前对话";
      const pinned = pinnedIds();
      $("#morePinLabel").textContent = pinned.has(state.activeId) ? "取消置顶" : "置顶";
    }
    menu.classList.toggle("open", visible);
    menu.setAttribute("aria-hidden", String(!visible));
    $("#chatMoreButton").setAttribute("aria-expanded", String(visible));
  }

  function openDrawer() {
    if (document.body.classList.contains("web-browser") && window.matchMedia("(min-width: 1000px)").matches) {
      document.body.classList.remove("sidebar-collapsed");
      $("#drawer").setAttribute("aria-hidden", "false");
      return;
    }
    $("#drawer").classList.add("open");
    $("#drawer").setAttribute("aria-hidden", "false");
  }

  function closeDrawer() {
    $("#drawer").classList.remove("open");
    const desktop = document.body.classList.contains("web-browser") && window.matchMedia("(min-width: 1000px)").matches;
    const hidden = desktop ? document.body.classList.contains("sidebar-collapsed") : true;
    $("#drawer").setAttribute("aria-hidden", String(hidden));
  }

  function allArtifacts() {
    return (state.active?.messages || []).flatMap((message) =>
      (message.artifacts || []).map((artifact) => ({ ...artifact, messageId: message.id })));
  }

  function renderDeliveries() {
    const artifacts = allArtifacts();
    $("#deliveryBadge").textContent = artifacts.length;
    $("#deliverySummary").textContent = artifacts.length ? `${artifacts.length} 个可下载文件` : "当前对话暂无文件";
    $("#deliveryButton").classList.toggle("has-files", artifacts.length > 0);
    $("#deliveryBadge").hidden = !artifacts.length;
    $("#deliveryList").innerHTML = artifacts.length
      ? artifacts.slice().reverse().map((artifact) => `
        <button class="delivery-file" data-artifact="${artifact.id}" data-message="${artifact.messageId}">
          <span class="delivery-type">${extension(artifact.name)}</span>
          <span class="delivery-file-copy"><strong>${escapeHtml(artifact.name)}</strong><small>${formatBytes(artifact.size)}<i></i>来自当前对话</small></span>
          <span class="delivery-download"><svg viewBox="0 0 24 24"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14"/></svg></span>
        </button>`).join("")
      : `<div class="delivery-empty"><span>↓</span><strong>暂无交付文件</strong><p>需要文件时直接告诉我“把它放到交付区”。</p></div>`;
  }

  function openDelivery() {
    renderDeliveries();
    $("#deliverySheet").classList.add("open");
    $("#deliverySheet").setAttribute("aria-hidden", "false");
  }

  function closeDelivery() {
    $("#deliverySheet").classList.remove("open");
    $("#deliverySheet").setAttribute("aria-hidden", "true");
  }

  function openActionDetail(messageId, entryId, label) {
    state.detailRequest = { messageId, entryId };
    state.detailEntry = null;
    $("#actionDetailTitle").textContent = label || "执行详情";
    $("#actionDetailContent").innerHTML = `<div class="detail-loading"><i></i><span>正在读取详情</span></div>`;
    $("#actionDetailSheet").classList.add("open");
    $("#actionDetailSheet").setAttribute("aria-hidden", "false");
    if (typeof bridge()?.requestStreamDetail !== "function") {
      $("#actionDetailContent").innerHTML = `<div class="detail-error">请先更新到新版 App，再查看执行详情。</div>`;
      bridge()?.checkForUpdates?.();
      return;
    }
    bridge().requestStreamDetail(state.activeId, messageId, entryId);
  }

  function closeActionDetail() {
    state.detailRequest = null;
    state.detailEntry = null;
    $("#actionDetailSheet").classList.remove("open");
    $("#actionDetailSheet").setAttribute("aria-hidden", "true");
  }

  function openImageViewer(url, name, mimeType = "") {
    if (!url) return;
    $("#imageViewerImage").src = url;
    $("#imageViewerImage").alt = name || "Chloe 图片";
    $("#imageViewerName").textContent = name || "Chloe 图片";
    $("#downloadImageViewer").dataset.url = url;
    $("#downloadImageViewer").dataset.name = name || "Chloe 图片";
    $("#downloadImageViewer").dataset.mimeType = mimeType;
    $("#imageViewer").classList.add("open");
    $("#imageViewer").setAttribute("aria-hidden", "false");
  }

  function closeImageViewer() {
    $("#imageViewer").classList.remove("open");
    $("#imageViewer").setAttribute("aria-hidden", "true");
    $("#imageViewerImage").removeAttribute("src");
    delete $("#downloadImageViewer").dataset.url;
  }

  function detailBlock(title, value, className = "") {
    if (value === null || value === undefined || value === "") return "";
    return `<section class="detail-block ${className}"><h3>${escapeHtml(title)}</h3><pre>${escapeHtml(value)}</pre></section>`;
  }

  function developmentWorkflowKey(conversationId, messageId) {
    return `${conversationId || ""}:${messageId || ""}`;
  }

  function developmentWorkflowLabel(job) {
    if (!job) return "尚未开始";
    const statusLabels = {
      queued: "已排队", pending: "等待开始", running: "正在执行",
      awaiting_commit_confirmation: "测试通过，等待提交确认",
      awaiting_deploy_confirmation: "已推送，等待部署确认",
      restart_queued: "等待延迟重启", restarting: "服务重启中",
      completed: "已完成", succeeded: "已完成", failed: "执行失败",
      cancelled: "已取消", canceled: "已取消",
    };
    const stageLabels = {
      test: "测试", testing: "测试", staging: "准备提交", commit: "提交",
      committing: "提交", push: "推送", pushing: "推送", deploy: "部署",
      restart: "重启", restart_queued: "等待重启", restarting: "重启",
      health: "健康检查", health_check: "健康检查",
    };
    const parts = [
      statusLabels[String(job.status || "").toLowerCase()] || job.status || "",
      stageLabels[String(job.stage || "").toLowerCase()] || job.stage || "",
      job.message || job.failureReason || job.error || "",
    ].filter(Boolean);
    return parts.join(" · ") || "正在处理";
  }

  function developmentWorkflowMarkup(entry, details, changes) {
    const conversation = state.active;
    const conversationId = conversation?.id;
    const messageId = state.detailRequest?.messageId;
    const message = conversation?.messages?.find((item) => item.id === messageId);
    const latestAssistant = conversation?.messages?.filter((item) => item.role === "assistant").at(-1);
    const latestUser = conversation?.messages?.filter((item) => item.role === "user").at(-1);
    const taskSummary = String(latestUser?.text || "更新项目文件").replace(/\s+/g, " ").trim().slice(0, 72) || "更新项目文件";
    const commitSeed = `Chloe: ${taskSummary}`;
    const branch = conversation?.gitBranch || conversation?.branch ||
      details.branch || details.gitBranch || entry.branch || "";
    const allowedHarness = ["grok-build", "codex"].includes(conversation?.harnessId);
    const incompleteChanges = Number(details.omitted || 0) > 0 ||
      Number(details.baselineUnavailable || 0) > 0 || Boolean(details.baselineDirty || details.branchChanged) || changes.some((change) => {
      const kind = String(change.kind || "").toLowerCase();
      const deleted = ["delete", "deleted"].includes(kind);
      return Boolean(change.baselineDirty || change.baselineUnavailable || change.afterHashUnavailable) ||
        (!deleted && !change.afterHash);
    });
    if (!conversationId || !messageId || state.activeId !== conversationId ||
        !state.admin || state.busy || conversation.busy || conversation.workDir !== "/opt/witt" ||
        !allowedHarness || branch !== "platform/personal-ai-ops" ||
        message?.status !== "completed" || latestAssistant?.id !== messageId ||
        entry.id !== "turn-git-changes" || entry.kind !== "file" ||
        entry.status !== "completed" || !changes.length || incompleteChanges) return "";

    const key = developmentWorkflowKey(conversationId, messageId);
    const savedJob = state.developmentWorkflowJobs.get(key);
    const streamJobEntry = message?.stream?.findLast((item) =>
      ["development_workflow", "workflow"].includes(item.kind));
    const streamJob = streamJobEntry
      ? { ...(streamJobEntry.details || {}), ...(streamJobEntry.job || {}),
        id: streamJobEntry.jobId || streamJobEntry.job?.id || streamJobEntry.details?.id,
        sha: streamJobEntry.sha || streamJobEntry.job?.sha || streamJobEntry.details?.sha,
        status: streamJobEntry.status || streamJobEntry.job?.status || streamJobEntry.details?.status,
        stage: streamJobEntry.stage || streamJobEntry.job?.stage || streamJobEntry.details?.stage,
        message: streamJobEntry.message || streamJobEntry.job?.message || streamJobEntry.details?.message,
        failureReason: streamJobEntry.failureReason || streamJobEntry.job?.failureReason ||
          streamJobEntry.details?.failureReason || streamJobEntry.details?.error,
      }
      : null;
    // Persisted stream events are the recovery source of truth. The bridge map
    // only fills the gap before the first stream update reaches the conversation.
    const job = streamJob || savedJob;
    const running = job && ["queued", "pending", "running", "restart_queued", "restarting"].includes(String(job.status || "").toLowerCase());
    const finished = job && ["completed", "succeeded"].includes(String(job.status || "").toLowerCase());
    const canRetry = job && ["failed", "cancelled", "canceled"].includes(String(job.status || "").toLowerCase());
    const canResumePush = Boolean(canRetry && job?.sha && job?.id);
    const canDeploy = Boolean(job?.id && job?.sha &&
      String(job.status || "").toLowerCase() === "awaiting_deploy_confirmation");
    const canCommit = Boolean(job?.id && !job?.sha &&
      String(job.status || "").toLowerCase() === "awaiting_commit_confirmation");
    const canCancelRunning = Boolean(running && job?.id && !job?.sha &&
      !["committing", "pushing", "restart_queued", "restarting", "health_check"].includes(job.stage));
    const launchLabel = canRetry ? "重新运行测试" : "运行测试";
    return `
      <section class="development-workflow" data-workflow-key="${escapeHtml(key)}">
        <strong>项目交付</strong>
        <p>先对 ${escapeHtml(branch)} 本轮变更运行测试；测试通过后分别确认提交推送与部署。</p>
        ${job ? `<p class="development-workflow-status" data-development-workflow-status data-workflow-key="${escapeHtml(key)}" role="status" aria-live="polite">${escapeHtml(developmentWorkflowLabel(job))}</p>` : ""}
        ${canCancelRunning ? `<button type="button" class="secondary development-workflow-stop" data-workflow-stop data-job-id="${escapeHtml(job.id)}">取消交付</button>` : ""}
        ${canResumePush ? `<button type="button" class="development-workflow-launch" data-workflow-prepare-resume>准备重试推送</button>
          <div class="development-workflow-confirm" data-workflow-resume-confirm-panel hidden>
            <p>上次提交已创建但推送未完成。确认后仅重试推送产品分支。</p>
            <div><button type="button" class="secondary" data-workflow-cancel-resume>返回</button><button type="button" data-workflow-resume-push data-job-id="${escapeHtml(job.id)}">确认重试推送</button></div>
          </div>` : ""}
        ${canCommit ? `<button type="button" class="development-workflow-launch" data-workflow-prepare-commit>准备提交并推送</button>
          <div class="development-workflow-confirm" data-workflow-commit-confirm-panel hidden>
            <p>测试已通过。请再次确认本轮 Diff 与提交说明；确认后将精确暂存、创建提交并推送产品分支。</p>
            <label class="development-workflow-commit-label">提交说明<input type="text" maxlength="120" data-workflow-commit-message value="${escapeHtml(commitSeed)}"></label>
            <div><button type="button" class="secondary" data-workflow-cancel-commit>暂不提交</button><button type="button" data-workflow-confirm-commit data-job-id="${escapeHtml(job.id)}">确认提交并推送</button></div>
          </div>` : ""}
        ${canDeploy ? `<button type="button" class="development-workflow-launch" data-workflow-prepare-deploy>准备部署</button>
          <div class="development-workflow-confirm" data-workflow-deploy-confirm-panel hidden>
            <p>已提交并推送到产品分支。确认后将重启 Chloe 服务并检查健康状态；也可以暂不部署。</p>
            <div><button type="button" class="secondary" data-workflow-cancel-deploy>暂不部署</button><button type="button" data-workflow-confirm-deploy data-job-id="${escapeHtml(job.id)}">确认部署并重启</button></div>
          </div>` : ""}
        ${finished || canResumePush || canCommit || canDeploy ? "" : running
          ? ""
          : `<button type="button" class="development-workflow-launch" data-workflow-prepare>${launchLabel}</button>
            <div class="development-workflow-confirm" data-workflow-confirm-panel hidden>
              <p>确认后仅运行测试；不会提交、推送、部署或重启服务。</p>
              <div><button type="button" class="secondary" data-workflow-cancel>返回</button><button type="button" data-workflow-confirm-send>确认运行测试</button></div>
            </div>`}
      </section>`;
  }

  function renderActionDetail(entry) {
    const details = entry.details || {};
    if (entry.kind === "command" || entry.kind === "tool" || entry.kind === "thought") {
      const status = entry.status === "completed" ? "已完成"
        : entry.status === "failed" ? "失败" : "执行中";
      const exitCode = Number.isInteger(details.exitCode) ? details.exitCode : null;
      const failure = details.error || details.failureReason || details.reason || "";
      const meta = [
        status,
        exitCode !== null ? `退出码 ${exitCode}` : "",
        Number.isInteger(details.durationMs) ? `${(details.durationMs / 1000).toFixed(2)} 秒` : "",
      ].filter(Boolean).join(" · ");
      $("#actionDetailTitle").textContent = entry.kind === "thought" ? "思考过程详情"
        : entry.kind === "tool" ? "工具执行详情" : "命令执行详情";
      $("#actionDetailContent").innerHTML = `
        <div class="detail-summary"><span>${entry.kind === "command" ? "⌘" : "✦"}</span><div><strong>${escapeHtml(meta)}</strong><small>${escapeHtml(details.cwd || details.workDir || (entry.kind === "thought" ? "深度思考与分析" : "未提供工作目录"))}</small></div></div>
        ${entry.kind === "thought" ? "" : detailBlock(entry.kind === "tool" ? "工具" : "完整命令", details.command || details.tool || entry.label, "command")}
        ${failure ? detailBlock("失败原因", failure, "failure") : ""}
        ${detailBlock(entry.kind === "thought" ? "思考内容" : "执行输出", details.thought || details.output || "该操作没有输出", "output")}`;
      return;
    }

    const changes = Array.isArray(details.changes) ? details.changes : [];
    const kindNames = {
      add: "新增", added: "新增", create: "新增",
      update: "修改", modified: "修改",
      delete: "删除", deleted: "删除",
      rename: "重命名", renamed: "重命名",
      untracked: "未跟踪文本",
    };
    const fileSize = (value) => {
      if (value === null || value === undefined || value === "") return "";
      const bytes = Number(value);
      return Number.isFinite(bytes) && bytes >= 0 ? formatBytes(bytes) : "";
    };
    $("#actionDetailTitle").textContent = changes.length
      ? `本轮文件变更 · ${changes.length} 个` : "本轮文件变更";
    $("#actionDetailContent").innerHTML = changes.length
      ? changes.map((change) => {
        const kind = String(change.kind || "update").toLowerCase();
        const isRename = ["rename", "renamed"].includes(kind) || Boolean(change.oldPath || change.movePath);
        const isUntracked = kind === "untracked" || Boolean(change.untracked);
        const label = isUntracked ? kindNames.untracked : isRename ? kindNames.rename : (kindNames[kind] || "修改");
        const className = isUntracked ? "untracked" : isRename ? "rename" : kind;
        const oldPath = change.oldPath || (isRename ? change.movePath : "");
        const path = change.path || change.newPath || oldPath || "未知路径";
        const size = fileSize(change.bytes);
        const flags = [
          change.binary ? "二进制文件，无法显示文本 Diff" : "",
          change.large ? `大文件${size ? `（${size}）` : ""}，Diff 可能不完整` : "",
          change.truncated ? "Diff 已截断，仅显示部分内容" : "",
          change.baselineUnavailable ? "基线超过采集上限，无法准确归因" : "",
        ].filter(Boolean);
        const diff = typeof change.diff === "string" ? change.diff : "";
        const diffHtml = diff && !change.binary
          ? `<pre>${escapeHtml(diff)}</pre>`
          : flags.length
            ? ""
            : `<p class="file-change-empty">没有可显示的文本 Diff</p>`;
        return `
          <article class="file-change-detail">
            <header><span class="${escapeHtml(className)}">${escapeHtml(label)}</span><strong>${escapeHtml(path)}</strong></header>
            ${oldPath && oldPath !== path ? `<p class="file-change-path">原路径：${escapeHtml(oldPath)}</p>` : ""}
            ${size ? `<p class="file-change-size">文件大小：${escapeHtml(size)}</p>` : ""}
            ${flags.map((flag) => `<p class="file-change-notice">${escapeHtml(flag)}</p>`).join("")}
            ${diffHtml}
          </article>`;
      }).join("") + (Number(details.baselineUnavailable || 0) > 0
        ? `<p class="file-change-notice">基线超过采集上限，无法准确归因</p>` : "") +
        (details.baselineDirty && Number(details.baselineUnavailable || 0) === 0
          ? `<p class="file-change-notice">回合开始前工作区已有修改，无法确认这些内容均由本轮产生</p>` : "") +
        developmentWorkflowMarkup(entry, details, changes)
      : `<div class="detail-error">本轮没有可显示的文件变更。</div>`;
  }

  function renderConversations() {
    $("#conversationCount").textContent = String(state.conversations.length);
    const pinned = pinnedIds();
    const selectedProject = $("#historyProject").value;
    const projects = [...new Set(state.conversations.map(historyProjectName))].sort();
    $("#historyProject").innerHTML = '<option value="">全部项目</option>' + projects.map((project) => `<option value="${escapeHtml(project)}">${escapeHtml(project)}</option>`).join("");
    $("#historyProject").value = selectedProject;
    const q = $("#historySearch").value.trim().toLocaleLowerCase();
    const attachments = $("#historyAttachments").checked;
    const conversations = (state.historyResults || state.conversations).filter((item) => {
      if (state.historyResults) return true;
      return (!selectedProject || historyProjectName(item) === selectedProject) &&
        (!q || `${item.title} ${item.lastMessage || ""}`.toLocaleLowerCase().includes(q)) &&
        (!attachments || item.hasAttachments || (item.id === state.activeId && state.active?.messages?.some((message) => message.attachments?.length || message.artifacts?.length)));
    }).slice().sort((a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id)) ||
      historyProjectName(a).localeCompare(historyProjectName(b)) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
    $("#conversationList").innerHTML = conversations.length
      ? conversations.map((conversation) => `
        <article class="conversation-row ${conversation.id === state.activeId ? "active" : ""}" data-id="${conversation.id}">
          <button class="conversation-open" data-open="${conversation.id}">
            <span class="conversation-mark">${conversation.busy ? '<i></i>' : autumnHistoryIcon(conversation)}</span>
            <span>${state.workspaceFeatures ? `<span class="history-project-label">${escapeHtml(historyProjectName(conversation))}</span>` : ""}<strong>${pinned.has(conversation.id) ? `<span class="conversation-pin" aria-label="已置顶">${autumnPinnedIcon()}</span>` : ""}${escapeHtml(conversation.title)}</strong><small>${conversation.busy ? "正在处理" : formatDate(conversation.updatedAt)} · ${escapeHtml(conversation.searchSnippet || conversation.lastMessage || "暂无消息")}</small></span>
          </button>
          <button class="conversation-more" data-archive="${conversation.id}" aria-label="移除对话">•••</button>
        </article>`).join("")
      : `<div class="drawer-empty">${q || selectedProject || attachments ? "没有匹配的对话" : "还没有历史对话"}</div>`;
  }

  function attachmentHtml(file) {
    return `<span class="message-file"><b>${extension(file.name)}</b><span><strong>${escapeHtml(file.name)}</strong><small>${formatBytes(file.size)}</small></span></span>`;
  }

  function imageUrl(image) {
    const id = String(image?.id || "");
    if (!/^[a-f0-9-]{36}$/.test(id)) return "";
    return new URL(`/vault-api/chat-images/${encodeURIComponent(id)}`, window.location.origin).toString();
  }

  function artifactUrl(messageId, artifact, preview = false) {
    if (preview) {
      const previewToken = String(artifact?.previewToken || "");
      if (!/^[A-Za-z0-9_-]{32,128}$/.test(previewToken)) return "";
      return new URL(`/vault-api/chat/artifact-previews/${encodeURIComponent(previewToken)}`,
        window.location.origin).toString();
    }
    const conversationId = String(state.activeId || "");
    const artifactId = String(artifact?.id || "");
    if (!/^[a-f0-9-]{36}$/.test(conversationId) ||
        !/^[a-f0-9-]{36}$/.test(String(messageId || "")) ||
        !/^[a-f0-9-]{36}$/.test(artifactId)) return "";
    const suffix = preview ? "/preview" : "";
    return new URL(
      `/vault-api/chat/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/artifacts/${encodeURIComponent(artifactId)}${suffix}`,
      window.location.origin,
    ).toString();
  }

  function artifactSourceUrl(artifact) {
    const previewToken = String(artifact?.previewToken || "");
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(previewToken)) return "";
    return new URL(`/vault-api/chat/artifact-sources/${encodeURIComponent(previewToken)}`,
      window.location.origin).toString();
  }

  function isPreviewableArtifact(artifact) {
    const name = String(artifact?.name || "").toLowerCase();
    return /\.(html?|htm)$/.test(name) && Number(artifact?.size || 0) <= 5 * 1024 * 1024;
  }

  function artifactGroups() {
    const groups = new Map();
    for (const message of state.active?.messages || []) {
      if (message.role !== "assistant") continue;
      const versions = (message.previewVersions || []).filter(isPreviewableArtifact);
      if (versions.length) {
        const key = String(message.livePreview?.artifactKey || versions.at(-1)?.artifactKey || message.id);
        const group = groups.get(key) || {
          key, name: versions.at(-1)?.name || "Artifact", versions: [], updatedAt: "",
        };
        const seen = new Set(group.versions.map((version) => version.id));
        for (const version of versions) {
          if (!seen.has(version.id)) {
            group.versions.push({ ...version, messageId: message.id });
            seen.add(version.id);
          }
        }
        group.name = message.livePreview?.name || versions.at(-1)?.name || group.name;
        group.updatedAt = message.completedAt || message.createdAt || group.updatedAt;
        group.running = message.status === "running" && Boolean(message.livePreview?.live);
        groups.set(key, group);
        continue;
      }
      for (const artifact of (message.artifacts || []).filter(isPreviewableArtifact)) {
        const key = `delivery:${message.id}:${artifact.id}`;
        groups.set(key, {
          key, name: artifact.name || "Artifact",
          versions: [{ ...artifact, revision: 1, messageId: message.id }],
          updatedAt: message.completedAt || message.createdAt || "", running: false,
        });
      }
    }
    return [...groups.values()].map((group) => ({
      ...group,
      versions: group.versions.slice().sort((a, b) =>
        Number(a.revision || 0) - Number(b.revision || 0)),
    })).sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
  }

  function selectedArtifactGroup() {
    const groups = artifactGroups();
    return groups.find((group) => group.key === state.artifactKey) || groups.at(-1) || null;
  }

  function artifactPreviewHtml(message) {
    const live = isPreviewableArtifact(message.livePreview) ? message.livePreview : null;
    const versions = (message.previewVersions || []).filter(isPreviewableArtifact);
    const delivered = (message.artifacts || []).filter(isPreviewableArtifact);
    const artifact = live || versions.at(-1) || delivered.at(-1);
    if (!artifact) return "";
    const name = String(artifact.name || "交互页面");
    const key = String(artifact.artifactKey ||
      (versions.length ? message.id : `delivery:${message.id}:${artifact.id}`));
    const revisions = Math.max(1, versions.length || Number(artifact.revision || 1));
    return `<button type="button" class="artifact-handoff" data-open-artifact="${escapeHtml(key)}">
      <span class="artifact-handoff-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M7 3h7l4 4v14H7z"/><path d="M14 3v5h5M10 13h5m-5 3h5"/></svg></span>
      <span class="artifact-handoff-copy"><small>ARTIFACT</small><strong>${escapeHtml(name)}</strong><em>${message.status === "running" ? "正在更新" : `${revisions} 个版本`}</em></span>
      <span class="artifact-handoff-open">打开<svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg></span>
    </button>`;
  }

  function setArtifactMode(mode) {
    state.artifactMode = mode === "code" ? "code" : "preview";
    $("#artifactPreviewTab").classList.toggle("active", state.artifactMode === "preview");
    $("#artifactCodeTab").classList.toggle("active", state.artifactMode === "code");
    $("#artifactPreviewTab").setAttribute("aria-selected", String(state.artifactMode === "preview"));
    $("#artifactCodeTab").setAttribute("aria-selected", String(state.artifactMode === "code"));
    $("#artifactCanvas").classList.toggle("show-code", state.artifactMode === "code");
    renderArtifactWorkspace();
  }

  async function loadArtifactSource(version) {
    if (!version) return "";
    if (state.artifactSourceVersion === version.id) return state.artifactSource;
    const url = artifactSourceUrl(version);
    if (!url) throw new Error("源码链接不可用，请刷新对话");
    const response = await fetch(url, { cache: "no-store", credentials: "omit" });
    if (!response.ok) throw new Error("无法读取 Artifact 源码");
    const source = await response.text();
    state.artifactSourceVersion = version.id;
    state.artifactSource = source;
    return source;
  }

  function renderArtifactSwitcher(groups, selectedKey) {
    const switcher = $("#artifactSwitcher");
    switcher.innerHTML = groups.length > 1 ? groups.slice().reverse().map((group) => `
      <button type="button" data-select-artifact="${escapeHtml(group.key)}" class="${group.key === selectedKey ? "active" : ""}">
        <span>◇</span><strong>${escapeHtml(group.name)}</strong><small>${group.versions.length} 个版本</small>
      </button>`).join("") : "";
    $("#artifactSwitch").hidden = groups.length < 2;
  }

  function renderArtifactWorkspace(options = {}) {
    const groups = artifactGroups();
    const live = groups.findLast((group) => group.running);
    if (options.autoOpen && live && state.artifactAutoOpened !== live.key &&
        state.artifactDismissed !== live.key) {
      state.artifactOpen = true;
      state.artifactKey = live.key;
      state.artifactFollowLatest = true;
      state.artifactAutoOpened = live.key;
    }
    const group = groups.find((candidate) => candidate.key === state.artifactKey)
      || groups.at(-1) || null;
    if (state.artifactOpen && group && state.artifactKey !== group.key) {
      state.artifactKey = group.key;
      state.artifactFollowLatest = true;
    }
    document.body.classList.toggle("artifact-open", state.artifactOpen && Boolean(group));
    $("#artifactWorkspace").setAttribute("aria-hidden", String(!(state.artifactOpen && group)));
    if (!group) return;
    if (state.artifactFollowLatest || state.artifactVersionIndex < 0 ||
        state.artifactVersionIndex >= group.versions.length) {
      state.artifactVersionIndex = group.versions.length - 1;
    }
    const version = group.versions[state.artifactVersionIndex];
    if (!version) return;
    $("#artifactTitle").textContent = group.name.replace(/\.html?$/i, "");
    $("#artifactVersionLabel").textContent = `${state.artifactVersionIndex + 1} / ${group.versions.length}`;
    $("#artifactPreviousVersion").disabled = state.artifactVersionIndex <= 0;
    $("#artifactNextVersion").disabled = state.artifactVersionIndex >= group.versions.length - 1;
    renderArtifactSwitcher(groups, group.key);
    const frame = $("#artifactFrame");
    const previewUrl = artifactUrl(version.messageId, version, true);
    if (frame.dataset.version !== version.id) {
      frame.dataset.version = version.id;
      frame.src = previewUrl || "about:blank";
      $("#artifactLoading").hidden = false;
      $("#artifactRuntimeError").hidden = true;
      state.artifactSourceVersion = "";
      state.artifactSource = "";
    }
    if (state.artifactMode === "code") {
      const code = $("#artifactCode code");
      code.textContent = state.artifactSourceVersion === version.id
        ? state.artifactSource : "正在读取源码…";
      loadArtifactSource(version).then((source) => {
        if (frame.dataset.version === version.id) code.textContent = source;
      }).catch((error) => { code.textContent = error.message; });
    }
  }

  function openArtifact(key) {
    const groups = artifactGroups();
    const group = groups.find((candidate) => candidate.key === key) || groups.at(-1);
    if (!group) return;
    state.artifactOpen = true;
    state.artifactKey = group.key;
    state.artifactVersionIndex = group.versions.length - 1;
    state.artifactFollowLatest = true;
    state.artifactDismissed = "";
    renderArtifactWorkspace();
  }

  function closeArtifact() {
    const group = selectedArtifactGroup();
    if (group?.running) state.artifactDismissed = group.key;
    state.artifactOpen = false;
    document.body.classList.remove("artifact-open");
    $("#artifactWorkspace").setAttribute("aria-hidden", "true");
    $("#artifactSwitcher").classList.remove("open");
    $("#artifactSwitcher").setAttribute("aria-hidden", "true");
  }

  function downloadArtifactUrl(url, name) {
    if (!url) return;
    const link = document.createElement("a");
    link.href = url;
    link.download = name || "Chloe 交付文件";
    link.rel = "noopener";
    document.body.append(link);
    link.click();
    link.remove();
  }

  function showActivation(message = "") {
    dismissBoot();
    const gate = $("#authGate");
    gate.classList.add("open");
    gate.setAttribute("aria-hidden", "false");
    if (message) $("#authGateHint").textContent = message;
    $("#messageInput").disabled = true;
    $("#attachButton").disabled = true;
    $("#sendButton").disabled = true;
  }

  function hideActivation() {
    const gate = $("#authGate");
    gate.classList.remove("open");
    gate.setAttribute("aria-hidden", "true");
    $("#messageInput").disabled = false;
    $("#attachButton").disabled = false;
    $("#sendButton").disabled = false;
  }

  function claimThisDevice() {
    if (state.bootstrapClaiming) return;
    state.bootstrapClaiming = true;
    showActivation("请输入管理员邀请码以激活此设备。");
    state.bootstrapClaiming = false;
  }

  function respondToApproval(approvalId, choiceId) {
    if (!state.activeId || !approvalId) return;
    const card = document.querySelector(`[data-approval-card="${CSS.escape(approvalId)}"]`);
    const buttons = card?.querySelectorAll("button") || [];
    buttons.forEach((button) => { button.disabled = true; });
    card?.querySelectorAll("input, select, textarea").forEach((field) => { field.disabled = true; });
    card?.classList.add("submitting");
    card?.closest(".approval-dock")?.classList.add("submitting");
    bridge()?.resolveApproval?.(state.activeId, approvalId, choiceId);
  }

  function inlineImageHtml(image, className = "") {
    const url = imageUrl(image);
    if (!url) return "";
    const name = String(image.name || "Chloe 图片");
    return `<button type="button" class="inline-image ${className}" data-inline-image="${escapeHtml(url)}" data-image-name="${escapeHtml(name)}" data-image-mime="${escapeHtml(image.mimeType || "")}">
      <img src="${escapeHtml(url)}" alt="${escapeHtml(name)}" loading="lazy" decoding="async">
      <span><b>${escapeHtml(name)}</b><small>${formatBytes(image.size)}</small></span>
    </button>`;
  }

  function visibleActivities(message) {
    return (message.activity || []).filter((item) => !(
      (item.type === "thinking" && ["正在阅读并理解消息", "正在理解并处理你的要求", "正在理解并处理你的请求"].includes(item.label)) ||
      (item.type === "done" && item.label === "处理完成")
    ));
  }

  function activityHtml(message) {
    const activities = visibleActivities(message);
    if (!activities.length) return "";
    const latest = activities.at(-1);
    const icon = latest.type === "command" ? "⌘" : latest.type === "file" ? "◇" : latest.type === "web" ? "◎" : "✦";
    return `<details class="activity" ${message.status === "running" ? "open" : ""}>
      <summary><span class="${message.status}">${icon}</span><b>${escapeHtml(latest.label)}</b><i></i></summary>
      <div>${activities.map((item) => `<p><span class="${item.status}"></span>${escapeHtml(item.label)}</p>`).join("")}</div>
    </details>`;
  }

  function streamActionHtml(message, entry) {
    const icon = entry.kind === "command" ? "⌘"
      : entry.kind === "file" ? "◇"
      : entry.kind === "web" ? "◎" : "✦";
    const detailAttributes = entry.hasDetails
      ? `data-stream-detail="${escapeHtml(entry.id)}" data-message-id="${escapeHtml(message.sourceMessageId || message.id)}"`
      : "";
    const tag = entry.hasDetails ? "button" : "div";
    const details = entry.details || {};
    const status = entry.status === "completed" ? "已完成"
      : entry.status === "failed" ? "失败" : entry.status === "running" ? "执行中" : "";
    const actualExitCode = Number.isInteger(details.exitCode) ? details.exitCode
      : Number.isInteger(entry.exitCode) ? entry.exitCode : null;
    const exitCode = actualExitCode !== null ? `退出码 ${actualExitCode}` : "";
    const failure = details.error || details.failureReason || details.reason ||
      entry.error || entry.failureReason || "";
    const meta = [status, exitCode, failure].filter(Boolean).join(" · ");
    const fileCount = Number.isFinite(Number(entry.count)) && Number(entry.count) > 0
      ? `${Number(entry.count)} 个文件` : "";
    const subline = entry.kind === "file" ? fileCount
      : entry.kind === "command" || entry.kind === "tool" || entry.kind === "thought" ? meta : "";
    return `<${tag} ${entry.hasDetails ? 'type="button"' : ""} class="stream-action ${entry.kind || "tool"} ${entry.status || ""} ${entry.hasDetails ? "clickable" : ""}" ${detailAttributes}>
      <span>${icon}</span><div class="stream-action-copy"><p>${escapeHtml(entry.label || "正在处理")}</p>${subline ? `<small>${escapeHtml(subline)}</small>` : ""}</div>
      <div class="stream-tail"><i></i>${entry.hasDetails ? `<svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>` : ""}</div>
    </${tag}>`;
  }

  function approvalQuestionFormHtml(entry) {
    const questions = Array.isArray(entry.approvalQuestions) ? entry.approvalQuestions : [];
    const fields = questions.map((question, questionIndex) => {
      const options = Array.isArray(question.options) ? question.options : [];
      const input = options.length ? `<div class="approval-choice-grid">${options.map((option, index) => `
        <label><input type="radio" name="approval-question-${questionIndex}" value="${escapeHtml(option.label)}" ${index === 0 ? "required" : ""}>
          <span><b>${escapeHtml(option.label)}</b><small>${escapeHtml(option.description || "")}</small></span></label>`).join("")}
        ${question.allowOther ? `<label><input type="radio" name="approval-question-${questionIndex}" value="__other__"><span><b>其他</b><small>输入自定义回答</small></span></label>
          <div class="approval-other-wrap" hidden><input class="approval-other-input" type="text" maxlength="2000" autocomplete="off" placeholder="请输入你的回答"></div>` : ""}</div>`
        : `<input class="approval-text-input" type="${question.isSecret ? "password" : "text"}" maxlength="2000" required autocomplete="off" placeholder="输入回答">`;
      return `<fieldset class="approval-question" data-question-id="${escapeHtml(question.id)}" data-approval-slide="${questionIndex}">
        <legend>${escapeHtml(question.header || `问题 ${questionIndex + 1}`)}</legend>
        <p>${escapeHtml(question.question || "请选择如何继续")}</p>${input}</fieldset>`;
    }).join("");
    return `<form class="approval-structured-form" data-approval-input-form data-approval-id="${escapeHtml(entry.approvalId)}" novalidate>
      <div class="approval-carousel" data-approval-carousel>${fields}</div>
      <div class="approval-carousel-actions">
        <button type="button" class="approval-back" data-approval-back hidden aria-label="上一题">←</button>
        <div class="approval-dots" aria-hidden="true">${questions.map((_, index) => `<i class="${index === 0 ? "active" : ""}"></i>`).join("")}</div>
        <button type="button" class="approval-next" data-approval-next ${questions.length <= 1 ? "hidden" : ""}>下一题</button>
        <button type="submit" class="approval-submit" ${questions.length > 1 ? "hidden" : ""}>提交</button>
      </div>
    </form>`;
  }

  function approvalDecisionFormHtml(entry, evidence, options) {
    return `<form class="approval-structured-form" data-approval-decision-form data-approval-id="${escapeHtml(entry.approvalId)}" novalidate>
      <fieldset class="approval-question">
        <legend>${escapeHtml(entry.title || "操作确认")}</legend>
        ${entry.reason ? `<p>${escapeHtml(entry.reason)}</p>` : ""}
        ${evidence ? `<div class="approval-evidence">${evidence}</div>` : ""}
        <div class="approval-choice-grid">${options.map((option, index) => `
          <label><input type="radio" name="approval-decision" value="${escapeHtml(option.id)}" ${index === 0 ? "required" : ""}>
            <span><b>${escapeHtml(option.label)}</b><small>${escapeHtml(option.description || "")}</small></span></label>`).join("")}</div>
      </fieldset>
      <div class="approval-form-actions"><span></span><button type="submit">确认选择</button></div>
    </form>`;
  }

  function approvalSchemaFieldHtml(key, schema, required) {
    const label = schema?.title || key;
    const description = schema?.description || "";
    const enumValues = Array.isArray(schema?.enum) ? schema.enum :
      Array.isArray(schema?.oneOf) ? schema.oneOf.map((item) => item?.const) : [];
    const enumLabels = Array.isArray(schema?.oneOf) ? schema.oneOf.map((item) => item?.title) : enumValues;
    let control;
    if (schema?.type === "boolean") {
      control = `<label class="approval-switch"><input type="checkbox" ${schema.default ? "checked" : ""}><span>确认</span></label>`;
    } else if (enumValues.length) {
      control = `<select ${required ? "required" : ""}>${!required ? "<option value=\"\">请选择</option>" : ""}${enumValues.map((value, index) =>
        `<option value="${escapeHtml(value)}">${escapeHtml(enumLabels[index] || value)}</option>`).join("")}</select>`;
    } else {
      const type = ["number", "integer"].includes(schema?.type) ? "number" :
        schema?.format === "email" ? "email" : schema?.format === "uri" ? "url" :
        schema?.format === "date" ? "date" : schema?.format === "date-time" ? "datetime-local" : "text";
      control = `<input type="${type}" ${required ? "required" : ""} maxlength="2000" value="${escapeHtml(schema?.default ?? "")}">`;
    }
    return `<label class="approval-schema-field" data-field-key="${escapeHtml(key)}" data-value-type="${escapeHtml(schema?.type || "string")}">
      <span><b>${escapeHtml(label)}</b>${description ? `<small>${escapeHtml(description)}</small>` : ""}</span>${control}</label>`;
  }

  function approvalSchemaFormHtml(entry) {
    const schema = entry.approvalForm && typeof entry.approvalForm === "object" ? entry.approvalForm : {};
    const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const fields = Object.entries(properties).slice(0, 24)
      .map(([key, value]) => approvalSchemaFieldHtml(key, value, required.has(key))).join("");
    return `<form class="approval-structured-form" data-approval-mcp-form data-approval-id="${escapeHtml(entry.approvalId)}">
      ${fields || "<p>此连接器未提供可填写字段。</p>"}
      <div class="approval-form-actions"><button type="submit">确认并继续</button>
        <button type="button" class="secondary" data-approval-payload="decline" data-approval-id="${escapeHtml(entry.approvalId)}">拒绝</button></div></form>`;
  }

  function approvalHtml(entry) {
    const statusLabels = {
      accepted: "已允许本次操作",
      declined: "已拒绝",
      expired: "请求已失效",
    };
    const pending = entry.status === "pending";
    const typeLabels = {
      command: "COMMAND",
      file: "FILE CHANGE",
      network: "NETWORK",
      permissions: "PERMISSION",
      connector: "APP CONNECTOR",
      mcp: "MCP ELICITATION",
      user_input: "USER INPUT",
    };
    const evidence = [
      entry.host ? `<div><span>目标</span><code>${escapeHtml(`${entry.protocol || "https"}://${entry.host}`)}</code></div>` : "",
      entry.command ? `<div><span>命令</span><code>${escapeHtml(entry.command)}</code></div>` : "",
      entry.permissionSummary ? `<div><span>范围</span><code>${escapeHtml(entry.permissionSummary)}</code></div>` : "",
      entry.grantRoot ? `<div><span>目录</span><code>${escapeHtml(entry.grantRoot)}</code></div>` : "",
      entry.cwd ? `<div><span>位置</span><code>${escapeHtml(entry.cwd)}</code></div>` : "",
      entry.approvalUrl ? `<div><span>授权页</span><code>${escapeHtml(entry.approvalUrl)}</code></div>` : "",
    ].filter(Boolean).join("");
    const fallbackOptions = [
      { id: "accept", label: "允许一次", description: "仅批准当前这项操作", tone: "accepted" },
      { id: "decline", label: "拒绝并继续", description: "不执行操作，让当前 AI 尝试其他做法", tone: "declined" },
    ];
    const options = Array.isArray(entry.approvalOptions) && entry.approvalOptions.length
      ? entry.approvalOptions : fallbackOptions;
    const structuredHtml = !entry.approvalOptions?.length && entry.approvalQuestions?.length
      ? approvalQuestionFormHtml(entry)
      : !entry.approvalOptions?.length && entry.approvalForm
        ? approvalSchemaFormHtml(entry) : approvalDecisionFormHtml(entry, evidence, options);
    const resolvedLabel = entry.resolutionLabel || statusLabels[entry.status] || "已处理";
    const isUserInput = entry.approvalType === "user_input";
    const questionCount = Array.isArray(entry.approvalQuestions)
      ? entry.approvalQuestions.length : 0;
    return `<section class="approval-card ${isUserInput ? "user-input" : ""} ${entry.status || "pending"}" data-approval-card="${escapeHtml(entry.approvalId)}" data-approval-type="${escapeHtml(entry.approvalType || "")}">
      <div class="approval-sheet-grabber" aria-hidden="true"></div>
      <header>
        <div><small>${escapeHtml(typeLabels[entry.approvalType] || "APPROVAL")}</small><strong>${isUserInput ? "当前 AI 需要输入" : "当前 AI 请求确认"}</strong></div>
        <b data-approval-page>${pending && isUserInput && questionCount ? `1 / ${questionCount}` : pending ? "待确认" : escapeHtml(statusLabels[entry.status] || "已处理")}</b>
      </header>
      ${pending ? structuredHtml
        : `<footer class="approval-resolution"><i></i><span>${escapeHtml(resolvedLabel)}</span></footer>`}
    </section>`;
  }

  function pendingApproval() {
    return (state.active?.messages || []).flatMap((message) => message.stream || [])
      .findLast((entry) => entry.kind === "approval" && entry.status === "pending") || null;
  }

  function renderApprovalDock() {
    const dock = $("#approvalDock");
    const panel = $("#approvalDockPanel");
    const entry = pendingApproval();
    if (!entry) {
      dock.hidden = true;
      dock.classList.remove("submitting");
      panel.innerHTML = "";
      delete panel.dataset.signature;
      document.body.classList.remove("approval-dock-open");
      return;
    }
    const signature = JSON.stringify([
      entry.approvalId, entry.approvalType, entry.title, entry.reason,
      entry.approvalOptions, entry.approvalQuestions, entry.approvalForm,
      entry.command, entry.cwd, entry.host, entry.permissionSummary,
    ]);
    if (panel.dataset.signature !== signature) {
      panel.innerHTML = approvalHtml(entry);
      panel.dataset.signature = signature;
    }
    dock.hidden = false;
    document.body.classList.add("approval-dock-open");
  }

  function approvalQuestionComplete(field) {
    const checked = field?.querySelector('input[type="radio"]:checked');
    const textInput = field?.querySelector(".approval-text-input");
    if (textInput) return Boolean(textInput.value.trim());
    if (!checked) return false;
    if (checked.value !== "__other__") return true;
    return Boolean(field.querySelector(".approval-other-input")?.value.trim());
  }

  function updateApprovalPageState(form, requestedIndex) {
    const slides = [...(form?.querySelectorAll("[data-approval-slide]") || [])];
    if (!slides.length) return;
    const index = Math.max(0, Math.min(slides.length - 1, requestedIndex));
    form.dataset.approvalPage = String(index);
    form.querySelector("[data-approval-back]").hidden = index === 0;
    form.querySelector("[data-approval-next]").hidden = index === slides.length - 1;
    form.querySelector(".approval-submit").hidden = index !== slides.length - 1;
    form.querySelectorAll(".approval-dots i").forEach((dot, dotIndex) =>
      dot.classList.toggle("active", dotIndex === index));
    const page = form.closest(".approval-card")?.querySelector("[data-approval-page]");
    if (page) page.textContent = `${index + 1} / ${slides.length}`;
  }

  function setApprovalPage(form, requestedIndex, smooth = true) {
    const carousel = form?.querySelector("[data-approval-carousel]");
    const slideCount = form?.querySelectorAll("[data-approval-slide]").length || 0;
    if (!carousel || !slideCount) return;
    const index = Math.max(0, Math.min(slideCount - 1, requestedIndex));
    updateApprovalPageState(form, index);
    carousel.scrollTo({
      left: index * carousel.clientWidth,
      behavior: smooth ? "smooth" : "auto",
    });
  }

  function streamGroupLabel(entries) {
    const commands = entries.filter((entry) => entry.kind === "command").length;
    const files = entries
      .filter((entry) => entry.kind === "file")
      .reduce((total, entry) => total + Math.max(1, Number(entry.count) || 1), 0);
    const tools = entries.filter((entry) => !["command", "file", "web"].includes(entry.kind)).length;
    const web = entries.filter((entry) => entry.kind === "web").length;
    const parts = [];
    if (commands) parts.push(`执行 ${commands} 条命令`);
    if (files) parts.push(`修改 ${files} 个文件`);
    if (web) parts.push(`查询 ${web} 次`);
    if (tools) parts.push(`调用 ${tools} 个工具`);
    return parts.join(" · ") || `处理 ${entries.length} 项操作`;
  }

  function streamHtml(message, streamOverride) {
    const hasOverride = Array.isArray(streamOverride);
    const stream = hasOverride ? streamOverride
      : Array.isArray(message.stream) ? message.stream : [];
    if (!stream.length) {
      if (hasOverride) return "";
      const typing = !message.text &&
        (message.status === "queued" || message.status === "running");
      return `${typing
        ? `<div class="typing"><i></i><i></i><i></i></div>`
        : `<div class="assistant-text">${textHtml(message.text)}</div>`}
        ${activityHtml(message)}`;
    }
    const rendered = [];
    let actionBuffer = [];
    const flushActions = () => {
      if (!actionBuffer.length) return;
      if (actionBuffer.length === 1) {
        rendered.push(streamActionHtml(message, actionBuffer[0]));
      } else {
        const running = actionBuffer.some((entry) => entry.status === "running");
        const failed = actionBuffer.filter((entry) => entry.status === "failed").length;
        const groupStatus = running ? "running" : failed ? "failed" : "completed";
        const statusText = running ? "正在执行" : failed ? `${failed} 项未完成` : "执行完成";
        rendered.push(`<details class="stream-action-group ${groupStatus}" ${message.status === "running" ? "open" : ""}>
          <summary>
            <span class="stream-group-icon">⌘</span>
            <span class="stream-group-copy"><strong>${escapeHtml(streamGroupLabel(actionBuffer))}</strong><small>${statusText} · 点击${message.status === "running" ? "收起" : "展开"}详情</small></span>
            <span class="stream-group-tail"><i></i><svg viewBox="0 0 24 24"><path d="m7 10 5 5 5-5"/></svg></span>
          </summary>
          <div class="stream-action-list">${actionBuffer.map((entry) => streamActionHtml(message, entry)).join("")}</div>
        </details>`);
      }
      actionBuffer = [];
    };
    stream.forEach((entry) => {
      if (entry.kind === "message") {
        flushActions();
        if (!entry.text) return;
        const phase = entry.phase === "final_answer" ? "final" : "commentary";
        rendered.push(`<div class="stream-message ${phase} ${entry.status || ""}">${textHtml(entry.text)}</div>`);
        return;
      }
      if (entry.kind === "image") {
        flushActions();
        const image = (message.images || []).find((candidate) => candidate.id === entry.imageId);
        if (image) rendered.push(inlineImageHtml(image, "execution-image"));
        return;
      }
      if (entry.kind === "approval") {
        flushActions();
        return;
      }
      actionBuffer.push(entry);
    });
    flushActions();
    const entries = rendered.join("");
    const showTyping = message.status === "running" &&
      !stream.some((entry) => entry.kind === "message" && entry.status === "running");
    return `${entries}${showTyping ? `<div class="typing"><i></i><i></i><i></i></div>` : ""}`;
  }

  function completedMessageHtml(message) {
    const stream = Array.isArray(message.stream) ? message.stream : [];
    const finalEntries = stream.filter((entry) =>
      entry.kind === "message" && entry.phase === "final_answer" && String(entry.text || "").trim());
    const finalEntry = finalEntries.at(-1);
    const processEntries = stream.filter((entry) => entry !== finalEntry);
    const processHtml = streamHtml(message, processEntries) || activityHtml(message);
    const processCount = processEntries.length || visibleActivities(message).length;
    const duration = formatTaskDuration(taskDurationMs(message));
    const failed = message.status === "failed";
    const interrupted = message.status === "interrupted";
    const stateLabel = failed ? "执行未完成" : interrupted ? "执行已暂停" : "执行过程";
    const resultText = finalEntry?.text || message.text || (failed ? "任务未完成。" : "任务已完成。");
    const processSummary = processHtml ? `<details class="completed-process ${message.status || "completed"}">
      <summary>
        <span class="completed-process-mark" aria-hidden="true">${failed ? "!" : interrupted ? "Ⅱ" : "✓"}</span>
        <span class="completed-process-copy"><strong>${stateLabel}</strong><small>${processCount ? `${processCount} 项 · ` : ""}${duration}</small></span>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>
      </summary>
      <div class="completed-process-body">${processHtml}</div>
    </details>` : (failed || interrupted) ? `<div class="completed-runtime ${message.status || "completed"}"><span>${failed ? "!" : interrupted ? "Ⅱ" : "✓"}</span>${stateLabel} · ${duration}</div>` : "";
    return `${processSummary}<div class="completed-result"><div class="stream-message final ${message.status || "completed"}">${textHtml(resultText)}</div></div>`;
  }

  function messageInnerHtml(message) {
    const files = (message.attachments || []).map(attachmentHtml).join("");
    if (message.role === "user") {
      return `<div class="bubble">${message.text
        ? `<div class="user-message-copy"><div class="user-message-rich">${textHtml(message.text)}</div></div>
          <button type="button" class="user-message-toggle" aria-expanded="false" hidden>展开全文</button>`
        : ""}${files ? `<div class="message-files">${files}</div>` : ""}</div>
        <time>${message.status === "sending"
          ? (message.steeredInto ? "正在引导" : "正在发送")
          : `${message.steeredInto ? "已引导 · " : ""}${formatDate(message.createdAt)}${message.senderDeviceLabel ? ` · ${escapeHtml(message.senderDeviceLabel)}${message.senderDeviceLabel === state.currentDeviceLabel ? "（本机）" : ""}` : ""}${message.status === "failed" ? " · 发送失败，可重试" : ""}`}</time>`;
    }
    const streamedImageIds = new Set(
      (message.stream || []).filter((entry) => entry.kind === "image").map((entry) => entry.imageId));
    const deliveredImages = (message.images || [])
      .filter((image) => image.source === "delivery" || !streamedImageIds.has(image.id))
      .map((image) => inlineImageHtml(image, "delivery-image"))
      .join("");
    return `<div class="assistant-body">
      ${["completed", "failed", "interrupted"].includes(message.status)
        ? completedMessageHtml(message) : streamHtml(message)}
      ${artifactPreviewHtml(message)}
      ${deliveredImages ? `<div class="message-image-gallery">${deliveredImages}</div>` : ""}
      <time>${formatDate(message.createdAt)}</time>
    </div>`;
  }

  function fingerprint(message) {
    const source = JSON.stringify([
      message.role, message.status, message.text, message.attachments,
      message.activity, message.stream, message.images, message.artifacts,
      message.livePreview, message.previewVersions, message.steeredInto,
      message.startedAt, message.completedAt,
      message.sourceMessageId, message.segmentIndex, message.steerAtStreamIndex,
    ]);
    let hash = 2166136261;
    for (let index = 0; index < source.length; index += 1) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `${source.length}-${hash >>> 0}`;
  }

  function scrollToBottom() {
    const stage = $("#chatStage");
    const previous = stage.style.scrollBehavior;
    stage.style.scrollBehavior = "auto";
    stage.scrollTop = stage.scrollHeight;
    requestAnimationFrame(() => { stage.style.scrollBehavior = previous; });
  }

  let rotationAnchor = null;
  let latestPinned = true;
  let lastLandscape = matchMedia("(orientation: landscape)").matches;
  let messageRenderEpoch = 0;
  let pendingLatestConversationId = "";
  let conversationOpenEpoch = 0;

  function distanceFromBottom() {
    const stage = $("#chatStage");
    return Math.max(0, stage.scrollHeight - stage.scrollTop - stage.clientHeight);
  }

  function scrollOpenedConversationToLatest(id, clearPending = false) {
    const epoch = ++conversationOpenEpoch;
    setTimeout(() => {
      if (epoch !== conversationOpenEpoch || state.activeId !== id) return;
      scrollToBottom();
      latestPinned = true;
      if (clearPending && pendingLatestConversationId === id) {
        pendingLatestConversationId = "";
      }
    }, 0);
  }

  function captureMessageScrollAnchor() {
    const stage = $("#chatStage");
    const stageTop = stage.getBoundingClientRect().top;
    const visible = [...$("#messageList").children].find((message) =>
      message.getBoundingClientRect().bottom > stageTop + 1);
    return {
      stickToLatest: latestPinned || distanceFromBottom() < 180,
      bottomGap: distanceFromBottom(),
      scrollTop: stage.scrollTop,
      messageId: visible?.dataset.message || "",
      offset: visible ? visible.getBoundingClientRect().top - stageTop : 0,
    };
  }

  function restoreMessageScrollAnchor(anchor, epoch) {
    if (!anchor || epoch !== messageRenderEpoch) return;
    const stage = $("#chatStage");
    if (anchor.stickToLatest) {
      scrollToBottom();
      latestPinned = true;
      return;
    }
    const message = anchor.messageId
      ? $("#messageList").querySelector(`[data-message="${CSS.escape(anchor.messageId)}"]`)
      : null;
    if (message) {
      const stageTop = stage.getBoundingClientRect().top;
      stage.scrollTop += message.getBoundingClientRect().top - stageTop - anchor.offset;
    } else if (Number.isFinite(anchor.bottomGap)) {
      stage.scrollTop = Math.max(
        0, stage.scrollHeight - stage.clientHeight - anchor.bottomGap);
    } else {
      stage.scrollTop = anchor.scrollTop;
    }
    latestPinned = distanceFromBottom() < 180;
  }

  function captureRotationAnchor() {
    if (rotationAnchor) return;
    const stage = $("#chatStage");
    const stageTop = stage.getBoundingClientRect().top;
    const visible = [...$("#messageList").children].find((message) =>
      message.getBoundingClientRect().bottom > stageTop + 1);
    rotationAnchor = {
      stickToLatest: latestPinned || distanceFromBottom() < 180,
      bottomGap: distanceFromBottom(),
      messageId: visible?.dataset.message || "",
      offset: visible ? visible.getBoundingClientRect().top - stageTop : 0,
    };
  }

  function restoreRotationAnchor(anchor) {
    if (!anchor) return;
    const stage = $("#chatStage");
    if (anchor.stickToLatest) {
      scrollToBottom();
      latestPinned = true;
      return;
    }
    const message = anchor.messageId
      ? $("#messageList").querySelector(`[data-message="${CSS.escape(anchor.messageId)}"]`)
      : null;
    if (message) {
      const stageTop = stage.getBoundingClientRect().top;
      stage.scrollTop += message.getBoundingClientRect().top - stageTop - anchor.offset;
    } else {
      stage.scrollTop = Math.max(
        0, stage.scrollHeight - stage.clientHeight - anchor.bottomGap);
    }
    latestPinned = distanceFromBottom() < 180;
  }

  function beginOrientationChange() {
    captureRotationAnchor();
  }

  function finishViewportResize() {
    const landscape = matchMedia("(orientation: landscape)").matches;
    if (landscape !== lastLandscape && !rotationAnchor) captureRotationAnchor();
    lastLandscape = landscape;
    clearTimeout(collapseResizeTimer);
    collapseResizeTimer = setTimeout(() => {
      const anchor = rotationAnchor;
      renderMessages(true);
      requestAnimationFrame(() => requestAnimationFrame(() => restoreRotationAnchor(anchor)));
      setTimeout(() => {
        restoreRotationAnchor(anchor);
        if (rotationAnchor === anchor) rotationAnchor = null;
      }, 240);
    }, 120);
  }

  $("#chatStage").addEventListener("scroll", () => {
    if (!rotationAnchor) latestPinned = distanceFromBottom() < 180;
  }, { passive: true });
  window.addEventListener("orientationchange", beginOrientationChange);
  window.screen.orientation?.addEventListener?.("change", beginOrientationChange);
  window.addEventListener("resize", finishViewportResize);

  function syncUserMessageCollapse(article, message) {
    if (message.role !== "user" || !message.text) return;
    const copy = article.querySelector(".user-message-copy");
    const content = copy?.querySelector(".user-message-rich");
    const button = article.querySelector(".user-message-toggle");
    if (!copy || !content || !button) return;
    article.classList.remove("long-message");
    const style = getComputedStyle(content);
    const lineHeight = Number.parseFloat(style.lineHeight) ||
      Number.parseFloat(style.fontSize) * 1.65;
    const needsCollapse = content.scrollHeight > lineHeight * 7 + 2;
    const expanded = needsCollapse && state.expandedMessages.has(message.id);
    article.classList.toggle("long-message", needsCollapse);
    article.classList.toggle("expanded", expanded);
    button.hidden = !needsCollapse;
    button.textContent = expanded ? "收起" : "展开全文";
    button.setAttribute("aria-expanded", String(expanded));
  }

  function streamBoundaryForSteer(stream, steer, minimum) {
    const recorded = Number(steer.steerAtStreamIndex);
    if (Number.isInteger(recorded) && recorded >= 0) {
      return Math.max(minimum, Math.min(stream.length, recorded));
    }
    const steeredAt = Date.parse(steer.createdAt || "");
    if (!Number.isFinite(steeredAt)) return stream.length;
    const nextIndex = stream.findIndex((entry, index) =>
      index >= minimum && Date.parse(entry.createdAt || "") > steeredAt);
    return nextIndex < 0 ? stream.length : nextIndex;
  }

  function splitAssistantAroundSteers(message, steers) {
    if (!steers.length) return [message];
    const stream = Array.isArray(message.stream) ? message.stream : [];
    const allStreamImageIds = new Set(
      stream.filter((entry) => entry.kind === "image").map((entry) => entry.imageId));
    const result = [];
    let start = 0;
    let segmentIndex = 0;

    const makeSegment = (end, finalSegment, anchorSteer = null) => {
      const segmentStream = stream.slice(start, end);
      const segmentImageIds = new Set(
        segmentStream.filter((entry) => entry.kind === "image").map((entry) => entry.imageId));
      const images = (message.images || []).filter((image) =>
        segmentImageIds.has(image.id) ||
        (finalSegment && (image.source === "delivery" || !allStreamImageIds.has(image.id))));
      const segment = {
        ...message,
        id: segmentIndex === 0
          ? message.id
          : `${message.id}--continuation-${segmentIndex}`,
        sourceMessageId: message.id,
        segmentIndex,
        stream: segmentStream,
        images,
        artifacts: finalSegment ? message.artifacts : [],
        previewVersions: finalSegment ? message.previewVersions : [],
        livePreview: finalSegment ? message.livePreview : null,
        text: finalSegment ? message.text : "",
        activity: finalSegment
          ? message.activity
          : (segmentIndex === 0 && !segmentStream.length ? message.activity : []),
        status: finalSegment ? message.status : "completed",
        createdAt: anchorSteer?.createdAt || message.createdAt,
      };
      segmentIndex += 1;
      start = end;
      return segment;
    };

    steers.forEach((steer) => {
      const boundary = streamBoundaryForSteer(stream, steer, start);
      const hasVisiblePriorOutput = boundary > start ||
        (result.length === 0 && (message.text || (message.activity || []).length));
      if (hasVisiblePriorOutput) result.push(makeSegment(boundary, false));
      result.push(steer);
    });
    result.push(makeSegment(stream.length, true, steers.at(-1)));
    return result;
  }

  function renderMessages(keepPosition = false) {
    const list = $("#messageList");
    const scrollAnchor = keepPosition ? captureMessageScrollAnchor() : null;
    const renderEpoch = ++messageRenderEpoch;
    const messages = [...(state.active?.messages || [])];
    if (state.optimisticMessage) {
      const runningIndex = messages.findLastIndex((message) =>
        message.role === "assistant" &&
        (message.status === "queued" || message.status === "running"));
      messages.splice(runningIndex >= 0 ? runningIndex + 1 : messages.length, 0, state.optimisticMessage);
    }
    // Split an active assistant turn at each steering boundary so new output appears
    // below the user's guidance instead of making that guidance trail the whole turn.
    const steeringByAssistant = new Map();
    messages.forEach((message) => {
      if (!message.steeredInto) return;
      const steering = steeringByAssistant.get(message.steeredInto) || [];
      steering.push(message);
      steeringByAssistant.set(message.steeredInto, steering);
    });
    const orderedMessages = [];
    messages.forEach((message) => {
      if (message.steeredInto) return;
      const steers = steeringByAssistant.get(message.id) || [];
      orderedMessages.push(...(
        message.role === "assistant"
          ? splitAssistantAroundSteers(message, steers)
          : [message, ...steers]
      ));
    });
    $("#welcome").hidden = orderedMessages.length > 0;
    $("#chatTitle").textContent = state.active?.title || "Chloe";
    const liveIds = new Set(orderedMessages.map((message) => message.id));
    let changed = false;
    list.querySelectorAll(":scope > .message").forEach((node) => {
      if (!liveIds.has(node.dataset.message)) {
        node.remove();
        changed = true;
      }
    });
    orderedMessages.forEach((message, index) => {
      let article = list.querySelector(`[data-message="${CSS.escape(message.id)}"]`);
      const isNew = !article;
      if (isNew) {
        article = document.createElement("article");
        article.dataset.message = message.id;
      }
      const signature = fingerprint(message);
      if (article.dataset.fingerprint !== signature) {
        const previousStatus = article.dataset.status;
        const wasOpen = Boolean(article.querySelector("details[open]"));
        article.className = `message ${message.role} ${message.status || ""} ${message.steeredInto ? "guided" : ""}`;
        article.innerHTML = messageInnerHtml(message);
        if (wasOpen && previousStatus === message.status) {
          article.querySelector("details")?.setAttribute("open", "");
        }
        article.dataset.status = message.status || "";
        article.dataset.fingerprint = signature;
        changed = true;
      }
      const reference = list.children[index];
      if (reference !== article) {
        list.insertBefore(article, reference || null);
        changed = true;
      }
      syncUserMessageCollapse(article, message);
    });
    if (changed) {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (renderEpoch !== messageRenderEpoch) return;
        if (keepPosition) restoreMessageScrollAnchor(scrollAnchor, renderEpoch);
        else {
          scrollToBottom();
          latestPinned = true;
        }
      }));
    }
    const busy = messages.some((message) =>
      message.role === "assistant" &&
      (message.status === "queued" || message.status === "running"));
    renderApprovalDock();
    setBusy(busy);
    renderTaskStatus();
    renderDeliveries();
    renderArtifactWorkspace({ autoOpen: true });
    clearTimeout(pollTimer);
    if (!state.supportsSse && busy && state.activeId && state.appVisible) {
      pollTimer = setTimeout(requestActiveConversationSync, 1200);
    }
  }

  function requestActiveConversationSync() {
    if (!state.appVisible || !state.activeId || state.supportsSse) return;
    const nativeBridge = bridge();
    if (typeof nativeBridge?.requestConversationDelta === "function") {
      nativeBridge.requestConversationDelta(state.activeId);
    } else {
      nativeBridge?.requestConversation?.(state.activeId);
    }
  }

  function setAppVisible(visible) {
    state.appVisible = Boolean(visible);
    document.body.classList.toggle("power-paused", !state.appVisible);
    clearTimeout(pollTimer);
    if (!state.appVisible) {
      saveDraft();
      if (state.supportsSse) bridge()?.unsubscribeConversationEvents?.();
      return;
    }
    applyTheme(document.documentElement.dataset.themePreference || "system");
    if (state.supportsSse && state.activeId) {
      bridge()?.subscribeConversationEvents?.(state.activeId);
    } else if (state.busy && state.activeId) {
      pollTimer = setTimeout(requestActiveConversationSync, 120);
    }
  }

  function setBusy(busy) {
    state.busy = busy;
    if (!busy) state.pausing = false;
    $("#messageInput").disabled = false;
    $("#attachButton").disabled = state.transmitting;
    $(".composer").classList.toggle("has-active-turn", busy);
    refreshActionButton();
    $("#composerHint").textContent = busy
      ? "处理中 · 你可以继续补充要求"
      : "由你服务器上的 AI Harness 处理 · 重要操作会先确认";
  }

  function hasComposerContent() {
    return Boolean($("#messageInput").value.trim() || state.attachments.size);
  }

  function refreshActionButton() {
    const button = $("#sendButton");
    const canGuide = hasComposerContent();
    button.classList.toggle("sending", state.transmitting);
    button.classList.toggle("working", state.busy && !canGuide && !state.transmitting);
    button.classList.toggle("pausing", state.pausing);
    button.disabled = state.transmitting || state.pausing || (!state.busy && !canGuide);
    button.setAttribute("aria-label",
      state.busy && !canGuide ? "暂停当前执行" : state.busy ? "发送引导" : "发送");
  }

  function renderAttachments() {
    const files = [...state.attachments.values()];
    $("#attachmentStrip").innerHTML = files.map((file) => `
      <span class="attachment-chip ${file.state || ""}">
        <b>${extension(file.name)}</b>
        <span><strong>${escapeHtml(file.name)}</strong><small>${file.label || formatBytes(file.size)}</small></span>
        <button data-remove-file="${file.id}" ${file.state === "uploading" ? "disabled" : ""}>×</button>
        <i style="width:${file.progress || 0}%"></i>
      </span>`).join("");
    $("#attachmentStrip").classList.toggle("visible", files.length > 0);
    refreshActionButton();
  }

  function setAttachmentMenu(open) {
    const menu = $("#attachmentMenu");
    const expanded = Boolean(open);
    menu.classList.toggle("open", expanded);
    menu.setAttribute("aria-hidden", String(!expanded));
    $(".composer-wrap").classList.toggle("menu-open", expanded);
    $("#attachButton").setAttribute("aria-expanded", String(expanded));
  }

  function selectConversation(id) {
    if (!id) return;
    if (state.transmitting) { toast("消息正在送达，完成后即可切换对话"); return; }
    const reopeningCurrent = state.active?.id === id;
    if (!reopeningCurrent) saveDraft();
    if (!reopeningCurrent) {
      closeArtifact();
      state.artifactKey = "";
      state.artifactAutoOpened = "";
      state.artifactDismissed = "";
    }
    state.activeId = id;
    if (!reopeningCurrent) {
      state.active = null;
      state.optimisticMessage = null;
      state.loadingOlder = false;
      restoreDraft();
      renderMessages();
    }
    latestPinned = true;
    pendingLatestConversationId = id;
    localStorage.setItem("wit_active_conversation", id);
    closeDrawer();
    renderConversations();
    setConnected(true, "读取对话中");
    if (reopeningCurrent) scrollOpenedConversationToLatest(id);
    bridge()?.requestConversation?.(id);
    if (state.supportsSse && state.appVisible) {
      bridge()?.subscribeConversationEvents?.(id);
    }
  }

  function applyConversation(conversation) {
    if (!conversation || conversation.id !== state.activeId) return;
    const wasBusy = state.busy;
    // Keep explicitly loaded older pages when a fresh SSE tail arrives.
    if (state.active?.id === conversation.id && Number.isInteger(conversation.messageOffset) &&
        Number.isInteger(state.active.messageOffset) && conversation.messageOffset > state.active.messageOffset) {
      const prefixLength = conversation.messageOffset - state.active.messageOffset;
      if (prefixLength <= state.active.messages.length) {
        conversation = { ...conversation, messages: [...state.active.messages.slice(0, prefixLength), ...conversation.messages], messageOffset: state.active.messageOffset, hasMore: state.active.messageOffset > 0 };
      }
    }
    state.active = conversation;
    state.model = conversation.model || state.model;
    state.reasoning = conversation.reasoning || state.reasoning;
    state.accessMode = conversation.accessMode || state.accessMode;
    state.draftModel = state.model;
    state.draftReasoning = state.reasoning;
    state.draftAccessMode = state.accessMode;
    state.codexProfile = conversation.codexProfile || "default";
    state.workDir = conversation.workDir || "";
    persistConversation(conversation);
    updateModelControls();
    setConnected(true, conversation.busy ? "Chloe 正在处理" : "服务器在线");
    renderMessages(true);
    if (state.detailRequest && state.detailEntry &&
        $("#actionDetailSheet").classList.contains("open")) {
      renderActionDetail(state.detailEntry);
    }
    if (pendingLatestConversationId === conversation.id) {
      scrollOpenedConversationToLatest(conversation.id, true);
    }
    updateQuotaStatus();
    if (!state.usage) refreshUsage();
    const summary = state.conversations.find((item) => item.id === conversation.id);
    if (summary) {
      summary.title = conversation.title;
      summary.updatedAt = conversation.updatedAt;
      summary.lastMessage = conversation.lastMessage ||
        conversation.messages?.at(-1)?.text || summary.lastMessage;
      summary.busy = state.busy;
      renderConversations();
      persistConversationList();
    }
    if (wasBusy && !state.busy) {
      bridge()?.requestConversations?.();
      if (completionReminder && state.appVisible) toast(`${conversation.title || "当前任务"} · ${conversation.taskStatus?.label || "执行已结束"}`);
    }
  }

  function requestConversationCreation(workDir, callback = null) {
    if (!state.activeId) prepareNewConversationSettings();
    state.afterCreate = callback;
    const nativeBridge = bridge();
    if (typeof nativeBridge?.createConversation !== "function") {
      state.afterCreate = null;
      window.DropVault.onMessageSendError("当前版本无法创建对话，请更新 App");
      return;
    }
    try {
      if (typeof nativeBridge.createConversationWithProfile === "function") {
        nativeBridge.createConversationWithProfile(
          state.model, state.reasoning, state.accessMode, workDir || "",
          state.codexProfile || "default");
      } else if (typeof nativeBridge.createConversationWithPath === "function") {
        nativeBridge.createConversationWithPath(
          state.model, state.reasoning, state.accessMode, workDir || "");
      } else if (workDir) {
        state.afterCreate = null;
        window.DropVault.onMessageSendError("选择项目路径需要更新到最新版 App");
      } else if (state.supports21) {
        nativeBridge.createConversation(state.model, state.reasoning, state.accessMode);
      } else {
        nativeBridge.createConversation(state.model, state.reasoning);
      }
    } catch {
      state.afterCreate = null;
      window.DropVault.onMessageSendError("创建对话失败，请重启 App 后再试");
    }
  }

  function ensureConversation(callback) {
    if (state.activeId) {
      callback();
      return;
    }
    requestConversationCreation("", callback);
  }

  function submitUploadedMessage() {
    if (!state.pendingSend) return;
    const { text } = state.pendingSend;
    const uploadedIds = state.sendRequest.fileIds.map((id) => state.sendRequest.uploadedByFile[id]);
    sendPreparedMessage(text, uploadedIds);
  }

  function sendPreparedMessage(text, uploadedIds) {
    if (state.workspaceFeatures) bridge()?.sendChatMessageWithRequestId?.(state.activeId, text, JSON.stringify(uploadedIds), state.sendRequest.id);
    else bridge()?.sendChatMessage?.(state.activeId, text, JSON.stringify(uploadedIds));
  }

  function sendMessage(prefill) {
    const text = typeof prefill === "string" ? prefill.trim() : $("#messageInput").value.trim();
    const files = [...state.attachments.values()];
    if (!text && !files.length) return;
    if (state.transmitting) {
      toast("上一条消息正在送达，请稍候");
      return;
    }
    const signature = JSON.stringify([state.activeId, text, files.map((file) => file.id)]);
    if (state.sendRequest?.signature !== signature) state.sendRequest = { signature, id: crypto.randomUUID(), fileIds: files.map((file) => file.id), uploadedByFile: {} };
    saveDraft();
    state.transmitting = true;
    state.lastSubmittedText = text;
    state.optimisticMessage = {
      id: `local-${Date.now()}`,
      role: "user",
      text,
      attachments: files.map((file) => ({ ...file })),
      createdAt: new Date().toISOString(),
      status: "sending",
      steeredInto: state.busy
        ? state.active?.messages?.findLast((message) =>
          message.role === "assistant" &&
          (message.status === "queued" || message.status === "running"))?.id || "active"
        : null,
      steerAtStreamIndex: state.busy
        ? (state.active?.messages?.findLast((message) =>
          message.role === "assistant" &&
          (message.status === "queued" || message.status === "running"))?.stream || []).length
        : null,
    };
    setBusy(state.busy);
    renderMessages();
    ensureConversation(() => {
      state.sendRequest.signature = JSON.stringify([state.activeId, text, files.map((file) => file.id)]);
      if (files.length) {
        const waitingFiles = files.filter((file) => !state.sendRequest.uploadedByFile[file.id]);
        state.pendingSend = { text, waiting: new Set(waitingFiles.map((file) => file.id)) };
        if (!waitingFiles.length) { submitUploadedMessage(); return; }
        waitingFiles.forEach((file) => {
          file.state = "uploading";
          file.label = "准备上传";
          bridge()?.uploadFile?.(file.id);
        });
        renderAttachments();
      } else {
        sendPreparedMessage(text, []);
      }
    });
  }

  function resetComposer() {
    $("#messageInput").value = "";
    $("#messageInput").style.height = "";
    state.attachments.clear();
    state.pendingSend = null;
    state.optimisticMessage = null;
    renderAttachments();
  }

  window.DropVault = {
    openConversation: (id) => {
      bridge()?.requestConversations?.();
      selectConversation(id);
    },
    nativeReady(info = {}) {
      if (state.nativeInitialized) return;
      state.nativeInitialized = true;
      document.body.classList.add("native");
      const version = String(info.version || window.DropVaultAndroid?.getVersion?.() || "");
      state.nativeVersion = version;
      state.workspaceFeatures = Boolean(info.workspaceFeatures);
      // Do not expose controls whose native transport is absent in older APKs.
      $("#workspaceOverviewButton").hidden = !state.workspaceFeatures;
      $("#moreGroupButton").hidden = !state.workspaceFeatures;
      if (!state.workspaceFeatures) {
        $("#historySearch").placeholder = "搜索对话标题和摘要";
        $("#historySearchHint").textContent = "搜索标题与摘要 · 置顶仅保存在此设备";
        $("#historyProject").parentElement.hidden = true;
      }
      const cacheScope = String(info.cacheScope || window.DropVaultAndroid?.getCacheScope?.() || "");
      state.supportsSse = Boolean(info.supportsSse);
      if (/^[a-f0-9]{24,64}$/.test(cacheScope)) {
        state.cacheScope = cacheScope;
      }
      restoreDraft();
      if (version) $("#appVersion").textContent = `v${version}`;
      if (versionLessThan(version, "2.1.7")) {
        setTimeout(() => bridge()?.checkForUpdates?.(), 900);
      }
      state.supports21 = /^2\.(?:[1-9]|\d{2,})\.|^[3-9]\./.test(version || "");
      if (typeof bridge()?.requestConversations !== "function" ||
          typeof bridge()?.requestAuthStatus !== "function") {
        dismissBoot();
        setConnected(false, "需要更新 App");
        $("#welcome h1").textContent = "新版对话已经准备好";
        $("#welcome>p").textContent = "请先更新 Chloe，更新完成后即可在这里连续对话。";
        $("#composerHint").textContent = "请在侧栏中检查更新，以使用连续对话功能。";
        $("#messageInput").disabled = true;
        $("#attachButton").disabled = true;
        $("#sendButton").disabled = true;
        setTimeout(() => bridge()?.checkForUpdates?.(), 500);
        return;
      }
      bridge()?.requestAuthStatus?.();
    },
    onAuthStatus(json) {
      const payload = JSON.parse(json);
      if (payload.authenticated) {
        state.authenticated = true;
        state.admin = Boolean(payload.principal?.admin);
        applyPrincipalPolicy(payload.principal);
        $("#adminSettingsButton").hidden = !state.admin;
        $("#customerDevicesButton").hidden = !state.admin;
        $("#codexAccountsButton").hidden = !state.admin && state.allowedCodexProfiles.length < 2;
        hideActivation();
        bridge()?.requestCapabilities?.();
        void loadRuntimeExtras();
        hydrateConversationCache().finally(() => bridge()?.requestConversations?.());
        return;
      }
      if (payload.initialized) {
        if (payload.bootstrapEligible) {
          claimThisDevice();
          return;
        }
        showActivation("此设备尚未获授权，请输入邀请码。邀请码不会保存到网页中。");
        return;
      }
      showActivation("管理员正在初始化访问控制，请稍后重新连接。");
    },
    onAuthError(message) {
      showActivation(message || "无法验证这台设备，请检查网络后重试。");
    },
    onActivation(json) {
      const payload = JSON.parse(json);
      state.authenticated = true;
      state.admin = Boolean(payload.principal?.admin);
      applyPrincipalPolicy(payload.principal);
      $("#adminSettingsButton").hidden = !state.admin;
      $("#customerDevicesButton").hidden = !state.admin;
      $("#codexAccountsButton").hidden = !state.admin && state.allowedCodexProfiles.length < 2;
      $("#inviteCode").value = "";
      hideActivation();
      bridge()?.requestCapabilities?.();
      void loadRuntimeExtras();
      setConnected(true, "设备已激活");
      toast(`已激活：${payload.principal?.label || "此设备"}`);
      state.cacheHydrated = false;
      state.cacheScope = "";
      hydrateConversationCache().finally(() => bridge()?.requestConversations?.());
    },
    onActivationError(message) {
      $("#authGateHint").textContent = message || "邀请码无效或该设备未获授权。";
      $("#activateInviteButton").disabled = false;
      $("#activateInviteButton span").textContent = "再次尝试";
    },
    onConversations(json) {
      const payload = JSON.parse(json);
      state.conversations = payload.conversations || [];
      state.currentDeviceLabel = payload.currentDeviceLabel || "";
      persistConversationList();
      setConnected(true, "服务器在线");
      dismissBoot();
      renderConversations();
      if (state.activeId && state.conversations.some((item) => item.id === state.activeId)) {
        if (!state.active || state.active.id !== state.activeId) {
          selectConversation(state.activeId);
        } else {
          bridge()?.requestConversation?.(state.activeId);
          if (state.supportsSse && state.appVisible) {
            bridge()?.subscribeConversationEvents?.(state.activeId);
          }
        }
      } else if (state.conversations.length) {
        selectConversation(state.conversations[0].id);
      } else {
        state.activeId = null;
        state.active = null;
        state.workDir = "";
        prepareNewConversationSettings();
        updateModelControls();
        renderMessages();
      }
    },
    onCapabilities(json) {
      state.capabilities = JSON.parse(json);
      renderCapabilities();
      reconcileModelPreference();
      renderRuntimeControls();
    },
    onCapabilitiesError(message) {
      const serverLive = $("#appServerLive");
      if (serverLive) {
        serverLive.classList.add("offline");
        serverLive.innerHTML = "<i></i>OFFLINE";
      }
      $("#appServerStatus").textContent = message || "App Server 能力暂时不可用";
    },
    onLocalSshStatus(json) {
      renderLocalSsh(JSON.parse(json));
    },
    onLocalSshProfiles(json) {
      renderLocalSshProfiles(JSON.parse(json));
    },
    onLocalSshProfileError(message) {
      toast(message || "服务器配置操作失败");
    },
    onLocalSshConnected(json) {
      $("#localSshPassword").value = "";
      state.localSshAdding = false;
      state.localSshLost = false;
      localSshManualDisconnect = false;
      renderLocalSsh(JSON.parse(json));
      ensureLocalTerminal()?.reset();
      appendLocalTerminal("\x1b[38;2;85;214;170mChloe SSH\x1b[0m  手机已直连服务器\r\n");
      toast("服务器已连接");
    },
    onLocalSshOutput(text) {
      appendLocalTerminal(text);
    },
    onLocalSshError(message) {
      $("#localSshPassword").value = "";
      if (!state.localSsh.connected) renderLocalSsh({ connected: false, connecting: false });
      toast(message || "服务器连接失败");
    },
    onLocalSshDisconnected() {
      if (localSshManualDisconnect || !state.localSsh.connected) {
        localSshManualDisconnect = false;
        state.localSshLost = false;
        renderLocalSsh({ connected: false, connecting: false });
        return;
      }
      state.localSsh = { ...state.localSsh, connected: false, connecting: false };
      state.localSshLost = true;
      $("#localSshDrawerStatus").textContent = "连接已中断";
      $("#localTerminalTarget").textContent = `${state.localSsh.username || "root"}@${state.localSsh.host} · 已断开`;
      syncLocalSshPanels();
      appendLocalTerminal("\r\n\x1b[31m[Chloe] SSH 连接意外中断，请返回后重新连接。\x1b[0m\r\n");
    },
    onLocalSftpList(json) {
      renderLocalSftp(JSON.parse(json));
    },
    onLocalSftpError(message) {
      toast(message || "SFTP 操作失败");
    },
    onLocalSftpComplete(operation) {
      toast(operation === "upload" ? "文件已上传" : "文件已保存");
    },
    onConversationCreated(json) {
      const conversation = JSON.parse(json).conversation;
      const previousDraftKey = draftKey();
      state.activeId = conversation.id;
      saveDraft();
      if (previousDraftKey !== draftKey()) {
        try { localStorage.removeItem(previousDraftKey); } catch {}
        state.attachmentDrafts.delete(previousDraftKey);
      }
      state.active = conversation;
      state.model = conversation.model || state.model;
      state.reasoning = conversation.reasoning || state.reasoning;
      state.accessMode = conversation.accessMode || state.accessMode;
      state.draftModel = state.model;
      state.draftReasoning = state.reasoning;
      state.draftAccessMode = state.accessMode;
      state.codexProfile = conversation.codexProfile || "default";
      state.workDir = conversation.workDir || "";
      updateModelControls();
      localStorage.setItem("wit_active_conversation", conversation.id);
      persistConversation(conversation);
      if (state.supportsSse && state.appVisible) {
        bridge()?.subscribeConversationEvents?.(conversation.id);
      }
      bridge()?.requestConversations?.();
      renderMessages();
      const next = state.afterCreate;
      state.afterCreate = null;
      if (next) {
        next();
      } else {
        state.transmitting = false;
        setBusy(false);
        $("#messageInput").focus();
      }
    },
    onConversationForked(json) {
      const conversation = JSON.parse(json).conversation;
      saveDraft();
      state.activeId = conversation.id;
      restoreDraft();
      state.active = conversation;
      localStorage.setItem("wit_active_conversation", conversation.id);
      persistConversation(conversation);
      if (state.supportsSse && state.appVisible) {
        bridge()?.subscribeConversationEvents?.(conversation.id);
      }
      closeSettings();
      bridge()?.requestConversations?.();
      renderMessages();
      toast("已创建独立对话分支");
    },
    onConversationCompacted(json) {
      const conversation = JSON.parse(json).conversation;
      if (conversation?.id === state.activeId) {
        state.active = conversation;
        persistConversation(conversation);
      }
      closeSettings();
      toast("已开始压缩上下文");
    },
    onReviewStarted(json) {
      const conversation = JSON.parse(json).conversation;
      if (conversation?.id === state.activeId) {
        state.active = conversation;
        persistConversation(conversation);
        renderMessages(true);
      }
      closeSettings();
      setBusy(true);
      toast("代码审查已开始");
    },
    onAppServerActionError(message) {
      toast(message || "App Server 操作失败");
      renderCapabilities();
    },
    onConversation(json) {
      const conversation = JSON.parse(json).conversation;
      applyConversation(conversation);
    },
    onConversationDelta(json) {
      const payload = JSON.parse(json);
      const metadata = payload.conversation;
      if (!metadata || metadata.id !== state.activeId) return;
      const currentMessages = state.active?.messages || [];
      const replaceFrom = Number(payload.replaceFrom);
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      const offset = Number(state.active?.messageOffset || 0);
      if (!Number.isInteger(replaceFrom) || replaceFrom < offset || replaceFrom > offset + currentMessages.length ||
          replaceFrom + messages.length !== Number(payload.totalMessages)) {
        bridge()?.requestConversation?.(state.activeId);
        return;
      }
      applyConversation({
        ...state.active,
        ...metadata,
        messageOffset: offset,
        totalMessages: payload.totalMessages,
        hasMore: offset > 0,
        messages: [...currentMessages.slice(0, replaceFrom - offset), ...messages],
      });
    },
    onConversationPage(json) {
      const page = JSON.parse(json).conversation;
      state.loadingOlder = false;
      if (!page || page.id !== state.activeId || !state.active) return;
      const currentOffset = Number(state.active.messageOffset || 0);
      const pageOffset = Number(page.messageOffset);
      if (!Number.isInteger(pageOffset) || pageOffset >= currentOffset) { renderTaskStatus(); return; }
      const prefix = page.messages.slice(0, currentOffset - pageOffset);
      if (prefix.length !== currentOffset - pageOffset) { toast("历史消息已变化，请重新打开对话"); renderTaskStatus(); return; }
      state.active = { ...state.active, messageOffset: pageOffset, hasMore: pageOffset > 0, messages: [...prefix, ...state.active.messages] };
      persistConversation();
      renderMessages(true);
    },
    onConversationPageError(message) { state.loadingOlder = false; renderTaskStatus(); toast(message || "加载历史失败，请重试"); },
    onHistorySearch(json) {
      const payload = JSON.parse(json);
      if (String(payload.requestId) !== String(state.historyRequest)) return;
      state.historyResults = payload.conversations || [];
      $("#historySearchHint").textContent = `找到 ${state.historyResults.length} 条对话 · 全文搜索`;
      renderConversations();
    },
    onHistorySearchError(message) { $("#historySearchHint").textContent = message || "搜索失败，请重试"; },
    onConversationMetadataUpdated(json) {
      const conversation = JSON.parse(json).conversation;
      const item = state.conversations.find((entry) => entry.id === conversation?.id);
      if (item) Object.assign(item, { pinned: conversation.pinned, project: conversation.project });
      if (conversation?.id === state.activeId) applyConversation(conversation);
      renderConversations();
      persistConversationList();
      toast("已同步对话设置");
    },
    onConversationMetadataError(message) { toast(message || "同步失败，请重试"); },
    onWorkspaceOverview(json) {
      const payload = JSON.parse(json);
      const labels = { active: "运行中", inactive: "未运行", available: "可用", configured: "已配置", missing: "未配置", unknown: "待检查", connected: "已连接", error: "检查失败", running: "运行中" };
      const section = (title, rows) => `<section class="workspace-section"><h3>${escapeHtml(title)}</h3>${(rows || []).map((row) => `<article><div><strong>${escapeHtml(row.name || row.id)}</strong><small>${escapeHtml(row.description || row.role || row.detail || "")}</small>${row.workDir ? `<code>${escapeHtml(row.workDir)}</code>` : ""}</div>${row.status ? `<span>${escapeHtml(labels[row.status] || row.status)}</span>` : ""}</article>`).join("") || '<p>暂无信息</p>'}</section>`;
      $("#workspaceOverviewContent").innerHTML = section("项目", payload.projects) + section("服务器用途", payload.servers) + section("服务", payload.services) + section("服务连接", payload.connections) + `<p class="workspace-checked">核实时间：${escapeHtml(payload.checkedAt ? new Date(payload.checkedAt).toLocaleString() : "未知")}<br>${escapeHtml(payload.notice || "")}</p>`;
    },
    onWorkspaceOverviewError(message) { $("#workspaceOverviewContent").textContent = message || "检查失败，请重试"; },
    onAppVisibility(visible) {
      setAppVisible(visible);
    },
    onConversationInterruptRequested(json) {
      const conversation = JSON.parse(json).conversation;
      if (conversation?.id === state.activeId) {
        state.active = conversation;
        persistConversation(conversation);
      }
      state.pausing = true;
      renderMessages(true);
      toast("正在暂停当前执行");
    },
    onConversationInterruptError(message) {
      state.pausing = false;
      setBusy(state.busy);
      toast(message || "暂时无法暂停");
    },
    onApprovalResolved(json) {
      const wasUserInput = Boolean(document.querySelector(
        '[data-approval-card].submitting[data-approval-type="user_input"]'));
      const payload = JSON.parse(json);
      if (payload.conversation?.id === state.activeId) {
        state.active = payload.conversation;
        persistConversation();
        renderMessages(true);
      }
      toast(wasUserInput ? "回答已提交，继续执行" : "权限选择已提交");
    },
    onApprovalError(message) {
      document.querySelectorAll("[data-approval-card].submitting").forEach((card) => {
        card.classList.remove("submitting");
        card.querySelectorAll("button").forEach((button) => { button.disabled = false; });
      });
      $("#approvalDock")?.classList.remove("submitting");
      toast(message || "提交失败");
      if (state.activeId) bridge()?.requestConversation?.(state.activeId);
    },
    onMessageSent(json) {
      const payload = JSON.parse(json);
      if (payload.clientRequestId && payload.clientRequestId !== state.sendRequest?.id) return;
      const conversation = payload.conversation;
      if (conversation?.id !== state.activeId) { state.transmitting = false; bridge()?.requestConversations?.(); return; }
      state.active = conversation;
      persistConversation(state.active);
      state.transmitting = false;
      state.optimisticMessage = null;
      if ($("#messageInput").value.trim() === state.lastSubmittedText) {
        $("#messageInput").value = "";
        $("#messageInput").style.height = "";
      }
      state.lastSubmittedText = "";
      for (const id of state.sendRequest?.fileIds || []) state.attachments.delete(id);
      state.pendingSend = null;
      state.sendRequest = null;
      saveDraft();
      renderAttachments();
      renderMessages();
      bridge()?.requestConversations?.();
    },
    onMessageSendError(message, clientRequestId) {
      if (clientRequestId && clientRequestId !== state.sendRequest?.id) return;
      state.pendingSend = null;
      state.transmitting = false;
      if (state.optimisticMessage) state.optimisticMessage.status = "failed";
      setBusy(state.busy);
      renderMessages(true);
      toast(message || "消息发送失败");
    },
    onSettingsUpdated(json) {
      const conversation = JSON.parse(json).conversation;
      if (conversation?.id !== state.activeId) return;
      state.active = conversation;
      state.model = conversation.model;
      state.reasoning = conversation.reasoning;
      state.accessMode = conversation.accessMode;
      state.draftModel = state.model;
      state.draftReasoning = state.reasoning;
      state.draftAccessMode = state.accessMode;
      state.codexProfile = conversation.codexProfile || "default";
      state.workDir = conversation.workDir || "";
      persistConversation(conversation);
      persistModelPreference();
      localStorage.setItem("wit_codex_profile", state.codexProfile);
      updateModelControls();
      closeSettings();
      toast(`设置已更新 · ${modelNames[state.model]} · ${reasoningNames[state.reasoning]}`);
      bridge()?.requestConversations?.();
    },
    onConversationProjectUpdated(json) {
      const conversation = JSON.parse(json).conversation;
      if (conversation.id !== state.activeId) return;
      state.active = conversation;
      state.workDir = conversation.workDir || "";
      persistConversation(conversation);
      updateModelControls();
      closeProject();
      toast(`已切换到${projectName(state.workDir)}`);
      bridge()?.requestConversations?.();
    },
    onConversationProjectError(message) {
      toast(message || "项目切换失败");
    },
    onUsage(json) {
      state.usageLoading = false;
      state.usage = JSON.parse(json);
      updateQuotaStatus();
      renderUsage();
    },
    onUsageError(message) {
      state.usageLoading = false;
      $("#usageContent").innerHTML = `
        <div class="usage-error"><strong>暂时无法读取用量</strong><small>${escapeHtml(message || "稍后再试")}</small><button id="retryUsage">重新读取</button></div>`;
      $("#retryUsage")?.addEventListener("click", () => {
        state.usageLoading = true;
        renderUsage();
        bridge()?.requestUsage?.(state.activeId || "");
      });
    },
    onUsageReset(json) {
      const outcome = JSON.parse(json)?.outcome;
      toast(outcome === "reset" || outcome === "alreadyRedeemed" ? "额度已重置" : outcome === "nothingToReset" ? "当前无需重置" : "没有可用重置额度");
      state.usage = null;
      state.usageLoading = true;
      renderUsage();
      bridge()?.requestUsage?.(state.activeId || "");
    },
    onUsageResetError(message) {
      toast(message || "重置额度失败");
      state.usage = null;
      state.usageLoading = true;
      renderUsage();
      bridge()?.requestUsage?.(state.activeId || "");
    },
    onAdminDevices(json) { renderAdminDevices(JSON.parse(json).devices || []); },
    onInviteCreated(json) {
      const invite = JSON.parse(json).invite;
      $("#latestInvite").innerHTML = `<div class="latest-invite"><small>新邀请码 · ${escapeHtml(invite.label || "新设备")}</small><code>${escapeHtml(invite.code || "")}</code></div>`;
      $("#inviteLabel").value = "";
      toast("邀请码已创建，请安全地发送给对方");
    },
    onDeviceDisabled() { toast("该设备已停止访问"); bridge()?.requestAdminDevices?.(); },
    onCodexAccounts(json) {
      renderCodexAccounts(JSON.parse(json).accounts || []);
    },
    onCodexLoginStarted(json) {
      const login = JSON.parse(json);
      state.codexLoginProfile = login.profile || state.codexLoginProfile;
      state.codexLoginUrl = login.verificationUrl || "";
      $("#codexDeviceCode").textContent = login.userCode || "";
      setCodexLoginFlow(true);
      $("#codexLoginHint").textContent = "等待你完成授权…";
      startCodexLoginPolling();
    },
    onCodexLoginStatus(json) {
      const result = JSON.parse(json);
      if (result.status === "pending") {
        $("#codexLoginHint").textContent = "等待你完成授权…";
        return;
      }
      stopCodexLoginPolling();
      if (result.status === "authenticated") {
        setCodexLoginFlow(false);
        state.codexLoginUrl = "";
        toast(`${codexAccountLabel(state.codexLoginProfile)}已连接`);
        bridge()?.requestCodexAccounts?.();
        return;
      }
      $("#codexLoginHint").textContent =
        result.status === "failed" ? (result.error || "登录未完成，请重试") : "尚未完成登录";
    },
    onCodexLoginCancelled() {
      stopCodexLoginPolling();
      state.codexLoginUrl = "";
      state.codexLoginProfile = "";
      setCodexLoginFlow(false);
      toast("已取消账号登录");
    },
    onAdminError(message) { toast(message || "设备管理操作失败"); },
    onChatError(message) {
      dismissBoot();
      setConnected(false, "连接失败");
      state.afterCreate = null;
      state.transmitting = false;
      if (state.optimisticMessage) state.optimisticMessage.status = "failed";
      setBusy(state.busy);
      renderMessages(true);
      toast(message || "暂时无法连接服务器");
    },
    onFilesPicked(json) {
      JSON.parse(json).forEach((file) => state.attachments.set(file.id, { ...file, progress: 0 }));
      renderAttachments();
    },
    onUploadProgress(id, percent) {
      const file = state.attachments.get(id);
      if (!file) return;
      file.progress = percent;
      file.state = "uploading";
      file.label = `${percent}%`;
      renderAttachments();
    },
    onUploadFinished(id, ok, message, responseJson) {
      const file = state.attachments.get(id);
      if (!file || !state.pendingSend?.waiting.has(id)) return;
      if (!ok) {
        file.state = "error";
        file.label = "上传失败";
        state.pendingSend = null;
        state.transmitting = false;
        setBusy(state.busy);
        renderAttachments();
        toast(message || "附件上传失败");
        return;
      }
      try {
        const uploadId = JSON.parse(responseJson).file.id;
        state.sendRequest.uploadedByFile[id] = uploadId;
      } catch {
        this.onMessageSendError("服务器没有返回附件编号");
        return;
      }
      file.progress = 100;
      file.state = "done";
      file.label = "已上传";
      state.pendingSend.waiting.delete(id);
      renderAttachments();
      if (!state.pendingSend.waiting.size) submitUploadedMessage();
    },
    onConversationArchived(id) {
      if (state.activeId === id) {
        state.activeId = null;
        state.active = null;
        localStorage.removeItem("wit_active_conversation");
      }
      deleteCachedRecord(`conversation:${id}`);
      state.archiveId = null;
      closeArchiveDialog();
      bridge()?.requestConversations?.();
      renderMessages();
      toast("对话已移出列表");
    },
    onStreamDetail(json) {
      const payload = JSON.parse(json);
      if (!state.detailRequest || !payload.entry) return;
      state.detailEntry = payload.entry;
      renderActionDetail(payload.entry);
    },
    onStreamDetailError(message) {
      if (!state.detailRequest) return;
      $("#actionDetailContent").innerHTML =
        `<div class="detail-error">${escapeHtml(message || "暂时无法读取执行详情")}</div>`;
    },
    onDevelopmentWorkflowError(message) {
      const key = state.pendingDevelopmentWorkflowKey;
      const action = state.pendingDevelopmentAction;
      state.pendingDevelopmentWorkflowKey = "";
      state.pendingDevelopmentAction = "";
      if (key) {
        const previous = state.developmentWorkflowJobs.get(key) || {};
        const failed = ["commit", "deploy", "resume-push"].includes(action)
          ? previous
          : { ...previous, status: "failed", stage: previous.stage || "test",
            message: message || "无法提交项目交付请求" };
        state.developmentWorkflowJobs.set(key, failed);
        if (state.detailEntry) renderActionDetail(state.detailEntry);
      }
      toast(message || "项目交付请求失败");
    },
    onDevelopmentWorkflow(json) {
      try {
        const payload = typeof json === "string" ? JSON.parse(json) : json;
        const job = payload?.job && typeof payload.job === "object" ? payload.job : payload;
        const messageId = payload?.messageId || job?.messageId;
        const conversationId = payload?.conversationId || job?.conversationId ||
          (state.active?.messages?.some((item) => item.id === messageId) ? state.activeId : "");
        if (!conversationId || !messageId) return;
        const update = { ...job, ...payload, conversationId, messageId };
        if (payload?.job) Object.assign(update, payload.job);
        const key = developmentWorkflowKey(conversationId, messageId);
        if (state.pendingDevelopmentWorkflowKey === key) {
          state.pendingDevelopmentWorkflowKey = "";
          state.pendingDevelopmentAction = "";
        }
        state.developmentWorkflowJobs.set(key, update);
        if (state.detailEntry && state.detailRequest?.messageId === messageId &&
            state.activeId === conversationId) renderActionDetail(state.detailEntry);
        if (state.activeId === conversationId && state.appVisible &&
            ["completed", "succeeded", "failed"].includes(String(update.status || "").toLowerCase())) {
          toast(update.message || update.error || developmentWorkflowLabel(update));
        }
      } catch {
        // Ignore malformed progress events; the conversation stream remains usable.
      }
    },
  };

  function beginNewConversation(codexProfile = null) {
    if (state.transmitting) { toast("消息正在送达，完成后即可新建对话"); return; }
    saveDraft();
    const selectedProfile = codexProfile || state.allowedCodexProfiles[0] || "default";
    state.activeId = null;
    state.active = null;
    state.codexProfile = state.allowedCodexProfiles.includes(selectedProfile)
      ? selectedProfile : state.allowedCodexProfiles[0];
    state.workDir = state.codexProfile === "xuanyu" ? "/data/xuanyu-build-console" : "";
    localStorage.setItem("wit_codex_profile", state.codexProfile);
    localStorage.removeItem("wit_active_conversation");
    prepareNewConversationSettings();
    resetComposer();
    restoreDraft();
    updateModelControls();
    renderMessages();
    state.transmitting = true;
    setBusy(false);
    requestConversationCreation(state.workDir);
  }

  function openArchiveDialog(id) {
    state.archiveId = id;
    $("#dialogLayer").classList.add("open");
    $("#dialogLayer").setAttribute("aria-hidden", "false");
  }

  function closeArchiveDialog() {
    $("#dialogLayer").classList.remove("open");
    $("#dialogLayer").setAttribute("aria-hidden", "true");
  }

  $("#menuButton").addEventListener("click", openDrawer);
  $("#newChatButton").addEventListener("click", () => {
    setChatMoreMenu(false);
    beginNewConversation();
  });
  $("#chatMoreButton").addEventListener("click", () =>
    setChatMoreMenu(!$("#chatMoreMenu").classList.contains("open")));
  $("#moreShareButton").addEventListener("click", async () => {
    setChatMoreMenu(false);
    const payload = { title: state.active?.title || "Chloe 对话", text: "来自 Chloe 的对话" };
    try {
      if (navigator.share) await navigator.share(payload);
      else { await navigator.clipboard.writeText(payload.text); toast("分享说明已复制"); }
    } catch (error) { if (error?.name !== "AbortError") toast("暂时无法打开分享面板"); }
  });
  $("#morePinButton").addEventListener("click", () => {
    if (!state.activeId) { toast("当前没有可置顶的对话"); return; }
    const pinned = pinnedIds();
    const added = !pinned.has(state.activeId);
    if (state.workspaceFeatures) {
      bridge()?.updateConversationMetadata?.(state.activeId, JSON.stringify({ pinned: added }));
      setChatMoreMenu(false);
      return;
    }
    if (added) pinned.add(state.activeId); else pinned.delete(state.activeId);
    try {
      localStorage.setItem(`wit_pinned_conversations:${state.cacheScope}`, JSON.stringify([...pinned]));
    } catch { toast("设备存储不可用，未能保存置顶"); return; }
    renderConversations();
    setChatMoreMenu(false);
    toast(added ? "已置顶这条对话" : "已取消置顶");
  });
  $("#moreGroupButton").addEventListener("click", () => {
    setChatMoreMenu(false);
    if (!state.activeId) return;
    if (!state.workspaceFeatures) { toast("当前客户端暂不支持项目分组"); return; }
    const project = window.prompt("项目分组名称（留空取消分组，不更改工作目录）", state.active?.project || "");
    if (project === null) return;
    if (project.trim().length > 80) { toast("分组名称请保持在 80 字以内"); return; }
    bridge()?.updateConversationMetadata?.(state.activeId, JSON.stringify({ project: project.trim() }));
  });
  $("#moreNotifyButton").setAttribute("aria-pressed", String(completionReminder));
  $("#completionNotifyLabel").textContent = completionReminder ? "已开启" : "已关闭";
  $("#moreNotifyButton").addEventListener("click", () => {
    completionReminder = !completionReminder;
    try { localStorage.setItem("witt_completion_reminder", completionReminder ? "1" : "0"); } catch {}
    $("#moreNotifyButton").setAttribute("aria-pressed", String(completionReminder));
    $("#completionNotifyLabel").textContent = completionReminder ? "已开启" : "已关闭";
    toast(completionReminder ? "已开启前台完成提醒，不含后台推送" : "已关闭完成提醒");
  });
  $("#historySearch").addEventListener("input", () => { clearTimeout(historySearchTimer); historySearchTimer = setTimeout(refreshHistorySearch, 300); });
  $("#historyProject").addEventListener("change", refreshHistorySearch);
  $("#historyAttachments").addEventListener("change", refreshHistorySearch);
  $("#loadOlderMessages").addEventListener("click", () => {
    if (state.loadingOlder || !state.active?.hasMore || !state.workspaceFeatures) return;
    state.loadingOlder = true;
    renderTaskStatus();
    bridge()?.requestConversationPage?.(state.activeId, String(state.active.messageOffset), 40);
  });
  $("#workspaceOverviewButton").addEventListener("click", openWorkspaceOverview);
  $("#runtimeSettingsButton").addEventListener("click", () => {
    closeDrawer();
    openSettings();
  });
  $("#closeWorkspace").addEventListener("click", closeWorkspaceOverview);
  $("#workspaceBackdrop").addEventListener("click", closeWorkspaceOverview);
  $("#refreshWorkspace").addEventListener("click", requestWorkspaceOverview);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeWorkspaceOverview(); });
  $("#closeDrawer").addEventListener("click", () => {
    if (document.body.classList.contains("web-browser") && window.matchMedia("(min-width: 1000px)").matches) {
      document.body.classList.add("sidebar-collapsed");
    }
    closeDrawer();
  });
  $("#drawerBackdrop").addEventListener("click", closeDrawer);
  $("#profileButton").addEventListener("click", openProfile);
  $("#localSshButton").addEventListener("click", openLocalSsh);
  $("#adminSettingsButton").addEventListener("click", openAdminSettings);
  $("#codexAccountsButton").addEventListener("click", openCodexAccounts);
  $(".theme-options").addEventListener("click", (event) => {
    const button = event.target.closest("[data-theme-choice]");
    if (!button) return;
    applyTheme(button.dataset.themeChoice, true);
  });
  $("#nightModeButton").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(next, true);
  });
  $("#closeProfile").addEventListener("click", closeProfile);
  $("#profileBackdrop").addEventListener("click", closeProfile);
  $("#closeLocalSsh").addEventListener("click", closeLocalSsh);
  $("#localSshBackdrop").addEventListener("click", closeLocalSsh);
  $("#addLocalSshProfile").addEventListener("click", () => {
    if (state.localSsh.connected) {
      bridge()?.disconnectLocalSsh?.();
      renderLocalSsh({ connected: false, connecting: false });
    }
    setLocalSshAdding(true);
    requestAnimationFrame(() => $("#localSshLabel").focus());
  });
  $("#cancelLocalSshProfile").addEventListener("click", () => setLocalSshAdding(false));
  $("#localSshProfiles").addEventListener("click", (event) => {
    const deleteId = event.target.closest("[data-delete-ssh-profile]")?.dataset.deleteSshProfile;
    if (deleteId) {
      const profile = state.localSshProfiles.find((item) => item.id === deleteId);
      if (confirm(`删除“${profile?.label || "这台服务器"}”及其本机加密密码？`)) {
        bridge()?.deleteSavedLocalSsh?.(deleteId);
      }
      return;
    }
    const profileId = event.target.closest("[data-connect-ssh-profile]")?.dataset.connectSshProfile;
    if (!profileId) return;
    const profile = state.localSshProfiles.find((item) => item.id === profileId);
    renderLocalSsh({
      connected: false,
      connecting: true,
      profileId,
      host: profile?.host || "",
      username: profile?.username || "root",
      port: profile?.port || 22,
    });
    bridge()?.connectSavedLocalSsh?.(profileId);
  });
  $("#toggleLocalSshPassword").addEventListener("click", () => {
    const input = $("#localSshPassword");
    input.type = input.type === "password" ? "text" : "password";
    $("#toggleLocalSshPassword").setAttribute(
      "aria-label", input.type === "password" ? "显示密码" : "隐藏密码");
  });
  $("#localSshConnectForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const password = $("#localSshPassword").value;
    const port = Number($("#localSshPort").value || 22);
    renderLocalSsh({ connected: false, connecting: true });
    bridge()?.saveAndConnectLocalSsh?.(
      $("#localSshLabel").value.trim(),
      $("#localSshHost").value.trim(),
      $("#localSshUsername").value.trim() || "root",
      port,
      password,
    );
    $("#localSshPassword").value = "";
  });
  $("#localSftpButton").addEventListener("click", () => openLocalSftp());
  $("#localTerminalContext").addEventListener("click", (event) => {
    const action = event.target.closest("[data-terminal-context]")?.dataset.terminalContext;
    if (action) handleLocalTerminalContextAction(action);
  });
  document.addEventListener("pointerdown", (event) => {
    const menu = $("#localTerminalContext");
    if (!menu?.hidden && !menu.contains(event.target)) hideLocalTerminalContext(true);
  });
  $("#closeLocalSftp").addEventListener("click", closeLocalSftp);
  $("#localSftpParent").addEventListener("click", () =>
    openLocalSftp(localSftpParent(state.localSftpPath)));
  $("#uploadLocalSftp").addEventListener("click", () =>
    bridge()?.pickLocalSftpUpload?.(state.localSftpPath));
  $("#localSftpList").addEventListener("click", (event) => {
    const directory = event.target.closest("[data-sftp-directory]")?.dataset.sftpDirectory;
    if (directory) {
      openLocalSftp(directory);
      return;
    }
    const download = event.target.closest("[data-sftp-download]");
    if (download) {
      bridge()?.downloadLocalSftp?.(download.dataset.sftpDownload, download.dataset.sftpName || "file");
    }
  });
  $(".local-terminal-tools").addEventListener("click", (event) => {
    const button = event.target.closest("[data-terminal-key]");
    if (!button) return;
    const key = {
      escape: "\u001b",
      tab: "\t",
      up: "\u001b[A",
      down: "\u001b[B",
      interrupt: "\u0003",
    }[button.dataset.terminalKey];
    sendLocalTerminalInput(key);
    localTerminal?.focus();
  });
  $("#localTerminalControl").addEventListener("click", () => {
    setLocalTerminalControl(!localTerminalControlArmed);
    localTerminal?.focus();
  });
  $("#localTerminalKeyboard").addEventListener("click", () => localTerminal?.focus());
  $("#localTerminalClear").addEventListener("click", () => {
    localTerminal?.clear();
    localTerminal?.focus();
  });
  $("#disconnectLocalSsh").addEventListener("click", () => {
    localSshManualDisconnect = true;
    bridge()?.disconnectLocalSsh?.();
    state.localSshLost = false;
    renderLocalSsh({ connected: false, connecting: false });
  });
  window.visualViewport?.addEventListener("resize", syncLocalSshViewport);
  window.visualViewport?.addEventListener("scroll", syncLocalSshViewport);
  window.addEventListener("resize", () => {
    syncLocalSshViewport();
    fitLocalTerminal();
  });
  $("#closeAdminSettings").addEventListener("click", closeAdminSettings);
  $("#adminSettingsBackdrop").addEventListener("click", closeAdminSettings);
  $("#closeCodexAccounts").addEventListener("click", closeCodexAccounts);
  $("#codexAccountBackdrop").addEventListener("click", closeCodexAccounts);
  $("#codexAccountList").addEventListener("click", (event) => {
    const login = event.target.closest("[data-login-codex]")?.dataset.loginCodex;
    if (login) {
      state.codexLoginProfile = login;
      $("#codexLoginKicker").textContent = `${codexAccountLabel(login)}登录`;
      $("#codexDeviceCode").textContent = "";
      $("#codexLoginHint").textContent = "正在创建安全登录流程…";
      setCodexLoginFlow(true);
      if (!codexLoginAction("start", login)) setCodexLoginFlow(false);
      return;
    }
    const profile = event.target.closest("[data-new-codex-chat]")?.dataset.newCodexChat;
    if (!profile) return;
    closeCodexAccounts();
    beginNewConversation(profile);
  });
  $("#copyCodexDeviceCode").addEventListener("click", async () => {
    const code = $("#codexDeviceCode").textContent.trim();
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      toast("一次性代码已复制");
    } catch {
      toast("长按代码即可复制");
    }
  });
  $("#openCodexLogin").addEventListener("click", () => {
    if (!state.codexLoginUrl) return;
    window.location.href = state.codexLoginUrl;
  });
  $("#cancelCodexLogin").addEventListener("click", () =>
    codexLoginAction("cancel"));
  $("#createInviteButton").addEventListener("click", () => {
    const label = $("#inviteLabel").value.trim() || "新设备";
    bridge()?.createInvite?.(label, 1);
  });
  $("#deviceList").addEventListener("click", (event) => {
    const id = event.target.closest("[data-disable-device]")?.dataset.disableDevice;
    if (id) bridge()?.disableDevice?.(id);
  });
  $("#quotaConfirmBackdrop").addEventListener("click", closeQuotaResetConfirm);
  $("#cancelQuotaReset").addEventListener("click", closeQuotaResetConfirm);
  $("#confirmQuotaReset").addEventListener("click", consumeQuotaReset);
  $("#usageContent").addEventListener("click", (event) => {
    if (event.target.closest("[data-reset-rate-limit]")) {
      openQuotaResetConfirm();
      return;
    }
    const day = event.target.closest("[data-usage-date]");
    if (!day) return;
    toast(`${day.dataset.usageDate} · ${Number(day.dataset.usageTokens || 0).toLocaleString("zh-CN")} tokens`);
  });
  $("#deliveryButton").addEventListener("click", () => {
    setChatMoreMenu(false);
    openDelivery();
  });
  $("#quotaButton").addEventListener("click", () => {
    setChatMoreMenu(false);
    openProfile();
  });
  $("#moreProjectButton").addEventListener("click", () => {
    setChatMoreMenu(false);
    openProject();
  });
  $("#moreUploadsButton").addEventListener("click", () => {
    setChatMoreMenu(false);
    const count = (state.active?.messages || []).reduce((total, message) =>
      total + (Array.isArray(message.attachments) ? message.attachments.length : 0), 0);
    toast(count ? `本对话已有 ${count} 个上传文件` : "本对话还没有上传文件");
  });
  $("#moreFindButton").addEventListener("click", () => {
    setChatMoreMenu(false);
    const term = window.prompt("查找聊天内容");
    if (!term) return;
    const found = window.find?.(term, false, false, true, false, true, false);
    if (!found) toast("没有找到相关内容");
  });
  $("#moreHomeButton").addEventListener("click", () => {
    setChatMoreMenu(false);
    toast("请使用浏览器菜单中的“添加到主屏幕”");
  });
  $("#moreArchiveButton").addEventListener("click", () => {
    setChatMoreMenu(false);
    if (!state.activeId) { toast("当前没有可归档的对话"); return; }
    openArchiveDialog(state.activeId);
  });
  $("#moreDeleteButton").addEventListener("click", () => {
    setChatMoreMenu(false);
    if (!state.activeId) { toast("当前没有可删除的对话"); return; }
    openArchiveDialog(state.activeId);
  });
  $("#closeDelivery").addEventListener("click", closeDelivery);
  $("#deliveryBackdrop").addEventListener("click", closeDelivery);
  $("#closeActionDetail").addEventListener("click", closeActionDetail);
  $("#actionDetailContent").addEventListener("click", (event) => {
    const prepareCommit = event.target.closest("[data-workflow-prepare-commit]");
    if (prepareCommit) {
      prepareCommit.hidden = true;
      prepareCommit.parentElement?.querySelector("[data-workflow-commit-confirm-panel]")?.removeAttribute("hidden");
      return;
    }
    if (event.target.closest("[data-workflow-cancel-commit]")) {
      const section = event.target.closest(".development-workflow");
      const prepareButton = section?.querySelector("[data-workflow-prepare-commit]");
      if (prepareButton) prepareButton.hidden = false;
      section?.querySelector("[data-workflow-commit-confirm-panel]")?.setAttribute("hidden", "");
      return;
    }
    const confirmCommit = event.target.closest("[data-workflow-confirm-commit]");
    if (confirmCommit) {
      if (typeof bridge()?.confirmDevelopmentCommit !== "function") {
        toast("请更新 Chloe App 后再提交");
        return;
      }
      const section = event.target.closest(".development-workflow");
      const key = section?.dataset.workflowKey || "";
      const input = section?.querySelector("[data-workflow-commit-message]");
      const commitMessage = String(input?.value || "").trim().slice(0, 120);
      if (!commitMessage) {
        toast("请填写提交说明");
        input?.focus();
        return;
      }
      if (!key || !confirmCommit.dataset.jobId || state.pendingDevelopmentWorkflowKey) return;
      state.pendingDevelopmentWorkflowKey = key;
      state.pendingDevelopmentAction = "commit";
      confirmCommit.disabled = true;
      confirmCommit.textContent = "正在请求提交";
      bridge().confirmDevelopmentCommit(confirmCommit.dataset.jobId, commitMessage);
      return;
    }
    const prepareResume = event.target.closest("[data-workflow-prepare-resume]");
    if (prepareResume) {
      prepareResume.hidden = true;
      prepareResume.parentElement?.querySelector("[data-workflow-resume-confirm-panel]")?.removeAttribute("hidden");
      return;
    }
    if (event.target.closest("[data-workflow-cancel-resume]")) {
      const section = event.target.closest(".development-workflow");
      const prepareButton = section?.querySelector("[data-workflow-prepare-resume]");
      if (prepareButton) prepareButton.hidden = false;
      section?.querySelector("[data-workflow-resume-confirm-panel]")?.setAttribute("hidden", "");
      return;
    }
    const prepareDeploy = event.target.closest("[data-workflow-prepare-deploy]");
    if (prepareDeploy) {
      prepareDeploy.hidden = true;
      prepareDeploy.parentElement?.querySelector("[data-workflow-deploy-confirm-panel]")?.removeAttribute("hidden");
      return;
    }
    if (event.target.closest("[data-workflow-cancel-deploy]")) {
      const section = event.target.closest(".development-workflow");
      const prepareButton = section?.querySelector("[data-workflow-prepare-deploy]");
      if (prepareButton) prepareButton.hidden = false;
      section?.querySelector("[data-workflow-deploy-confirm-panel]")?.setAttribute("hidden", "");
      return;
    }
    const confirmDeploy = event.target.closest("[data-workflow-confirm-deploy]");
    if (confirmDeploy) {
      if (typeof bridge()?.confirmDevelopmentDeploy !== "function") {
        toast("请更新 Chloe App 后再部署");
        return;
      }
      const key = event.target.closest(".development-workflow")?.dataset.workflowKey || "";
      if (!key || !confirmDeploy.dataset.jobId || state.pendingDevelopmentWorkflowKey) return;
      state.pendingDevelopmentWorkflowKey = key;
      state.pendingDevelopmentAction = "deploy";
      confirmDeploy.disabled = true;
      confirmDeploy.textContent = "正在请求部署";
      bridge().confirmDevelopmentDeploy(confirmDeploy.dataset.jobId);
      return;
    }
    const stop = event.target.closest("[data-workflow-stop]");
    if (stop) {
      if (typeof bridge()?.cancelDevelopmentWorkflow !== "function") {
        toast("请更新 Chloe App 后再取消交付");
        return;
      }
      stop.disabled = true;
      bridge().cancelDevelopmentWorkflow(stop.dataset.jobId);
      return;
    }
    const resumePush = event.target.closest("[data-workflow-resume-push]");
    if (resumePush) {
      if (typeof bridge()?.resumeDevelopmentPush !== "function") {
        toast("请更新 Chloe App 后再重试推送");
        return;
      }
      if (state.pendingDevelopmentWorkflowKey) return;
      state.pendingDevelopmentWorkflowKey = event.target.closest(".development-workflow")?.dataset.workflowKey || "";
      state.pendingDevelopmentAction = "resume-push";
      resumePush.disabled = true;
      bridge().resumeDevelopmentPush(resumePush.dataset.jobId);
      return;
    }
    const prepare = event.target.closest("[data-workflow-prepare]");
    if (prepare) {
      const panel = prepare.parentElement?.querySelector("[data-workflow-confirm-panel]");
      if (panel) {
        prepare.hidden = true;
        panel.hidden = false;
      }
      return;
    }
    if (event.target.closest("[data-workflow-cancel]")) {
      const section = event.target.closest(".development-workflow");
      const prepareButton = section?.querySelector("[data-workflow-prepare]");
      const panel = section?.querySelector("[data-workflow-confirm-panel]");
      if (prepareButton) prepareButton.hidden = false;
      if (panel) panel.hidden = true;
      return;
    }
    if (!event.target.closest("[data-workflow-confirm-send]")) return;
    const request = state.detailRequest;
    if (!request || !state.activeId || !state.active || state.busy || state.active.busy) {
      toast("当前对话状态已变化，请刷新后再试");
      return;
    }
    const native = bridge();
    if (typeof native?.startDevelopmentWorkflow !== "function") {
      toast("请更新 Chloe App 后再使用项目交付");
      bridge()?.checkForUpdates?.();
      return;
    }
    const key = developmentWorkflowKey(state.activeId, request.messageId);
    const section = event.target.closest(".development-workflow");
    const button = event.target.closest("[data-workflow-confirm-send]");
    button.disabled = true;
    button.textContent = "正在提交请求";
    const queued = {
      conversationId: state.activeId,
      messageId: request.messageId,
      status: "queued",
      stage: "test",
      message: "已请求运行测试；提交与部署需另行确认",
    };
    state.developmentWorkflowJobs.set(key, queued);
    state.pendingDevelopmentWorkflowKey = key;
    state.pendingDevelopmentAction = "delivery";
    const status = section?.querySelector("[data-development-workflow-status]");
    if (status) {
      status.hidden = false;
      status.textContent = developmentWorkflowLabel(queued);
      status.dataset.workflowKey = key;
    } else if (section) {
      const statusNode = document.createElement("p");
      statusNode.className = "development-workflow-status";
      statusNode.dataset.developmentWorkflowStatus = "";
      statusNode.dataset.workflowKey = key;
      statusNode.setAttribute("role", "status");
      statusNode.setAttribute("aria-live", "polite");
      statusNode.textContent = developmentWorkflowLabel(queued);
      section.insertBefore(statusNode, section.querySelector("[data-workflow-confirm-panel]"));
    }
    section?.querySelector("[data-workflow-confirm-panel]")?.setAttribute("hidden", "");
    native.startDevelopmentWorkflow(state.activeId, request.messageId, "");
  });
  $("#actionDetailBackdrop").addEventListener("click", closeActionDetail);
  $("#closeImageViewer").addEventListener("click", closeImageViewer);
  $("#downloadImageViewer").addEventListener("click", () => {
    const button = $("#downloadImageViewer");
    if (!button.dataset.url) return;
    if (typeof bridge()?.downloadImage === "function") {
      bridge().downloadImage(button.dataset.url, button.dataset.name, button.dataset.mimeType);
      toast("正在下载图片");
      return;
    }
    const link = document.createElement("a");
    link.href = button.dataset.url;
    link.download = button.dataset.name || "Chloe 图片";
    link.click();
  });
  $("#imageViewerBackdrop").addEventListener("click", closeImageViewer);
  $("#deliveryList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-artifact]");
    if (!button || !state.activeId) return;
    const artifact = allArtifacts().find((item) =>
      item.id === button.dataset.artifact && item.messageId === button.dataset.message);
    if (!artifact) return;
    if (typeof bridge()?.downloadArtifact === "function") {
      bridge().downloadArtifact(
        state.activeId, artifact.messageId, artifact.id, artifact.name, artifact.mimeType || "");
    } else {
      downloadArtifactUrl(artifactUrl(artifact.messageId, artifact), artifact.name);
    }
    toast("正在下载交付文件");
  });
  $("#messageList").addEventListener("click", (event) => {
    const handoff = event.target.closest("[data-open-artifact]");
    if (handoff) openArtifact(handoff.dataset.openArtifact);
  });
  $("#artifactClose").addEventListener("click", closeArtifact);
  $("#artifactPreviewTab").addEventListener("click", () => setArtifactMode("preview"));
  $("#artifactCodeTab").addEventListener("click", () => setArtifactMode("code"));
  $("#artifactPreviousVersion").addEventListener("click", () => {
    const group = selectedArtifactGroup();
    if (!group || state.artifactVersionIndex <= 0) return;
    state.artifactVersionIndex -= 1;
    state.artifactFollowLatest = false;
    renderArtifactWorkspace();
  });
  $("#artifactNextVersion").addEventListener("click", () => {
    const group = selectedArtifactGroup();
    if (!group || state.artifactVersionIndex >= group.versions.length - 1) return;
    state.artifactVersionIndex += 1;
    state.artifactFollowLatest = state.artifactVersionIndex === group.versions.length - 1;
    renderArtifactWorkspace();
  });
  $("#artifactSwitch").addEventListener("click", () => {
    const switcher = $("#artifactSwitcher");
    const open = !switcher.classList.contains("open");
    switcher.classList.toggle("open", open);
    switcher.setAttribute("aria-hidden", String(!open));
    $("#artifactSwitch").setAttribute("aria-expanded", String(open));
  });
  $("#artifactSwitcher").addEventListener("click", (event) => {
    const button = event.target.closest("[data-select-artifact]");
    if (!button) return;
    openArtifact(button.dataset.selectArtifact);
    $("#artifactSwitcher").classList.remove("open");
    $("#artifactSwitcher").setAttribute("aria-hidden", "true");
  });
  $("#artifactFrame").addEventListener("load", () => {
    $("#artifactLoading").hidden = true;
  });
  $("#artifactCopy").addEventListener("click", async () => {
    const group = selectedArtifactGroup();
    const version = group?.versions[state.artifactVersionIndex];
    if (!version) return;
    try {
      const source = await loadArtifactSource(version);
      await navigator.clipboard.writeText(source);
      toast("Artifact 源码已复制");
    } catch (error) { toast(error.message || "复制失败"); }
  });
  $("#artifactDownload").addEventListener("click", async () => {
    const group = selectedArtifactGroup();
    const version = group?.versions[state.artifactVersionIndex];
    if (!version) return;
    try {
      const source = await loadArtifactSource(version);
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([source], { type: "text/html;charset=utf-8" }));
      link.download = group.name || "artifact.html";
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 0);
      toast("正在下载 Artifact");
    } catch (error) { toast(error.message || "下载失败"); }
  });
  $("#artifactFixError").addEventListener("click", () => {
    const group = selectedArtifactGroup();
    const detail = $("#artifactErrorMessage").textContent;
    closeArtifact();
    $("#messageInput").value = `请修复 Artifact「${group?.name || "当前页面"}」的运行错误：${detail}`;
    $("#messageInput").dispatchEvent(new Event("input"));
    $("#messageInput").focus();
  });
  window.addEventListener("message", (event) => {
    if (event.source !== $("#artifactFrame").contentWindow) return;
    if (event.data?.type === "witt-artifact-ready") {
      $("#artifactLoading").hidden = true;
      $("#artifactRuntimeError").hidden = true;
    } else if (event.data?.type === "witt-artifact-error") {
      $("#artifactLoading").hidden = true;
      $("#artifactErrorMessage").textContent = `${event.data.message || "页面脚本发生错误"}${event.data.line ? `（第 ${event.data.line} 行）` : ""}`;
      $("#artifactRuntimeError").hidden = false;
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (state.artifactOpen) {
        closeArtifact();
        return;
      }
      const historyControls = document.querySelector(".history-controls");
      if (historyControls?.classList.contains("open")) {
        event.preventDefault();
        historyControls.classList.remove("open");
        const toggleBtn = $("#historySearchToggle");
        if (toggleBtn) {
          toggleBtn.setAttribute("aria-expanded", "false");
          toggleBtn.focus();
        }
        return;
      }
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      const isModalOpen = document.querySelector(".workspace-overview.open, #settingsSheet.open");
      if (!isModalOpen) {
        event.preventDefault();
        closeDrawer();
        beginNewConversation();
      }
    }
  });
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
  const shortcutHint = $("#newChatShortcutHint");
  if (shortcutHint) shortcutHint.textContent = isMac ? "⌘ K" : "Ctrl K";

  const historySearchToggle = $("#historySearchToggle");
  const historyControls = document.querySelector(".history-controls");
  const historySearchInput = $("#historySearch");
  if (historySearchInput) {
    historySearchInput.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        historyControls?.classList.remove("open");
        historySearchToggle?.setAttribute("aria-expanded", "false");
        historySearchToggle?.focus();
      }
    });
  }
  if (historySearchToggle && historyControls) {
    historySearchToggle.setAttribute("aria-expanded", historyControls.classList.contains("open") ? "true" : "false");
    historySearchToggle.addEventListener("click", () => {
      const willOpen = !historyControls.classList.contains("open");
      historyControls.classList.toggle("open", willOpen);
      historySearchToggle.setAttribute("aria-expanded", willOpen ? "true" : "false");
      if (willOpen && historySearchInput) {
        historySearchInput.focus();
        historySearchInput.select();
      }
    });
  }
  $("#drawerNewChat").addEventListener("click", () => {
    closeDrawer();
    beginNewConversation();
  });
  $("#attachButton").addEventListener("click", () => {
    setAttachmentMenu(!$("#attachmentMenu").classList.contains("open"));
  });
  $("#attachPhotoButton").addEventListener("click", () => {
    setAttachmentMenu(false);
    bridge()?.pickFiles?.();
  });
  $("#attachFileButton").addEventListener("click", () => {
    setAttachmentMenu(false);
    bridge()?.pickFiles?.();
  });
  $("#activateInviteButton").addEventListener("click", () => {
    const code = $("#inviteCode").value.trim();
    if (!code) { $("#authGateHint").textContent = "请先输入邀请码。"; return; }
    const button = $("#activateInviteButton");
    button.disabled = true;
    button.querySelector("span").textContent = "正在验证";
    $("#authGateHint").textContent = "正在为这台设备创建独立访问凭据…";
    bridge()?.activateInvite?.(code);
  });
  $("#inviteCode").addEventListener("keydown", (event) => {
    if (event.key === "Enter") $("#activateInviteButton").click();
  });
  $("#sendButton").addEventListener("click", () => {
    if (!state.busy || hasComposerContent()) {
      sendMessage();
      return;
    }
    if (!state.activeId || state.pausing) return;
    if (typeof bridge()?.interruptConversation !== "function") {
      toast("暂停功能需要更新到最新版 App");
      bridge()?.checkForUpdates?.();
      return;
    }
    state.pausing = true;
    setBusy(true);
    bridge().interruptConversation(state.activeId);
  });
  $("#messageInput").addEventListener("input", (event) => {
    event.target.style.height = "auto";
    event.target.style.height = `${Math.min(128, event.target.scrollHeight)}px`;
    refreshActionButton();
    clearTimeout(draftSaveTimer);
    draftSaveTimer = setTimeout(saveDraft, 250);
  });
  $("#messageInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      sendMessage();
    }
  });
  $("#attachmentStrip").addEventListener("click", (event) => {
    const id = event.target.closest("[data-remove-file]")?.dataset.removeFile;
    if (!id) return;
    state.attachments.delete(id);
    renderAttachments();
  });
  $("#approvalDock").addEventListener("click", (event) => {
    const form = event.target.closest("[data-approval-input-form]");
    if (!form) return;
    const current = Number(form.dataset.approvalPage || 0);
    if (event.target.closest("[data-approval-back]")) {
      setApprovalPage(form, current - 1);
      return;
    }
    if (event.target.closest("[data-approval-next]")) {
      const slide = form.querySelector(`[data-approval-slide="${current}"]`);
      if (!approvalQuestionComplete(slide)) {
        toast("请先完成当前问题");
        slide?.classList.add("needs-answer");
        setTimeout(() => slide?.classList.remove("needs-answer"), 360);
        return;
      }
      setApprovalPage(form, current + 1);
    }
  });
  let approvalScrollFrame = 0;
  $("#approvalDock").addEventListener("scroll", (event) => {
    const carousel = event.target.closest?.("[data-approval-carousel]");
    if (!carousel) return;
    cancelAnimationFrame(approvalScrollFrame);
    approvalScrollFrame = requestAnimationFrame(() => {
      const form = carousel.closest("[data-approval-input-form]");
      const index = carousel.clientWidth
        ? Math.round(carousel.scrollLeft / carousel.clientWidth) : 0;
      updateApprovalPageState(form, index);
    });
  }, true);
  $("#messageList").addEventListener("click", (event) => {
    const codeCopy = event.target.closest("[data-copy-code]");
    if (codeCopy) {
      const code = codeCopy.closest(".chat-code-block")?.querySelector("code")?.textContent || "";
      if (!code) return;
      navigator.clipboard.writeText(code).then(() => {
        codeCopy.textContent = "已复制";
        codeCopy.classList.add("copied");
        setTimeout(() => {
          codeCopy.textContent = "复制";
          codeCopy.classList.remove("copied");
        }, 1500);
      }).catch(() => toast("暂时无法复制代码"));
      return;
    }
    const messageToggle = event.target.closest(".user-message-toggle");
    if (messageToggle) {
      const article = messageToggle.closest(".message.user");
      if (!article) return;
      if (state.expandedMessages.has(article.dataset.message)) {
        state.expandedMessages.delete(article.dataset.message);
      } else {
        state.expandedMessages.add(article.dataset.message);
      }
      article.classList.toggle("expanded", state.expandedMessages.has(article.dataset.message));
      messageToggle.textContent = article.classList.contains("expanded") ? "收起" : "展开全文";
      messageToggle.setAttribute("aria-expanded", String(article.classList.contains("expanded")));
      return;
    }
    const approvalButton = event.target.closest("[data-approval-choice]");
    if (approvalButton) {
      respondToApproval(
        approvalButton.dataset.approvalId,
        approvalButton.dataset.approvalChoice,
      );
      return;
    }
    const approvalPayload = event.target.closest("[data-approval-payload]");
    if (approvalPayload) {
      respondToApproval(approvalPayload.dataset.approvalId, JSON.stringify({
        action: approvalPayload.dataset.approvalPayload,
        content: null,
      }));
      return;
    }
    const image = event.target.closest("[data-inline-image]");
    if (image) {
      openImageViewer(image.dataset.inlineImage, image.dataset.imageName, image.dataset.imageMime);
      return;
    }
    const action = event.target.closest("[data-stream-detail]");
    if (!action) return;
    openActionDetail(action.dataset.messageId, action.dataset.streamDetail,
      action.querySelector("p")?.textContent || "执行详情");
  });
  document.addEventListener("submit", (event) => {
    const inputForm = event.target.closest("[data-approval-input-form]");
    const mcpForm = event.target.closest("[data-approval-mcp-form]");
    const decisionForm = event.target.closest("[data-approval-decision-form]");
    if (!inputForm && !mcpForm && !decisionForm) return;
    event.preventDefault();
    if (decisionForm) {
      const checked = decisionForm.querySelector('input[name="approval-decision"]:checked');
      if (!checked) { toast("请选择一项后继续"); return; }
      respondToApproval(decisionForm.dataset.approvalId, checked.value);
      return;
    }
    if (inputForm) {
      const answers = {};
      let valid = true;
      let invalidIndex = -1;
      inputForm.querySelectorAll(".approval-question").forEach((field, index) => {
        const checked = field.querySelector('input[type="radio"]:checked');
        const textInput = field.querySelector(".approval-text-input");
        let value = checked?.value || textInput?.value.trim() || "";
        if (value === "__other__") value = field.querySelector(".approval-other-input")?.value.trim() || "";
        if (!value) {
          valid = false;
          if (invalidIndex < 0) invalidIndex = index;
        }
        answers[field.dataset.questionId] = { answers: value ? [value] : [] };
      });
      if (!valid) {
        toast("请完成所有问题");
        setApprovalPage(inputForm, invalidIndex);
        return;
      }
      respondToApproval(inputForm.dataset.approvalId, JSON.stringify({ answers }));
      return;
    }
    const content = {};
    mcpForm.querySelectorAll(".approval-schema-field").forEach((field) => {
      const input = field.querySelector("input, select, textarea");
      if (!input) return;
      const type = field.dataset.valueType;
      if (type === "boolean") content[field.dataset.fieldKey] = Boolean(input.checked);
      else if (["number", "integer"].includes(type)) {
        if (input.value !== "") content[field.dataset.fieldKey] = Number(input.value);
      } else if (input.value !== "") content[field.dataset.fieldKey] = input.value;
    });
    respondToApproval(mcpForm.dataset.approvalId, JSON.stringify({ action: "accept", content }));
  });
  document.addEventListener("change", (event) => {
    const radio = event.target.closest('.approval-choice-grid input[type="radio"]');
    if (!radio) return;
    const question = radio.closest(".approval-question");
    const otherWrap = question?.querySelector(".approval-other-wrap");
    if (!otherWrap) return;
    const isOther = radio.value === "__other__";
    otherWrap.hidden = !isOther;
    if (isOther) question.querySelector(".approval-other-input")?.focus();
  });
  $("#conversationList").addEventListener("click", (event) => {
    const openId = event.target.closest("[data-open]")?.dataset.open;
    const archiveId = event.target.closest("[data-archive]")?.dataset.archive;
    if (openId) selectConversation(openId);
    if (archiveId) openArchiveDialog(archiveId);
  });
  $("#cancelArchive").addEventListener("click", closeArchiveDialog);
  $(".dialog-backdrop").addEventListener("click", closeArchiveDialog);
  $("#confirmArchive").addEventListener("click", () => {
    if (state.archiveId) bridge()?.archiveConversation?.(state.archiveId);
  });
  $("#updateButton").addEventListener("click", () => bridge()?.checkForUpdates?.());
  $("#projectButton").addEventListener("click", () => {
    setAttachmentMenu(false);
    openProject();
  });
  $("#closeProject").addEventListener("click", closeProject);
  $("#projectBackdrop").addEventListener("click", closeProject);
  $(".project-options").addEventListener("click", (event) => {
    const button = event.target.closest("[data-project-path]");
    if (!button || !state.activeId) return;
    const workDir = button.dataset.projectPath || "";
    if (workDir === state.workDir) {
      closeProject();
      return;
    }
    document.querySelectorAll("[data-project-path]").forEach((item) =>
      item.classList.toggle("selected", item === button));
    if (typeof bridge()?.updateConversationProject !== "function") {
      toast("项目切换需要更新到最新版 App");
      bridge()?.checkForUpdates?.();
      return;
    }
    bridge().updateConversationProject(state.activeId, workDir);
  });
  $("#modelButton").addEventListener("click", () => {
    if (state.busy) { toast("当前任务完成后再切换模型"); return; }
    state.draftModel = state.model;
    state.draftReasoning = state.reasoning;
    state.draftAccessMode = state.accessMode;
    updateModelControls();
    setQuickModelMenu(!$("#quickModelMenu").classList.contains("open"));
  });
  $("#quickModelExpand").addEventListener("click", () => {
    if (Boolean(activeRemoteWorkspace(state.active))) return;
    const menu = $("#quickModelMenu");
    const open = !menu.classList.contains("models-open");
    menu.classList.toggle("models-open", open);
    $("#quickModelExpand").setAttribute("aria-expanded", String(open));
  });
  $("#quickModelOptions").addEventListener("click", (event) => {
    if (Boolean(activeRemoteWorkspace(state.active))) return;
    const model = event.target.closest("[data-quick-model]")?.dataset.quickModel;
    if (!model) return;
    state.draftModel = model;
    state.harness = "auto";
    const offered = availableReasoningEfforts();
    if (!offered.includes(state.draftReasoning)) state.draftReasoning = offered.includes("medium") ? "medium" : offered[0];
    applySettings({ closeSheet: false });
    setQuickModelMenu(false);
  });
  $("#quickReasoningOptions").addEventListener("click", (event) => {
    if (Boolean(activeRemoteWorkspace(state.active))) return;
    const reasoning = event.target.closest("[data-quick-reasoning]")?.dataset.quickReasoning;
    if (!reasoning) return;
    state.draftReasoning = reasoning;
    applySettings({ closeSheet: false });
    setQuickModelMenu(false);
  });
  document.addEventListener("pointerdown", (event) => {
    if (!event.target.closest(".composer-wrap")) {
      setAttachmentMenu(false);
      setQuickModelMenu(false);
    }
    if (!event.target.closest(".compact-nav")) setChatMoreMenu(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      setAttachmentMenu(false);
      setQuickModelMenu(false);
      setChatMoreMenu(false);
    }
  });
  $("#closeSettings").addEventListener("click", closeSettings);
  $("#sheetBackdrop").addEventListener("click", closeSettings);
  $(".model-options").addEventListener("click", (event) => {
    if (Boolean(activeRemoteWorkspace(state.active))) return;
    const model = event.target.closest("[data-model]")?.dataset.model;
    if (!model) return;
    state.draftModel = model;
    state.harness = "auto";
    updateModelControls();
  });
  const selectReasoning = (event) => {
    if (Boolean(activeRemoteWorkspace(state.active))) return;
    const reasoning = event.target.closest("[data-reasoning]")?.dataset.reasoning;
    if (!reasoning) return;
    state.draftReasoning = reasoning;
    updateModelControls();
  };
  $("#reasoningStops").addEventListener("click", selectReasoning);
  $("#reasoningSegments").addEventListener("click", selectReasoning);
  $(".access-options").addEventListener("click", (event) => {
    if (Boolean(activeRemoteWorkspace(state.active))) return;
    const accessMode = event.target.closest("[data-access]")?.dataset.access;
    if (!accessMode) return;
    state.draftAccessMode = accessMode;
    updateModelControls();
  });
  $("#saveSettings").addEventListener("click", () => {
    if (Boolean(activeRemoteWorkspace(state.active))) return;
    applySettings();
  });
  document.addEventListener("click", (event) => {
    const harness = event.target.closest?.("[data-harness]");
    if (harness && !harness.disabled && !Boolean(activeRemoteWorkspace(state.active))) {
      state.harness = harness.dataset.harness;
      renderRuntimeControls();
    }
    const profile = event.target.closest?.("[data-runtime-profile]");
    if (profile && !profile.disabled && !Boolean(activeRemoteWorkspace(state.active))) {
      const selected = (state.runtimeProfiles || []).find((item) => item.id === profile.dataset.runtimeProfile);
      if (!selected) return;
      state.draftModel = selected.model;
      state.draftReasoning = selected.reasoning;
      state.harness = "auto";
      applySettings({ closeSheet: false });
      renderRuntimeControls();
      toast(`${runtimeProfileDisplayName(selected)} · 自动`);
    }
  });
  $("#forkConversationButton").addEventListener("click", () => {
    if (state.activeId) bridge()?.forkConversation?.(state.activeId);
  });
  $("#compactConversationButton").addEventListener("click", () => {
    if (state.activeId) bridge()?.compactConversation?.(state.activeId);
  });
  $("#reviewConversationButton").addEventListener("click", () => {
    if (state.activeId) bridge()?.reviewConversation?.(state.activeId);
  });

  updateModelControls();
  renderDeliveries();
  document.addEventListener("visibilitychange", () => setAppVisible(!document.hidden));
  // Native calls nativeReady with version and cache scope after the main frame is loaded.
})();
