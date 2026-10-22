(() => {
  "use strict";
  if (window.WittNative || window.DropVaultAndroid) return;

  document.body?.classList.add("web-browser");

  const API = "/vault-api/";
  const files = new Map();
  let events = null;

  const callback = (name, ...args) => {
    const fn = window.DropVault?.[name];
    if (typeof fn === "function") fn(...args);
  };
  const payload = (value) => JSON.stringify(value);
  const parse = (text) => {
    try { return text ? JSON.parse(text) : {}; }
    catch { return {}; }
  };
  const message = (text, fallback) => parse(text).error || fallback;
  const validId = (value) => /^[a-f0-9-]{36}$/.test(String(value || ""));
  const encode = (value) => encodeURIComponent(String(value || ""));
  const browserDeviceId = () => {
    let value = localStorage.getItem("witt_web_device_id");
    if (!validId(value)) {
      value = crypto.randomUUID();
      localStorage.setItem("witt_web_device_id", value);
    }
    return value;
  };

  async function request(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.json !== undefined) {
      headers.set("Content-Type", "application/json; charset=utf-8");
      options.body = JSON.stringify(options.json);
    }
    const response = await fetch(API + path, {
      ...options,
      headers,
      credentials: "same-origin",
      cache: "no-store",
    });
    const text = await response.text();
    if (!response.ok) throw new Error(message(text, `服务器请求失败（${response.status}）`));
    return text || "{}";
  }

  function run(path, options, success, failure, fallback) {
    request(path, options).then((text) => callback(success, text))
      .catch((error) => callback(failure, error.message || fallback));
  }

  function conversationAction(id, action, body, success) {
    if (!validId(id)) return;
    run(`chat/conversations/${id}/${action}`, { method: "POST", json: body || {} },
      success, "onAppServerActionError", "操作失败，请重试");
  }

  function download(path, name) {
    Promise.resolve().then(async () => {
      const response = await fetch(API + path, { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error("下载失败");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = name || "Witt-文件";
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }).catch((error) => callback("onChatError", error.message || "下载失败"));
  }

  const bridge = {
    getVersion: () => "3.0.0",
    getCacheScope() {
      let value = localStorage.getItem("witt_web_cache_scope");
      if (!/^[a-f0-9]{32}$/.test(value || "")) {
        value = [...crypto.getRandomValues(new Uint8Array(16))]
          .map((item) => item.toString(16).padStart(2, "0")).join("");
        localStorage.setItem("witt_web_cache_scope", value);
      }
      return value;
    },
    hasBundledLumoraMedia: () => false,
    contentReady: () => {},
    launchSurfaceReady: () => {},
    checkForUpdates: () => {},

    requestAuthStatus() {
      run("auth/status", {}, "onAuthStatus", "onAuthError", "无法连接服务器");
    },
    activateInvite(inviteCode) {
      request("auth/activate", {
        method: "POST",
        headers: { "X-Witt-Client": "browser" },
        json: {
          inviteCode: String(inviteCode || "").trim(),
          deviceId: browserDeviceId(),
          deviceName: `${navigator.platform || "浏览器"} · Web`,
        },
      }).then((text) => callback("onActivation", text))
        .catch((error) => callback("onActivationError", error.message || "邀请码激活失败"));
    },
    requestConversations() {
      run("chat/conversations", {}, "onConversations", "onChatError", "无法读取对话");
    },
    searchConversations(query, project, attachments, requestId) {
      const params = new URLSearchParams({ q: query || "" });
      if (project) params.set("project", project);
      if (String(attachments) === "true") params.set("attachments", "1");
      request(`chat/conversations?${params}`).then((text) => {
        const data = parse(text);
        data.requestId = requestId;
        callback("onHistorySearch", payload(data));
      }).catch((error) => callback("onHistorySearchError", error.message));
    },
    requestCapabilities() {
      run("chat/capabilities", {}, "onCapabilities", "onCapabilitiesError", "无法读取服务能力");
    },
    requestConversation(id) {
      if (validId(id)) run(`chat/conversations/${id}?limit=40`, {}, "onConversation", "onChatError", "无法读取对话");
    },
    requestConversationDelta(id) {
      if (validId(id)) run(`chat/conversations/${id}/sync`, {}, "onConversationDelta", "onChatError", "同步失败");
    },
    requestConversationPage(id, before, limit) {
      if (!validId(id)) return;
      run(`chat/conversations/${id}/messages?before=${encode(before)}&limit=${encode(limit || 40)}`,
        {}, "onConversationPage", "onConversationPageError", "历史消息加载失败");
    },
    subscribeConversationEvents(id) {
      if (!validId(id)) return;
      this.unsubscribeConversationEvents();
      events = new EventSource(`${API}chat/conversations/${id}/events?limit=40`);
      events.addEventListener("snapshot", (event) => callback("onConversation", event.data));
      events.addEventListener("delta", (event) => callback("onConversationDelta", event.data));
    },
    unsubscribeConversationEvents() {
      events?.close();
      events = null;
    },
    requestUsage(conversationId) {
      const suffix = validId(conversationId) ? `?conversationId=${conversationId}` : "";
      run(`chat/usage${suffix}`, {}, "onUsage", "onUsageError", "无法读取用量");
    },
    consumeRateLimitReset(conversationId) {
      const suffix = validId(conversationId) ? `?conversationId=${conversationId}` : "";
      run(`chat/usage/reset${suffix}`, { method: "POST" }, "onUsageReset", "onUsageResetError", "重置失败");
    },
    requestStreamDetail(conversationId, messageId, entryId) {
      run(`chat/conversations/${conversationId}/messages/${messageId}/stream/${encode(entryId)}`,
        {}, "onStreamDetail", "onStreamDetailError", "无法读取执行详情");
    },
    createConversation(model, reasoning, accessMode) {
      this.createConversationWithProfile(model, reasoning, accessMode, "", "default");
    },
    createConversationWithPath(model, reasoning, accessMode, workDir) {
      this.createConversationWithProfile(model, reasoning, accessMode, workDir, "default");
    },
    createConversationWithProfile(model, reasoning, accessMode, workDir, codexProfile) {
      run("chat/conversations", { method: "POST", json: {
        model, reasoning, accessMode, workDir: workDir || "", codexProfile: codexProfile || "default",
      } }, "onConversationCreated", "onChatError", "无法创建对话");
    },
    updateConversationSettings(id, model, reasoning, accessMode) {
      run(`chat/conversations/${id}`, { method: "PATCH", json: { model, reasoning, accessMode } },
        "onSettingsUpdated", "onChatError", "设置保存失败");
    },
    updateConversationProject(id, workDir) {
      run(`chat/conversations/${id}`, { method: "PATCH", json: { workDir: workDir || "" } },
        "onConversationProjectUpdated", "onConversationProjectError", "项目切换失败");
    },
    updateConversationMetadata(id, json) {
      run(`chat/conversations/${id}`, { method: "PATCH", json: parse(json) },
        "onConversationMetadataUpdated", "onConversationMetadataError", "同步失败");
    },
    sendChatMessage(id, text, attachmentIdsJson) {
      this.sendChatMessageWithRequestId(id, text, attachmentIdsJson, "");
    },
    sendChatMessageWithRequestId(id, text, attachmentIdsJson, clientRequestId) {
      request(`chat/conversations/${id}/messages`, { method: "POST", json: {
        text, attachmentIds: parse(attachmentIdsJson), ...(clientRequestId ? { clientRequestId } : {}),
      } }).then((responseText) => {
        const data = parse(responseText);
        if (clientRequestId) data.clientRequestId = clientRequestId;
        callback("onMessageSent", payload(data));
      }).catch((error) => callback("onMessageSendError", error.message, clientRequestId));
    },
    interruptConversation(id) {
      conversationAction(id, "interrupt", {}, "onConversationInterruptRequested");
    },
    archiveConversation(id) {
      request(`chat/conversations/${id}`, { method: "DELETE" })
        .then(() => callback("onConversationArchived", id))
        .catch((error) => callback("onChatError", error.message));
    },
    forkConversation(id) { conversationAction(id, "fork", {}, "onConversationForked"); },
    compactConversation(id) { conversationAction(id, "compact", {}, "onConversationCompacted"); },
    reviewConversation(id) { conversationAction(id, "review", { type: "uncommittedChanges" }, "onReviewStarted"); },
    resolveApproval(conversationId, approvalId, choiceId) {
      run(`chat/conversations/${conversationId}/approvals/${approvalId}`,
        { method: "POST", json: { choiceId } }, "onApprovalResolved", "onApprovalError", "权限确认失败");
    },
    requestWorkspaceOverview() {
      run("chat/workspace-overview", {}, "onWorkspaceOverview", "onWorkspaceOverviewError", "检查失败");
    },

    requestAdminDevices() { run("admin/devices", {}, "onAdminDevices", "onAdminError", "无法读取设备"); },
    createInvite(label, maxDevices) {
      run("admin/invites", { method: "POST", json: { label, maxDevices } },
        "onInviteCreated", "onAdminError", "无法创建邀请码");
    },
    disableDevice(id) {
      run(`admin/devices/${id}/disable`, { method: "POST", json: {} },
        "onDeviceDisabled", "onAdminError", "无法停用设备");
    },
    requestCodexAccounts() {
      run("codex/accounts", {}, "onCodexAccounts", "onAdminError", "无法读取账号");
    },
    startCodexLogin(profileId) {
      run(`codex/accounts/${encode(profileId)}/login/start`, { method: "POST", json: {} },
        "onCodexLoginStarted", "onAdminError", "无法开始登录");
    },
    requestCodexLoginStatus(profileId) {
      run(`codex/accounts/${encode(profileId)}/login/status`, {},
        "onCodexLoginStatus", "onAdminError", "无法读取登录状态");
    },
    cancelCodexLogin(profileId) {
      run(`codex/accounts/${encode(profileId)}/login/cancel`, { method: "POST", json: {} },
        "onCodexLoginCancelled", "onAdminError", "无法取消登录");
    },
    startXuanyuCodexLogin() {
      run("codex/accounts/xuanyu/login/start", { method: "POST", json: {} },
        "onCodexLoginStarted", "onAdminError", "无法开始登录");
    },
    requestXuanyuCodexLoginStatus() {
      run("codex/accounts/xuanyu/login/status", {}, "onCodexLoginStatus", "onAdminError", "无法读取登录状态");
    },
    cancelXuanyuCodexLogin() {
      run("codex/accounts/xuanyu/login/cancel", { method: "POST", json: {} },
        "onCodexLoginCancelled", "onAdminError", "无法取消登录");
    },

    pickFiles() {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.onchange = () => {
        const selected = [...input.files].filter((file) => file.size <= 500 * 1024 * 1024)
          .map((file) => {
            const id = crypto.randomUUID();
            files.set(id, file);
            return { id, name: file.name, size: file.size, type: file.type || "application/octet-stream" };
          });
        callback("onFilesPicked", payload(selected));
      };
      input.click();
    },
    uploadFile(id) {
      const file = files.get(id);
      if (!file) { callback("onUploadFinished", id, false, "文件授权已失效，请重新选择", ""); return; }
      const xhr = new XMLHttpRequest();
      xhr.open("POST", API + "files");
      xhr.withCredentials = true;
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
      xhr.setRequestHeader("X-File-Type", file.type || "application/octet-stream");
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) callback("onUploadProgress", id, Math.min(99, Math.round(event.loaded * 100 / event.total)));
      };
      xhr.onload = () => {
        const ok = xhr.status >= 200 && xhr.status < 300;
        if (ok) files.delete(id);
        callback("onUploadFinished", id, ok, ok ? "" : message(xhr.responseText, "上传失败"), ok ? xhr.responseText : "");
      };
      xhr.onerror = () => callback("onUploadFinished", id, false, "网络异常，请重试", "");
      xhr.send(file);
    },
    downloadArtifact(conversationId, messageId, artifactId, name) {
      download(`chat/conversations/${conversationId}/messages/${messageId}/artifacts/${artifactId}`, name);
    },
    downloadImage(url, name) {
      const resolved = new URL(String(url), location.origin);
      const prefix = `${location.origin}${API}`;
      if (!resolved.href.startsWith(prefix)) return;
      download(resolved.href.slice(prefix.length), name);
    },
  };

  window.DropVaultAndroid = bridge;
  const ready = () => {
    if (!window.DropVault?.nativeReady) { setTimeout(ready, 10); return; }
    document.getElementById("localSshButton")?.setAttribute("hidden", "");
    const drawerTitle = document.querySelector(".drawer-head h2");
    if (drawerTitle) drawerTitle.textContent = "Witt";
    const input = document.getElementById("messageInput");
    if (input) input.placeholder = "向 Witt 发送消息";
    window.DropVault.nativeReady({
      version: "3.0.0",
      cacheScope: bridge.getCacheScope(),
      workspaceFeatures: true,
      supportsSse: true,
      browser: true,
    });
  };
  ready();
})();
