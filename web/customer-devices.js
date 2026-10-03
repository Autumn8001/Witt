(() => {
  "use strict";
  const root = document.getElementById("customerDevices");
  if (!root) return;
  const list = root.querySelector("[data-customer-list]");
  const status = root.querySelector("[data-customer-status]");
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  async function call(path, options = {}) {
    const response = await fetch("/vault-api/" + path, {
      credentials: "same-origin", cache: "no-store", ...options,
      headers: { ...(options.headers || {}), ...(options.method === "POST" ? { "Content-Type": "application/json" } : {}) },
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "请求失败");
    return body;
  }
  async function refresh() {
    status.textContent = "正在读取设备…";
    try {
      const { devices } = await call("customer-devices");
      list.innerHTML = devices.length ? devices.map((device) => `
        <article class="customer-device" data-device-id="${escape(device.device_id)}">
          <div><strong>${escape(device.label)}</strong><small>${escape(device.device_id)} · ${device.status === "online" ? "在线" : "离线"}</small>
          <small>主机：${escape(device.hostname || "未连接")} · 最近连接：${escape(device.last_seen || "暂无")}</small></div>
          <button type="button" data-hostname="${escape(device.device_id)}" ${device.status === "online" ? "" : "disabled"}>读取 hostname</button>
          <output aria-live="polite"></output>
        </article>`).join("") : "<p>尚未配置客户电脑。</p>";
      status.textContent = `共 ${devices.length} 台设备`;
    } catch (error) { status.textContent = error.message; }
  }
  root.querySelector("[data-refresh-devices]").addEventListener("click", refresh);
  list.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-hostname]");
    if (!button) return;
    const id = button.dataset.hostname;
    const output = button.closest(".customer-device").querySelector("output");
    button.disabled = true;
    output.textContent = "正在等待设备…";
    try {
      const { result } = await call("customer-devices/" + encodeURIComponent(id) + "/hostname",
        { method: "POST", body: "{}" });
      output.textContent = result.exit_code === 0 ? result.stdout.trim() : (result.error || result.stderr || "执行失败");
    } catch (error) { output.textContent = error.message; }
    finally { button.disabled = false; }
  });
  document.getElementById("openAdminSettings")?.addEventListener("click", refresh);
  const observer = new MutationObserver(() => {
    if (document.getElementById("adminSettingsSheet")?.classList.contains("open")) refresh();
  });
  observer.observe(document.getElementById("adminSettingsSheet"), { attributes: true, attributeFilter: ["class"] });
})();
