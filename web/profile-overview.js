(() => {
  "use strict";
  const root = document.getElementById("modelQuotaOverview");
  const profile = document.getElementById("profileSheet");
  if (!root || !profile) return;
  const cards = root.querySelector("[data-quota-cards]");
  const note = root.querySelector("[data-quota-note]");
  const refreshButton = root.querySelector("[data-refresh-quota]");
  const updated = root.querySelector("[data-quota-updated]");
  const statusText = {
    management_auth_required: "未连接 CPA 额度管理权限",
    quota_unavailable: "暂时无法读取额度",
    no_accounts: "没有可查询的额度账号",
    partial: "部分额度已读取",
    ready: "额度已更新",
    unknown: "额度信息未提供",
  };
  const escape = (text) => String(text ?? "").replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const amount = (value, unit) => {
    if (!Number.isFinite(value)) return "未提供";
    return unit === "USD cents" ? "$" + (value / 100).toLocaleString("zh-CN", { maximumFractionDigits: 2 })
      : value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
  };
  const pct = (value) => Number.isFinite(value) && value >= 0 && value <= 100 ? Math.round(value * 10) / 10 : null;
  const date = (value) => {
    const time = value ? new Date(value) : null;
    return time && Number.isFinite(time.getTime()) ? time.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "暂无";
  };
  let last = null;
  let loading = false;
  let timer = null;
  let controller = null;
  const windowLabel = { monthly: "月度", weekly: "每周", daily: "每日", five_hour: "5 小时", unknown: "周期未提供" };
  function meter(value, label) {
    const number = pct(value);
    return number === null ? '<div class="model-quota-no-data">等待真实额度数据</div>'
      : `<div class="model-quota-meter" role="progressbar" aria-label="${escape(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${number}"><i style="width:${number}%"></i></div>`;
  }
  function render(body) {
    const families = new Map((body.families || []).map((family) => [family.id, family]));
    cards.innerHTML = ["grok", "gemini"].map((id) => {
      const family = families.get(id) || {};
      const label = id === "grok" ? "Grok" : "Gemini";
      const remaining = pct(family.remainingPercent);
      const basis = family.basis === "total" ? "汇总剩余" : "最低剩余";
      const detail = (family.rows || []).map((row) => `<li><div><strong>${escape(row.label)}</strong><small>账号 ${escape(row.account)} · ${escape(windowLabel[row.window] || "周期未提供")}</small></div><span>${pct(row.remainingPercent) === null ? "未提供" : pct(row.remainingPercent) + "% 剩余"}</span><small class="quota-reset-at">重置：${escape(date(row.resetAt))}</small></li>`).join("");
      return `<article class="model-quota-card" data-quota-family="${id}">
        <header><div><span class="model-family-mark">${id === "grok" ? "G" : "✦"}</span><h4>${label}</h4></div><small>${id === "gemini" ? "执行暂未启用" : "Grok Build"}</small></header>
        <div class="model-quota-value"><strong>${remaining === null ? "—" : remaining + "%"}</strong><span>${remaining === null ? "额度未读取" : basis}</span></div>
        ${meter(remaining, label + " " + basis)}
        <div class="model-quota-totals"><span>额度总量 <b>${escape(amount(family.total, family.unit))}</b></span><span>已用 <b>${escape(amount(family.used, family.unit))}</b></span><span>剩余 <b>${escape(amount(family.remaining, family.unit))}</b></span></div>
        <p class="model-quota-status">${escape(statusText[family.status] || statusText.unknown)}</p>
        <footer>${Number.isInteger(family.modelCount) ? family.modelCount + " 个模型" : "模型列表未读取"} · ${Number.isInteger(family.accounts) ? Number(family.checkedAccounts || 0) + "/" + family.accounts + " 个账号已读取" : "账号额度未读取"}${family.failedAccounts || family.skippedAccounts ? " · 部分数据缺失" : ""}</footer>
        ${detail ? `<details><summary>查看额度窗口</summary><ul>${detail}</ul></details>` : ""}
      </article>`;
    }).join("");
    updated.textContent = `额度更新：${date(body.quotaCheckedAt)} · 检查：${date(body.checkedAt)}${body.cached ? " · 缓存" : ""}`;
    note.textContent = body.stale ? "刷新失败，正在显示上次成功数据。"
      : body.status === "management_auth_required" ? "真实额度需要服务端 CPA 管理认证。请勿在页面填写密钥。"
      : "只汇总可比较的真实额度；不同窗口显示最低剩余，不相加。CPA 未提供的绝对总量显示“未提供”。";
    root.dataset.state = body.stale ? "stale" : body.status;
  }
  async function refresh() {
    if (loading) return;
    loading = true;
    refreshButton.disabled = true;
    refreshButton.textContent = "读取中…";
    root.setAttribute("aria-busy", "true");
    controller = new AbortController();
    const timeout = setTimeout(() => controller?.abort(), 25000);
    if (!last) note.textContent = "正在连接 CPA，读取真实模型额度…";
    try {
      const response = await fetch("/vault-api/providers/cpa/quotas", {
        credentials: "same-origin", cache: "no-store", signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status === 403) { last = null; throw new Error("仅管理员可查看 CPA 服务额度。"); }
        if (response.status === 401) { last = null; throw new Error("登录已失效，请重新连接。"); }
        throw new Error("CPA 额度暂时无法读取，请稍后刷新。");
      }
      const body = await response.json();
      last = body;
      render(body);
    } catch (error) {
      if (error.name === "AbortError" && !profile.classList.contains("open")) return;
      if (last) render({ ...last, stale: true });
      else render({ families: [], status: "quota_unavailable" });
      note.textContent = last ? "刷新失败，正在显示上次成功数据。" : (error.name === "AbortError" ? "CPA 额度读取超时，请稍后刷新。" : error.message);
      root.dataset.state = last ? "stale" : "error";
    } finally {
      clearTimeout(timeout);
      controller = null;
      loading = false;
      refreshButton.disabled = false;
      refreshButton.textContent = "刷新额度";
      root.setAttribute("aria-busy", "false");
    }
  }
  async function refreshCapabilities() {
    const host = document.getElementById("extensionRuntimeStatus");
    try {
      const response = await fetch("/vault-api/chat/capabilities", { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error("runtime_unavailable");
      const body = await response.json();
      host.textContent = `Grok Build：${body.runtime?.["grok-build"]?.available ? "可用" : "暂不可用"} · Codex：${body.runtime?.codex?.available ? "可用" : "待认证或服务不可用"} · Gemini 执行暂停`;
    } catch { host.textContent = "执行服务状态暂时无法读取，Gemini 执行保持暂停。"; }
  }
  function sync() {
    clearInterval(timer);
    timer = null;
    if (!profile.classList.contains("open") || document.hidden) { controller?.abort(); return; }
    refresh();
    refreshCapabilities();
    timer = setInterval(() => { if (!document.hidden) refresh(); }, 60000);
  }
  new MutationObserver(sync).observe(profile, { attributes: true, attributeFilter: ["class"] });
  document.addEventListener("visibilitychange", sync);
  refreshButton.addEventListener("click", refresh);
  document.querySelector("[data-extension-settings]")?.addEventListener("click", () => {
    document.getElementById("closeProfile")?.click();
    document.getElementById("runtimeSettingsButton")?.click();
  });
})();
