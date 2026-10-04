(() => {
  "use strict";

  const root = document.getElementById("customerDevices");
  if (!root) return;

  const sheet = document.getElementById("customerDevicesSheet");
  const list = root.querySelector("[data-customer-list]");
  const status = root.querySelector("[data-customer-status]");
  const detail = root.querySelector("[data-customer-detail]") || (() => {
    const node = document.createElement("div");
    node.className = "customer-device-detail";
    node.dataset.customerDetail = "";
    node.hidden = true;
    root.append(node);
    return node;
  })();
  const legacyMode = !sheet || !root.querySelector(".customer-devices-toolbar");
  const state = {
    devices: [], capabilities: {}, roots: [], selectedId: "", selected: null,
    currentRoot: "", currentPath: "", systemInfo: null, fileEntries: null,
    fileContent: null, screenshot: null, busy: "", error: "", lastFocus: null,
  };

  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  function query(selector, parent = root) { return parent?.querySelector(selector) || null; }
  function setStatus(message, kind = "") {
    if (!status) return;
    status.textContent = message;
    status.dataset.state = kind;
  }
  function localDate(value) {
    if (!value) return "暂无记录";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
  }
  function normalizeKey(value) { return String(value || "").replace(/[-_\s]/g, "").toLowerCase(); }
  function deviceId(device) { return device?.device_id || device?.deviceId || ""; }
  function isOnline(device) { return String(device?.status || "").toLowerCase() === "online" || device?.online === true; }
  function capabilitySource(device) {
    const id = deviceId(device);
    return device?.capabilities || state.capabilities?.[id] || state.capabilities || {};
  }
  function hasCapability(device, kind) {
    const raw = capabilitySource(device);
    if (raw === true) return true;
    const aliases = {
      system: ["system", "system-info", "system_info", "systemInfo", "sysinfo", "system.info"],
      filesList: ["files", "files-list", "files_list", "file-list", "file_list", "list", "filesystem.list"],
      filesRead: ["files-read", "files_read", "file-read", "file_read", "read", "filesystem.read"],
      screenshot: ["screenshot", "screen-shot", "screen_capture", "screenCapture", "screen.capture"],
    }[kind] || [kind];
    const wanted = new Set(aliases.map(normalizeKey));
    const inspect = (value, key = "") => {
      if (value === true && (!key || wanted.has(normalizeKey(key)))) return true;
      if (Array.isArray(value)) return value.some((entry) => typeof entry === "string" ? wanted.has(normalizeKey(entry)) : inspect(entry));
      if (!value || typeof value !== "object") return false;
      for (const [name, entry] of Object.entries(value)) {
        const normalized = normalizeKey(name);
        if (wanted.has(normalized) && (entry === true || entry === "available" || entry === "ready")) return true;
        if (kind === "filesList" && normalized === "files" && inspect(entry, "list")) return true;
        if (kind === "filesRead" && normalized === "files" && inspect(entry, "read")) return true;
        if (inspect(entry, name)) return true;
      }
      return false;
    };
    return inspect(raw);
  }
  function rootsFor(device = state.selected) {
    const deviceRootMap = state.roots && !Array.isArray(state.roots) && deviceId(device)
      ? state.roots[deviceId(device)] : undefined;
    const source = device?.allowed_roots ?? device?.roots ?? deviceRootMap ?? state.roots;
    if (Array.isArray(source)) return source.map((entry) => {
      if (typeof entry === "string") return { id: entry, label: entry };
      const id = entry?.id || entry?.root || entry?.path || entry?.name || "";
      return { id: String(id), label: String(entry?.label || entry?.name || id) };
    }).filter((entry) => entry.id);
    if (source && typeof source === "object") return Object.entries(source).map(([id, value]) => ({ id, label: typeof value === "string" ? value : value?.label || value?.name || id }));
    return [];
  }
  function endpoint(id, action) { return `customer-devices/${encodeURIComponent(id)}/${action}`; }
  async function call(path, options = {}) {
    const response = await fetch(`/vault-api/${path}`, {
      credentials: "same-origin", cache: "no-store", ...options,
      headers: { Accept: "application/json", ...(options.headers || {}), ...(options.method === "POST" ? { "Content-Type": "application/json" } : {}) },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.error || (response.status === 403 ? "没有权限查看客户电脑" : "请求失败"));
      error.status = response.status;
      throw error;
    }
    return body;
  }
  function resultText(result) {
    if (result == null) return "";
    if (typeof result === "string") return result;
    if (typeof result.stdout === "string") return result.stdout;
    if (typeof result.text === "string") return result.text;
    if (typeof result.data === "string" && !result.mime && !result.mimeType) return result.data;
    return "";
  }
  function resultError(result) {
    if (!result || typeof result !== "object") return "";
    if (Number(result.exit_code) && (result.error || result.stderr)) return result.error || result.stderr;
    if (result.ok === false || result.error) return result.error || result.stderr || "设备操作失败";
    return "";
  }
  function safeRelativePath(value) {
    const raw = String(value || "").replace(/\\/g, "/").trim();
    const parts = [];
    for (const part of raw.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") { if (parts.length) parts.pop(); continue; }
      parts.push(part);
    }
    return parts.join("/");
  }
  function joinRelative(base, name) { return safeRelativePath([base, name].filter(Boolean).join("/")); }
  function parseJsonOutput(text) {
    const value = String(text || "").trim();
    if (!value) return null;
    try { return JSON.parse(value); } catch { return null; }
  }
  function parseEntries(text) {
    const parsed = parseJsonOutput(text);
    let source = parsed?.entries || parsed?.items || parsed?.files || parsed;
    if (source && !Array.isArray(source) && typeof source === "object") source = Object.entries(source).map(([name, value]) => ({ name, ...(value && typeof value === "object" ? value : { type: value }) }));
    if (Array.isArray(source)) return source.map((entry) => {
      const name = String(entry?.name || entry?.filename || entry?.path || "未命名");
      const type = String(entry?.type || entry?.kind || "").toLowerCase();
      const directory = Boolean(entry?.isDirectory || entry?.directory || entry?.dir || ["dir", "directory", "folder"].includes(type));
      return { name: name.split(/[\\/]/).pop() || name, path: safeRelativePath(entry?.path || joinRelative(state.currentPath, name)), directory, size: entry?.size == null ? "" : String(entry.size) };
    });
    if (!String(text || "").trim()) return [];
    return String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => ({ name: line.split(/[\\/]/).pop() || line, path: safeRelativePath(line), directory: line.endsWith("/") || line.endsWith("\\"), size: "" }));
  }
  function capabilityReason(device, kind) {
    if (!isOnline(device)) return "设备离线，重新连接后可用";
    if (!hasCapability(device, kind)) return "此 Agent 版本或授权暂不支持";
    if (state.busy) return "正在等待设备响应";
    return "";
  }
  function operationButton(device, kind, action, title, description) {
    const reason = capabilityReason(device, kind);
    const disabled = Boolean(reason);
    const icon = action === "system-info" ? "i" : action === "screenshot" ? "▣" : "⌕";
    return `<button type="button" class="customer-operation" data-device-action="${escape(action)}" ${disabled ? "disabled" : ""} aria-describedby="customerCapabilityHint"><span class="customer-operation-icon" aria-hidden="true">${icon}</span><span><strong>${escape(title)}</strong><small>${escape(disabled ? reason : description)}</small></span><i aria-hidden="true">›</i></button>`;
  }
  function renderList() {
    if (!list) return;
    if (!state.devices.length) {
      list.innerHTML = `<div class="customer-empty"><span class="customer-empty-icon" aria-hidden="true">⌁</span><strong>还没有客户电脑</strong><p>先在设备授权页添加 Agent，电脑上线后会出现在这里。</p></div>`;
      return;
    }
    list.innerHTML = state.devices.map((device) => {
      const id = deviceId(device); const online = isOnline(device); const selected = id === state.selectedId;
      const hostname = device.hostname || "主机名未知"; const agent = device.agent_version || device.agentVersion || "Agent 版本未知";
      const oldHostnameAction = legacyMode ? `<button type="button" class="customer-legacy-action" data-hostname="${escape(id)}" ${online ? "" : "disabled"}>读取 hostname</button><output aria-live="polite"></output>` : "";
      return `<article class="customer-device ${online ? "is-online" : "is-offline"} ${selected ? "is-selected" : ""}" data-device-id="${escape(id)}"><button type="button" class="customer-device-select" data-select-customer-device="${escape(id)}" aria-pressed="${selected}"><span class="customer-device-state"><i aria-hidden="true"></i>${online ? "在线" : "离线"}</span><strong>${escape(device.label || device.customer_name || id || "未命名电脑")}</strong><small><span>主机：${escape(hostname)}</span><span>Agent：${escape(agent)}</span><span>最近连接：${escape(localDate(device.last_seen || device.lastSeen))}</span></small><em>${selected ? "已选择" : "查看操作"}<b aria-hidden="true">›</b></em></button>${oldHostnameAction}</article>`;
    }).join("");
  }
  function renderSystemOutput() {
    const output = query("[data-system-output]", detail); if (!output) return;
    const value = state.systemInfo; output.hidden = !value; if (!value) return;
    output.dataset.state = value.error ? "error" : value.truncated ? "truncated" : "ready";
    output.innerHTML = value.error ? `<p class="customer-inline-error">${escape(value.error)}</p>` : `<pre>${escape(value.text)}</pre>${value.truncated ? `<small class="customer-truncated">内容较长，已截断显示</small>` : ""}`;
  }
  function renderFileOutput() {
    const browser = query("[data-file-browser]", detail); if (!browser) return;
    const entries = state.fileEntries; const entryList = browser.querySelector("[data-file-entries]"); const content = browser.querySelector("[data-file-content]"); const pathInput = browser.querySelector("[data-file-path-input]");
    if (pathInput && pathInput.value !== state.currentPath) pathInput.value = state.currentPath;
    if (entryList) {
      if (entries?.error) entryList.innerHTML = `<p class="customer-inline-error">${escape(entries.error)}</p>`;
      else if (!entries) entryList.innerHTML = `<p class="customer-muted">选择根目录后读取文件。</p>`;
      else if (!entries.items.length) entryList.innerHTML = `<p class="customer-muted">这个目录为空。</p>`;
      else entryList.innerHTML = entries.items.map((entry) => { const icon = entry.directory ? "▱" : "□"; const attr = entry.directory ? `data-device-dir="${escape(entry.path)}"` : `data-device-file="${escape(entry.path)}"`; return `<button type="button" class="customer-file-entry" ${attr}><span aria-hidden="true">${icon}</span><span><strong>${escape(entry.name)}</strong><small>${entry.directory ? "文件夹" : (entry.size ? escape(entry.size) : "文本文件 · 点击读取")}</small></span><b aria-hidden="true">›</b></button>`; }).join("");
    }
    if (content) {
      content.hidden = !state.fileContent;
      if (state.fileContent) content.innerHTML = state.fileContent.error ? `<p class="customer-inline-error">${escape(state.fileContent.error)}</p>` : `<header><strong>${escape(state.fileContent.path)}</strong><button type="button" data-close-file>关闭</button></header><pre>${escape(state.fileContent.text)}</pre>${state.fileContent.truncated ? `<small class="customer-truncated">内容较长，已截断显示</small>` : ""}`;
    }
  }
  function renderScreenshot() {
    const output = query("[data-screenshot-output]", detail); if (!output) return;
    const screenshot = state.screenshot; output.hidden = !screenshot; if (!screenshot) return;
    output.dataset.state = screenshot.error ? "error" : "ready";
    output.innerHTML = screenshot.error ? `<p class="customer-inline-error">${escape(screenshot.error)}</p>` : `<img src="${escape(screenshot.src)}" alt="${escape(state.selected?.label || "客户电脑")}屏幕截图"><small>${escape(screenshot.checkedAt ? `截图时间：${localDate(screenshot.checkedAt)}` : "已获取最新截图")}</small>`;
  }
  function renderDetail() {
    const device = state.selected; if (!detail) return;
    if (!device) { detail.hidden = true; detail.innerHTML = ""; return; }
    detail.hidden = false; const id = deviceId(device); const online = isOnline(device); const roots = rootsFor(device);
    if (!state.currentRoot && roots[0]) state.currentRoot = roots[0].id;
    detail.innerHTML = `<div class="customer-detail-head"><div><span class="customer-detail-kicker">已选择电脑</span><h3>${escape(device.label || device.customer_name || id)}</h3><p>${escape(device.hostname || "主机名未知")} · ${escape(device.agent_version || device.agentVersion || "Agent 版本未知")}</p></div><span class="customer-detail-status ${online ? "online" : "offline"}"><i aria-hidden="true"></i>${online ? "在线" : "离线"}</span></div><p class="customer-capability-hint" id="customerCapabilityHint">${online ? "只显示这台 Agent 已获授权的只读能力。" : "设备离线时无法发起操作；上线后会自动恢复可用。"}</p><div class="customer-operation-grid" aria-label="客户电脑操作">${operationButton(device, "system", "system-info", "系统信息", "查看操作系统、版本和运行状态")}${operationButton(device, "filesList", "files", "浏览文件", "读取授权根目录中的文件列表")}${operationButton(device, "screenshot", "screenshot", "查看屏幕", "获取一张当前屏幕截图")}</div><section class="customer-result-block" data-system-block><header><div><h4>系统信息</h4><small>只读检查 · 不执行命令</small></div><span data-system-state>${state.busy === "system-info" ? "读取中…" : ""}</span></header><div data-system-output hidden></div></section><section class="customer-result-block customer-file-block" data-file-browser><header><div><h4>文件浏览</h4><small>只读 · 文本文件可查看内容</small></div><span data-file-state>${state.busy === "files" ? "读取中…" : ""}</span></header><div class="customer-file-controls"><label><span>根目录</span><select data-file-root ${roots.length ? "" : "disabled"}>${roots.length ? roots.map((entry) => `<option value="${escape(entry.id)}" ${entry.id === state.currentRoot ? "selected" : ""}>${escape(entry.label)}</option>`).join("") : "<option>Agent 未提供根目录</option>"}</select></label><form data-file-path-form><label><span>相对路径</span><input data-file-path-input value="${escape(state.currentPath)}" placeholder="留空表示根目录" autocomplete="off" spellcheck="false"><button type="submit" ${roots.length && online && hasCapability(device, "filesList") ? "" : "disabled"}>读取目录</button></label></form></div><div class="customer-file-entries" data-file-entries></div><div class="customer-file-content" data-file-content hidden></div></section><section class="customer-result-block customer-screenshot-block"><header><div><h4>屏幕截图</h4><small>不会保存到服务器</small></div><button type="button" class="customer-inline-button" data-device-action="screenshot" ${capabilityReason(device, "screenshot") ? "disabled" : ""}>刷新截图</button></header><div data-screenshot-output hidden></div></section>`;
    renderSystemOutput(); renderFileOutput(); renderScreenshot();
  }
  function selectDevice(id) {
    state.selectedId = id; state.selected = state.devices.find((device) => deviceId(device) === id) || null; state.currentRoot = rootsFor(state.selected)[0]?.id || ""; state.currentPath = ""; state.systemInfo = null; state.fileEntries = null; state.fileContent = null; state.screenshot = null; state.error = ""; renderList(); renderDetail(); detail?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  function setBusy(action) {
    state.busy = action; root.classList.toggle("is-busy", Boolean(action));
    root.querySelectorAll("button[data-device-action], [data-file-path-form] button, [data-refresh-devices]").forEach((button) => { if (action) button.dataset.wasDisabled = button.disabled ? "1" : "0"; button.disabled = Boolean(action) || button.dataset.wasDisabled === "1"; });
  }
  async function refresh() {
    setStatus("正在读取客户电脑…", "loading"); root.setAttribute("aria-busy", "true");
    try {
      const payload = await call("customer-devices"); state.devices = Array.isArray(payload.devices) ? payload.devices : []; state.capabilities = payload.capabilities || {}; state.roots = payload.roots || [];
      if (!state.devices.some((device) => deviceId(device) === state.selectedId)) { state.selectedId = ""; state.selected = null; } else state.selected = state.devices.find((device) => deviceId(device) === state.selectedId) || null;
      renderList(); renderDetail(); setStatus(`共 ${state.devices.length} 台 · ${state.devices.filter(isOnline).length} 台在线`, "ready");
    } catch (error) { state.error = error.message; setStatus(error.message, "error"); if (!state.devices.length) renderList(); }
    finally { root.setAttribute("aria-busy", "false"); }
  }
  async function runSystemInfo() {
    const device = state.selected; if (!device || capabilityReason(device, "system")) return;
    setBusy("system-info"); state.systemInfo = null; renderSystemOutput();
    try {
      const payload = await call(endpoint(deviceId(device), "system-info"), { method: "POST", body: "{}" }); const result = payload.result || payload; const error = resultError(result); let text = resultText(result); const json = parseJsonOutput(text); if (json) text = JSON.stringify(json, null, 2); const truncated = Boolean(result?.truncated || result?.is_truncated) || text.length > 12000; state.systemInfo = { error, text: truncated ? text.slice(0, 12000) : text, truncated };
    } catch (error) { state.systemInfo = { error: error.message }; }
    finally { setBusy(""); renderSystemOutput(); }
  }
  async function listFiles() {
    const device = state.selected; if (!device || !isOnline(device) || !hasCapability(device, "filesList") || !state.currentRoot) return;
    setBusy("files"); state.fileEntries = null; state.fileContent = null; state.currentPath = safeRelativePath(state.currentPath); renderFileOutput();
    try { const payload = await call(endpoint(deviceId(device), "files/list"), { method: "POST", body: JSON.stringify({ root: state.currentRoot, path: state.currentPath }) }); const result = payload.result || payload; const error = resultError(result); const text = resultText(result); state.fileEntries = { error, items: error ? [] : parseEntries(text), truncated: Boolean(result?.truncated || result?.is_truncated) }; }
    catch (error) { state.fileEntries = { error: error.message, items: [] }; }
    finally { setBusy(""); renderFileOutput(); }
  }
  async function readFile(path) {
    const device = state.selected; if (!device || !isOnline(device) || !hasCapability(device, "filesRead")) return;
    setBusy("files"); state.fileContent = null; renderFileOutput();
    try { const safePath = safeRelativePath(path); const payload = await call(endpoint(deviceId(device), "files/read"), { method: "POST", body: JSON.stringify({ root: state.currentRoot, path: safePath }) }); const result = payload.result || payload; const error = resultError(result); let text = resultText(result); const truncated = Boolean(result?.truncated || result?.is_truncated) || text.length > 16000; state.fileContent = { error, path: safePath, text: truncated ? text.slice(0, 16000) : text, truncated }; }
    catch (error) { state.fileContent = { error: error.message, path }; }
    finally { setBusy(""); renderFileOutput(); }
  }
  function attachmentSource(result) {
    const attachment = result?.attachment && typeof result.attachment === "object" ? result.attachment : result; const mime = attachment?.mime || attachment?.mimeType || result?.mime || result?.mimeType || "image/png"; const data = attachment?.data || result?.data;
    if (typeof data !== "string" || !/^image\//i.test(mime)) return ""; if (data.startsWith("data:image/")) return data; return `data:${mime};base64,${data}`;
  }
  async function takeScreenshot() {
    const device = state.selected; if (!device || capabilityReason(device, "screenshot")) return;
    setBusy("screenshot"); state.screenshot = null; renderScreenshot();
    try { const payload = await call(endpoint(deviceId(device), "screenshot"), { method: "POST", body: "{}" }); const result = payload.result || payload; const error = resultError(result); const src = attachmentSource(result); state.screenshot = { error: error || (!src ? "设备没有返回可显示的截图" : ""), src, checkedAt: new Date().toISOString() }; }
    catch (error) { state.screenshot = { error: error.message }; }
    finally { setBusy(""); renderScreenshot(); }
  }
  function openSheet() {
    if (!sheet) return; state.lastFocus = document.activeElement; document.getElementById("drawer")?.classList.remove("open"); document.getElementById("drawer")?.setAttribute("aria-hidden", "true"); sheet.classList.add("open"); sheet.setAttribute("aria-hidden", "false"); refresh(); requestAnimationFrame(() => document.getElementById("closeCustomerDevices")?.focus());
  }
  function closeSheet() {
    if (!sheet) return; sheet.classList.remove("open"); sheet.setAttribute("aria-hidden", "true"); const target = state.lastFocus; state.lastFocus = null; if (target && typeof target.focus === "function") requestAnimationFrame(() => target.focus());
  }
  function handleLegacyHostname(button) {
    const id = button.dataset.hostname; const output = button.closest(".customer-device")?.querySelector("output"); if (!id || !output) return; button.disabled = true; output.textContent = "正在等待设备…";
    call(endpoint(id, "hostname"), { method: "POST", body: "{}" }).then(({ result }) => { output.textContent = result?.exit_code === 0 ? String(result.stdout || "").trim() : (result?.error || result?.stderr || "执行失败"); }).catch((error) => { output.textContent = error.message; }).finally(() => { button.disabled = false; });
  }

  root.querySelector("[data-refresh-devices]")?.addEventListener("click", refresh);
  list?.addEventListener("click", (event) => { const legacy = event.target.closest("[data-hostname]"); if (legacy) { handleLegacyHostname(legacy); return; } const selected = event.target.closest("[data-select-customer-device]"); if (selected) selectDevice(selected.dataset.selectCustomerDevice); });
  detail.addEventListener("click", (event) => { const action = event.target.closest("[data-device-action]")?.dataset.deviceAction; if (action === "system-info") { runSystemInfo(); return; } if (action === "files") { listFiles(); return; } if (action === "screenshot") { takeScreenshot(); return; } const directory = event.target.closest("[data-device-dir]")?.dataset.deviceDir; if (directory) { state.currentPath = safeRelativePath(directory); listFiles(); return; } const file = event.target.closest("[data-device-file]")?.dataset.deviceFile; if (file) { readFile(file); return; } if (event.target.closest("[data-close-file]")) { state.fileContent = null; renderFileOutput(); } });
  detail.addEventListener("change", (event) => { if (!event.target.matches("[data-file-root]")) return; state.currentRoot = event.target.value; state.currentPath = ""; state.fileEntries = null; state.fileContent = null; renderFileOutput(); });
  detail.addEventListener("submit", (event) => { if (!event.target.matches("[data-file-path-form]")) return; event.preventDefault(); state.currentPath = safeRelativePath(event.target.querySelector("[data-file-path-input]")?.value); listFiles(); });
  document.getElementById("customerDevicesButton")?.addEventListener("click", openSheet);
  document.getElementById("closeCustomerDevices")?.addEventListener("click", closeSheet);
  document.getElementById("customerDevicesBackdrop")?.addEventListener("click", closeSheet);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && sheet?.classList.contains("open")) closeSheet(); });
  const adminSheet = document.getElementById("adminSettingsSheet");
  if (adminSheet) new MutationObserver(() => { if (legacyMode && adminSheet.classList.contains("open")) refresh(); }).observe(adminSheet, { attributes: true, attributeFilter: ["class"] });
  window.WittCustomerDevices = { open: openSheet, close: closeSheet, refresh };
  renderList();
})();
