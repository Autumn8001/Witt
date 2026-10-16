"use strict";

// Temporary authorization layer over the existing Gateway/Workspace stack.
// Session credentials live only in memory. A restart deliberately revokes them.
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");

const READ = Object.freeze(["workspace.list", "workspace.stat", "workspace.read", "workspace.search"]);
const EDIT = Object.freeze(["workspace.write", "workspace.patch"]);
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const isAssist = (id) => typeof id === "string" && id.startsWith("assist-");

class AssistSessions {
  constructor({ gateway, workspaceStore, auditDirectory, now = Date.now }) {
    this.gateway = gateway; this.workspaceStore = workspaceStore; this.now = now;
    this.sessions = new Map(); this.devices = new Map(); this.tickets = new Map(); this.attempts = new Map();
    fs.mkdirSync(auditDirectory, { recursive: true, mode: 0o700 });
    const file = path.join(auditDirectory, "assist-audit.sqlite");
    this.db = new DatabaseSync(file); try { fs.chmodSync(file, 0o600); } catch {}
    this.db.exec(`CREATE TABLE IF NOT EXISTS assist_audit (id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL, operator_id TEXT NOT NULL, operation TEXT NOT NULL, path TEXT,
      status TEXT NOT NULL, at TEXT NOT NULL, change_json TEXT)`);
    this.db.exec("CREATE TABLE IF NOT EXISTS assist_history(session_id TEXT PRIMARY KEY, operator_id TEXT NOT NULL, summary_json TEXT NOT NULL)");
    this.history = this.db.prepare("INSERT OR REPLACE INTO assist_history VALUES(?,?,?)");
    for (const row of this.db.prepare("SELECT summary_json FROM assist_history").all()) {
      const saved = JSON.parse(row.summary_json);
      saved.state = this.now() >= saved.expires_at ? "expired" : "revoked";
      saved.token_hash = null; saved.code_hash = null;
      this.sessions.set(saved.assist_session_id, saved);
      if (saved.workspace_id) {
        const binding = this.workspaceStore.get(saved.workspace_id);
        if (binding && binding.state !== "closed") this.workspaceStore.setState(saved.workspace_id, "closed");
      }
    }
    this.insert = this.db.prepare("INSERT INTO assist_audit(session_id,operator_id,operation,path,status,at,change_json) VALUES(?,?,?,?,?,?,?)");
    this.timer = setInterval(() => this.sweep(), 1000); this.timer.unref?.();
  }
  create(operator, input = {}) {
    if (!operator?.userId) fail("OPERATOR_REQUIRED");
    if ([...this.sessions.values()].filter(s => s.operator_id === operator.userId && !["revoked", "expired"].includes(s.state)).length >= 10) fail("SESSION_LIMIT");
    const ttl = input.ttl_minutes === undefined ? 30 : input.ttl_minutes;
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 60) fail("INVALID_EXPIRY");
    const code = crypto.randomBytes(5).toString("hex").toUpperCase();
    const session = { assist_session_id: crypto.randomUUID(), operator_id: operator.userId,
      operator_label: String(operator.label || "Chloe 操作者").slice(0, 100),
      customer_label: String(input.customer_label || "临时协助").slice(0, 100),
      state: "pending", created_at: this.now(), expires_at: this.now() + ttl * 60_000,
      pairing_expires_at: this.now() + Math.min(ttl * 60_000, 5 * 60_000), code_hash: digest(code),
      allowed_capabilities: [...READ, ...(input.allow_edits === true ? EDIT : []), ...(input.allow_environment === true ? ["workspace.system_info"] : []), ...(input.allow_commands === true ? ["workspace.exec"] : [])],
      device_id: null, workspace_root: null, workspace_id: null };
    this.sessions.set(session.assist_session_id, session); this.record(session, "session.create", null, "pending");
    return { ...this.public(session), pairing_code: `${code.slice(0, 5)}-${code.slice(5)}` };
  }
  public(s) {
    const { code_hash, token_hash, ...result } = s;
    return { ...result, connected: s.device_id ? this.gateway.registry.describe(s.device_id)?.status === "online" : false };
  }
  owned(id, operator) {
    const s = this.sessions.get(id);
    if (!s || s.operator_id !== operator?.userId) fail("SESSION_NOT_FOUND");
    this.expire(s); return s;
  }
  preview(code, address = "unknown") {
    const minute = Math.floor(this.now() / 60_000), key = `${address}:${minute}`;
    this.attempts.set(key, (this.attempts.get(key) || 0) + 1);
    if (this.attempts.get(key) > 10 || this.tickets.size >= 100) fail("PAIR_RATE_LIMIT");
    const normalized = String(code || "").toUpperCase().replace(/-/g, "");
    if (!/^[A-F0-9]{10}$/.test(normalized)) fail("PAIR_NOT_AVAILABLE");
    const s = [...this.sessions.values()].find(s => s.state === "pending" && s.code_hash === digest(normalized));
    if (!s || this.now() >= s.pairing_expires_at || this.now() >= s.expires_at) fail("PAIR_NOT_AVAILABLE");
    const ticket = crypto.randomBytes(32).toString("base64url");
    this.tickets.set(digest(ticket), { session: s, expires: Math.min(s.pairing_expires_at, this.now() + 120_000) });
    return { pair_ticket: ticket, operator_label: s.operator_label, service_name: "Chloe Remote Assist",
      assist_session_id: s.assist_session_id, expires_at: s.expires_at, allowed_capabilities: s.allowed_capabilities };
  }
  authorize(input) {
    const hash = digest(String(input.pair_ticket || "")), ticket = this.tickets.get(hash);
    this.tickets.delete(hash);
    if (!ticket || ticket.session.state !== "pending" || this.now() >= ticket.expires) fail("PAIR_NOT_AVAILABLE");
    const s = ticket.session, root = input.workspace_root;
    if (typeof root !== "string" || root.length > 1024 || !/^[A-Za-z]:[\\/]/.test(root) || /[\x00-\x1f]/.test(root) || root.slice(2).includes(":")) fail("INVALID_ROOT");
    const caps = input.allowed_capabilities;
    if (!Array.isArray(caps) || new Set(caps).size !== caps.length || !READ.every(c => caps.includes(c)) || caps.some(c => !s.allowed_capabilities.includes(c))) fail("INVALID_CAPABILITIES");
    const token = crypto.randomBytes(32).toString("base64url");
    s.device_id = `assist-${crypto.randomUUID()}`; s.token_hash = digest(token); s.code_hash = null;
    s.workspace_root = root; s.allowed_capabilities = [...caps]; s.state = "active";
    this.devices.set(s.device_id, s);
    this.gateway.registry.add({ device_id: s.device_id, token_sha256: s.token_hash,
      label: s.customer_label, customer_id: s.operator_id, capabilities: caps, allowed_roots: ["project"], workspace_roots: { project: root } });
    this.record(s, "session.authorize", null, "active");
    return { ...this.public(s), device_token: token };
  }
  customer(token) {
    const hash = digest(String(token || ""));
    const s = [...this.sessions.values()].find(s => s.token_hash === hash);
    if (!s) fail("SESSION_NOT_AUTHORIZED"); this.expire(s);
    if (!["active", "paused"].includes(s.state)) fail("SESSION_NOT_ACTIVE");
    return s;
  }
  expire(s) {
    if (this.now() >= s.expires_at && !["expired", "revoked"].includes(s.state)) this.transition(s, "expired");
  }
  transition(s, state) {
    if (!["active", "paused", "revoked", "expired"].includes(state)) fail("INVALID_STATE");
    this.expireUnlessExpiring(s, state);
    if (["revoked", "expired"].includes(s.state)) fail("SESSION_NOT_ACTIVE");
    if (state === "active" && s.state !== "paused") fail("INVALID_STATE");
    s.state = state;
    if (s.workspace_id) {
      const binding = this.workspaceStore.get(s.workspace_id);
      if (binding && binding.state !== "closed") this.workspaceStore.setState(s.workspace_id, state === "active" ? "active" : state === "paused" ? "paused" : "closed");
    }
    if (state !== "active" && s.device_id) {
      const connection = this.gateway.registry.session(s.device_id);
      if (connection) { this.gateway.dispatcher.disconnect(connection); this.gateway.registry.remove(s.device_id, connection); connection.ws.close(4003, "assist_authorization_changed"); }
    }
    if (["revoked", "expired"].includes(state)) {
      s.token_hash = null; s.code_hash = null;
      if (s.device_id) this.gateway.registry.definitions.delete(s.device_id);
    }
    this.record(s, "session." + state, null, state); return this.public(s);
  }
  expireUnlessExpiring(s, state) { if (state !== "expired") this.expire(s); }
  disconnected(deviceId) {
    const s = this.devices.get(deviceId);
    if (s?.state === "active") this.transition(s, "revoked");
  }
  guardDevice(deviceId, allowed) {
    if (!isAssist(deviceId)) return;
    const s = this.devices.get(deviceId);
    if (!s) fail("SESSION_NOT_AUTHORIZED"); this.expire(s);
    if (s.state !== "active" || this.now() >= s.expires_at) fail("SESSION_NOT_ACTIVE");
    if (allowed.tool !== "workspace" || !s.workspace_id || allowed.context?.workspaceSessionId !== s.assist_session_id ||
        (allowed.capability === "workspace.system_info" ? allowed.args.root !== undefined : allowed.args.root !== "project") || !s.allowed_capabilities.includes(allowed.capability)) fail("SESSION_SCOPE_DENIED");
  }
  commandsAllowed(deviceId) {
    const s = this.devices.get(deviceId);
    return !!s && s.state === "active" && this.now() < s.expires_at && s.allowed_capabilities.includes("workspace.exec");
  }
  bindWorkspace(s, chat, input = {}) {
    this.expire(s); if (s.state !== "active" || !this.public(s).connected) fail("DEVICE_OFFLINE");
    if (s.workspace_id) return { workspace: this.workspaceStore.get(s.workspace_id), conversation: chat.publicConversation(chat.readConversation(s.conversation_id)) };
    const harnessSessionId = crypto.randomUUID();
    const conv = chat.createRemoteWorkspaceConversation({ title: s.customer_label, model: input.model || "grok-4.7-high", reasoning: "high", harnessSessionId });
    const workspace = this.workspaceStore.create({ workspace_id: s.assist_session_id, conversation_id: conv.id,
      customer_id: s.operator_id, device_id: s.device_id, root_alias: "project", display_path: s.workspace_root,
      harness_id: conv.harnessId, model_id: conv.model, harness_session_id: harnessSessionId });
    s.workspace_id = workspace.workspace_id; s.conversation_id = conv.id;
    this.record(s, "workspace.bind", null, "active"); return { workspace, conversation: chat.publicConversation(conv) };
  }
  record(s, operation, file, status, change = null) {
    this.insert.run(s.assist_session_id, s.operator_id, operation, file || null, status, new Date(this.now()).toISOString(), change ? JSON.stringify(change) : null);
    this.history.run(s.assist_session_id, s.operator_id, JSON.stringify(this.public(s)));
  }
  audit(s) {
    return this.db.prepare("SELECT operation,path,status,at,change_json FROM assist_audit WHERE session_id=? ORDER BY id DESC LIMIT 200").all(s.assist_session_id)
      .map(({change_json, ...r}) => ({ ...r, ...(change_json ? { change: JSON.parse(change_json) } : {}) }));
  }
  transport() {
    return { dispatch: async (...args) => {
      const s = this.devices.get(args[0]);
      try {
        if (s && EDIT.includes(args[2].operation)) args[3] = 30_000;
        if (s && args[2].operation === "workspace.exec") this.record(s, "workspace.exec.request", args[2].cwd, "awaiting_client_confirmation", { program: args[2].program, intent_sha256: digest(JSON.stringify(args[2])) });
        const result = await this.gateway.dispatcher.dispatch(...args);
        if (s) {
          let change = null;
          if (EDIT.includes(args[2].operation) && result.exit_code === 0) {
            try { change = JSON.parse(result.stdout).change || null; } catch {}
          }
          this.record(s, args[2].operation, args[2].path, result.error || (result.exit_code === 0 ? "completed" : "failed"), change);
        }
        return result;
      } catch (e) { if (s) this.record(s, args[2]?.operation || "operation", args[2]?.path, e.code || "failed"); throw e; }
    } };
  }
  sweep() {
    for (const s of this.sessions.values()) this.expire(s);
    for (const [key, t] of this.tickets) if (this.now() >= t.expires || t.session.state !== "pending") this.tickets.delete(key);
    const minute = Math.floor(this.now() / 60_000); for (const key of this.attempts.keys()) if (!key.endsWith(":" + minute)) this.attempts.delete(key);
  }
  close() {
    clearInterval(this.timer);
    for (const s of this.sessions.values()) { this.expire(s); if (!["revoked", "expired"].includes(s.state)) this.transition(s, "revoked"); }
    this.db.close();
  }
}
module.exports = { AssistSessions, READ, EDIT, isAssist };
