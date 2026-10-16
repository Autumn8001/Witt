(() => {
  "use strict";
  const host = document.getElementById("customerDevices");
  if (!host) return;
  const panel = document.createElement("section");
  panel.className = "customer-result-block assist-panel";
  panel.innerHTML = `<header><div><h3>临时远程协助</h3><p>客户打开轻量连接器后，在网页中配对、授权和控制协助。本次结束即失效。</p></div></header>
    <p><a href="/vault/downloads/chloe-assist.exe" download>下载 Windows 轻量连接器</a> · <a href="/vault/downloads/SHA256SUMS.txt" target="_blank" rel="noopener">SHA-256 校验值</a><br><small>Windows x64，免安装。本测试发行版尚未进行代码签名。</small></p>
    <form data-assist-create><label class="customer-workspace-field"><span>客户称呼</span><input name="customer_label" maxlength="80" value="测试协助" required></label>
    <label class="customer-workspace-field"><span>有效期</span><select name="ttl_minutes"><option value="15">15 分钟</option><option value="30" selected>30 分钟</option><option value="60">60 分钟</option></select></label>
    <label class="assist-edit-choice"><input name="allow_edits" type="checkbox"> 允许申请代码修改（客户逐次确认差异）</label>
    <label class="assist-edit-choice"><input name="allow_environment" type="checkbox"> 申请设备基本信息检查</label>
    <label class="assist-edit-choice"><input name="allow_commands" type="checkbox"> 申请环境检查与命令执行（客户逐条批准，可影响项目目录外；不自动提权）</label>
    <button class="customer-start-workspace" type="submit">生成临时会话码</button></form>
    <p data-assist-status role="status" aria-live="polite"></p><pre data-assist-code hidden></pre>
    <button type="button" data-assist-refresh>刷新协助状态</button><div data-assist-list></div>`;
  host.prepend(panel);
  const $ = selector => panel.querySelector(selector);
  const escape = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
  const status = text => { $("[data-assist-status]").textContent = text; };
  async function api(route, body) {
    const r = await fetch(`/vault-api/remote-assist/${route}`, {method:body === undefined ? "GET" : "POST",credentials:"same-origin",
      headers:{"Content-Type":"application/json"},...(body === undefined ? {} : {body:JSON.stringify(body)})});
    const data = await r.json();if (!r.ok) throw new Error(data.error || "协助请求失败");return data;
  }
  async function refresh() {
    const {sessions} = await api("sessions");
    const states = {pending:"等待客户授权",active:"已授权",paused:"客户已暂停",revoked:"已撤销",expired:"已到期"};
    $("[data-assist-list]").innerHTML = sessions.map(s => `<article class="assist-session" data-session="${escape(s.assist_session_id)}">
      <h4>${escape(s.customer_label)}</h4><p>${states[s.state] || escape(s.state)}${s.connected ? " · 已连接" : " · 未连接"}</p>
      <p>到期：${escape(new Date(s.expires_at).toLocaleString())}</p><p>目录：${escape(s.workspace_root || "等待客户选择")}</p>
      <p>设备信息：${s.allowed_capabilities.includes("workspace.system_info") ? "已申请/授权" : "未授权"} · 命令执行：${s.allowed_capabilities.includes("workspace.exec") ? "已申请/授权，每条本机确认" : "未授权"}</p>
      <button type="button" data-assist-open ${s.state === "active" && s.connected ? "" : "disabled"}>打开 Grok 工作窗口</button>
      <button type="button" data-assist-audit>查看操作记录与差异</button>
      <button type="button" data-assist-revoke ${["revoked","expired"].includes(s.state) ? "disabled" : ""}>结束协助</button>
      <div data-assist-records></div></article>`).join("") || "<p>暂无临时协助会话。</p>";
  }
  $("[data-assist-create]").addEventListener("submit", async event => {
    event.preventDefault();const form = event.currentTarget, button = form.querySelector("button");button.disabled = true;
    try {
      const values = new FormData(form), s = await api("sessions", {customer_label:values.get("customer_label"),ttl_minutes:Number(values.get("ttl_minutes")),allow_edits:values.get("allow_edits") === "on",allow_environment:values.get("allow_environment") === "on",allow_commands:values.get("allow_commands") === "on"});
      $("[data-assist-code]").hidden = false;
      $("[data-assist-code]").textContent = `会话码：${s.pairing_code}\n5 分钟内配对。客户打开轻量连接器，浏览器将自动打开授权页。\n在网页填入服务地址：${location.origin}/vault-api\n也可预填启动：chloe-assist.exe join ${s.pairing_code} --server ${location.origin}/vault-api`;
      status("会话码已生成。客户授权前，无法访问文件。请从上方下载连接器并保留此会话码；当前发行文件未签名。");await refresh();
    } catch (error) { status(error.message); } finally { button.disabled = false; }
  });
  $("[data-assist-refresh]").addEventListener("click", () => refresh().catch(e => status(e.message)));
  panel.addEventListener("click", async event => {
    const button = event.target.closest("button"), row = button?.closest("[data-session]");if (!row) return;
    const id = row.dataset.session;button.disabled = true;
    try {
      if (button.matches("[data-assist-open]")) {
        const result = await api(`sessions/${id}/workspace`, {model:"grok-4.7-high"});
        document.getElementById("closeCustomerDevices")?.click();window.DropVault?.openConversation?.(result.conversation.id);
      } else if (button.matches("[data-assist-revoke]")) { await api(`sessions/${id}/revoke`, {});status("已结束协助，新的远程操作将被拒绝。");await refresh(); }
      else if (button.matches("[data-assist-audit]")) {
        const {audit} = await api(`sessions/${id}/audit`);
        row.querySelector("[data-assist-records]").innerHTML = audit.map(a => `<details><summary>${escape(a.operation)} · ${escape(a.path || "")} · ${escape(a.status)}</summary><p>${escape(a.at)}</p>${a.change ? `<pre>${escape(a.change.diff || JSON.stringify(a.change, null, 2))}</pre>` : ""}</details>`).join("") || "<p>暂无操作记录。</p>";
      }
    } catch (error) { status(error.message); } finally { button.disabled = false; }
  });
})();
