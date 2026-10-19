(() => {
  "use strict";
  const host = document.getElementById("customerDevices");
  if (!host) return;
  const panel = document.createElement("section");
  panel.className = "customer-result-block assist-panel";
  panel.innerHTML = `<header><div><h3>连接远程电脑</h3><p>生成连接码，在远程电脑打开连接器、输入连接码并授权，然后开始开发。</p></div></header>
    <p><a href="/vault/downloads/chloe-assist.exe" download>下载 Windows 轻量连接器</a> · <a href="/vault/downloads/SHA256SUMS.txt" target="_blank" rel="noopener">SHA-256 校验值</a><br><small>Windows x64，免安装。本测试发行版尚未进行代码签名。</small></p>
    <form data-assist-create><label class="customer-workspace-field"><span>工作区名称</span><input name="customer_label" maxlength="80" value="临时开发" required></label>
    <label class="customer-workspace-field"><span>有效期</span><select name="ttl_minutes"><option value="15">15 分钟</option><option value="30" selected>30 分钟</option><option value="60">60 分钟</option></select></label>
    <label class="customer-workspace-field"><span>访问权限</span><select name="access_mode"><option value="workspace">仅所选项目 · 命令需本机确认</option><option value="full">本次完整访问 · 需本机明确授权</option></select></label>
    <p class="customer-muted">完整访问允许读写项目外文件、执行命令及配置环境，使用远程电脑当前用户权限。可随时在本机暂停或结束。</p>
    <button class="customer-start-workspace" type="submit">生成连接码</button></form>
    <p data-assist-status role="status" aria-live="polite"></p><pre data-assist-code hidden></pre>
    <button type="button" data-assist-refresh>刷新连接状态</button><div data-assist-list></div>`;
  host.prepend(panel);
  const $ = selector => panel.querySelector(selector);
  const escape = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
  const status = text => { $("[data-assist-status]").textContent = text; };
  async function api(route, body, method) {
    const r = await fetch(`/vault-api/remote-assist/${route}`, {method:method || (body === undefined ? "GET" : "POST"),credentials:"same-origin",
      headers:{"Content-Type":"application/json"},...(body === undefined ? {} : {body:JSON.stringify(body)})});
    const data = await r.json();if (!r.ok) throw new Error(data.error || "协助请求失败");return data;
  }
  async function refresh() {
    const {sessions = []} = await api("sessions");
    const states = {pending:"等待本机授权",active:"已授权",paused:"本机已暂停",revoked:"已撤销",expired:"已到期"};
    $("[data-assist-list]").innerHTML = sessions.map(s => `<article class="assist-session" data-session="${escape(s.assist_session_id)}">
      <h4>${escape(s.customer_label)}</h4><p>${states[s.state] || escape(s.state)}${s.connected ? " · 已连接" : " · 未连接"}</p>
      <p>到期：${escape(new Date(s.expires_at).toLocaleString())}</p><p>${s.access_mode === "full" ? "默认工作目录" : "授权目录"}：${escape(s.workspace_root || "等待本机选择")}</p>
      <p>${s.access_mode === "full" ? "本次完整访问 · 所有本地目录及命令 · 无逐条审批" : "仅所选项目 · 命令需本机确认"}</p>
      <button type="button" data-assist-open ${s.state === "active" && s.connected ? "" : "disabled"}>开始开发</button>
      <button type="button" data-assist-audit>查看操作记录与差异</button>
      <button type="button" data-assist-revoke ${["revoked","expired"].includes(s.state) ? "disabled" : ""}>结束连接</button>
      ${["revoked","expired"].includes(s.state) ? '<button type="button" data-assist-delete>删除记录</button>' : ""}
      <div data-assist-records></div></article>`).join("") || "<p>暂无临时协助会话。</p>";
  }
  $("[data-assist-create]").addEventListener("submit", async event => {
    event.preventDefault();const form = event.currentTarget, button = form.querySelector("button");button.disabled = true;
    try {
      const values = new FormData(form), s = await api("sessions", {customer_label:values.get("customer_label"),ttl_minutes:Number(values.get("ttl_minutes")),access_mode:values.get("access_mode"),allow_edits:true,allow_commands:true,allow_environment:true});
      $("[data-assist-code]").hidden = false;
      $("[data-assist-code]").textContent = `连接码：${s.pairing_code}\n5 分钟内配对。在远程电脑打开连接器，浏览器将自动打开授权页。\n在网页填入服务地址：${location.origin}/vault-api\n也可预填启动：chloe-assist.exe join ${s.pairing_code} --server ${location.origin}/vault-api`;
      status("连接码已生成，等待远程电脑配对并授权。");await refresh();
    } catch (error) { status(error.message); } finally { button.disabled = false; }
  });
  $("[data-assist-refresh]").addEventListener("click", () => refresh().catch(e => status(e.message)));
  const sheet = document.getElementById("customerDevicesSheet");
  let timer, refreshing = false;
  async function sync() {
    if (refreshing || !sheet?.classList.contains("open")) return;
    refreshing = true;
    try { await refresh(); } catch (e) { status(e.message); } finally { refreshing = false; }
  }
  if (sheet) new MutationObserver(() => {
    clearInterval(timer);
    if (sheet.classList.contains("open")) { void sync(); timer = setInterval(sync, 5000); }
  }).observe(sheet, { attributes: true, attributeFilter: ["class"] });
  panel.addEventListener("click", async event => {
    const button = event.target.closest("button"), row = button?.closest("[data-session]");if (!row) return;
    const id = row.dataset.session;button.disabled = true;
    try {
      if (button.matches("[data-assist-open]")) {
        const result = await api(`sessions/${id}/workspace`, {model:"grok-4.7-high"});
        document.getElementById("closeCustomerDevices")?.click();window.DropVault?.openConversation?.(result.conversation.id);
      } else if (button.matches("[data-assist-revoke]")) { await api(`sessions/${id}/revoke`, {});status("已结束协助，新的远程操作将被拒绝。");await refresh(); }
      else if (button.matches("[data-assist-delete]")) {
        if (!confirm("删除已结束的连接记录？聊天和远程文件会保留。")) return;
        await api(`sessions/${id}`, undefined, "DELETE"); await refresh(); window.WittCustomerDevices?.refresh();
      } else if (button.matches("[data-assist-audit]")) {
        const {audit} = await api(`sessions/${id}/audit`);
        row.querySelector("[data-assist-records]").innerHTML = audit.map(a => `<details><summary>${escape(a.operation)} · ${escape(a.path || "")} · ${escape(a.status)}</summary><p>${escape(a.at)}</p>${a.change ? `<pre>${escape(a.change.diff || JSON.stringify(a.change, null, 2))}</pre>` : ""}</details>`).join("") || "<p>暂无操作记录。</p>";
      }
    } catch (error) { status(error.message); } finally { button.disabled = false; }
  });
})();
