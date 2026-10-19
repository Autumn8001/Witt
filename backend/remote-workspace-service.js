"use strict";

// Runtime glue for a Remote Vibecoding Workspace.  It deliberately owns the
// per-turn credential and tiny Grok working directory, rather than handing a
// general Witt API token or a real customer path to a harness process.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

class RemoteWorkspaceServiceError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

class RemoteWorkspaceService {
  constructor(options = {}) {
    if (!options.workspaceStore || !options.dispatcher || !options.approvals || !options.audit) {
      throw new RemoteWorkspaceServiceError("INVALID_DEPENDENCIES");
    }
    this.workspaceStore = options.workspaceStore;
    this.dispatcher = options.dispatcher;
    this.capabilitiesFor = options.capabilitiesFor || (() => null);
    this.approvals = options.approvals;
    this.audit = options.audit;
    this.runtimeDir = options.runtimeDir;
    this.mcpProgram = options.mcpProgram || path.join(__dirname, "mcp", "remote-workspace.js");
    this.antigravityBin = options.antigravityBin || "";
    this.apiBase = options.apiBase || "http://127.0.0.1:3003";
    this.approvalTtlMs = options.approvalTtlMs || 5 * 60_000;
    this.notifyApproval = options.notifyApproval || (() => { throw new RemoteWorkspaceServiceError("APPROVAL_UI_UNAVAILABLE"); });
    this.sessions = new Map();
    this.cliRuntimes = new Map();
    this.cliPreparing = new Map();
    this.closed = false;
    this.cliRuntimeFactory = options.cliRuntimeFactory || null;
    this.waiters = new Map();
    fs.mkdirSync(this.runtimeDir, { recursive: true, mode: 0o700 });
  }

  fullAccessFor(binding) {
    return !!binding && this.dispatcher.fullAccessFor?.(binding.device_id) === true;
  }

  bindingForConversation(conversationId) {
    return this.workspaceStore.getByConversation(conversationId);
  }

  runtimeFor(binding) {
    if (!binding || binding.state !== "active") throw new RemoteWorkspaceServiceError("WORKSPACE_NOT_ACTIVE");
    if (this.cliRuntimes.has(binding.workspace_id)) return this.cliRuntimes.get(binding.workspace_id);
    if (this.cliRuntimeFactory && binding.harness_id === "google-antigravity")
      throw new RemoteWorkspaceServiceError("ISOLATED_CLI_NOT_READY");
    const existing = this.sessions.get(binding.workspace_id);
    if (existing) return existing;
    const directory = path.join(this.runtimeDir, binding.workspace_id);
    const configDir = path.join(directory, ".grok");
    const geminiConfigDir = path.join(directory, ".gemini", "config");
    const geminiStateDir = path.join(directory, ".gemini", "antigravity-cli");
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(geminiConfigDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(geminiStateDir, { recursive: true, mode: 0o700 });
    // New isolated homes default to OAuth login. Explicitly select the Gemini
    // API provider so the adapter's key/base URL are used in headless mode.
    const geminiSettingsFile = path.join(geminiStateDir, "settings.json");
    let geminiSettings = {};
    try { geminiSettings = JSON.parse(fs.readFileSync(geminiSettingsFile, "utf8")); } catch {}
    fs.writeFileSync(geminiSettingsFile,
      JSON.stringify({ ...geminiSettings, modelProvider: "gemini",
        permissions: { ...geminiSettings.permissions,
          allow: ["mcp(witt_remote_workspace/*)"] } }) + "\n", { mode: 0o600 });
    const capabilities = binding.device_id.startsWith("assist-") ? (this.capabilitiesFor(binding.device_id) || []) : null;
    const capabilityEnv = capabilities ? {WITT_REMOTE_WORKSPACE_CAPABILITIES: JSON.stringify(capabilities)} : {};
    const secret = crypto.randomBytes(32).toString("base64url");
    const credentialFile = path.join(directory, "mcp-session-token");
    fs.writeFileSync(credentialFile, `${secret}\n`, { mode: 0o600 });
    const config = [
      "[mcp_servers.witt_remote_workspace]",
      `command = ${JSON.stringify(process.execPath)}`,
      `args = [${JSON.stringify(this.mcpProgram)}]`,
      "enabled = true",
      "[mcp_servers.witt_remote_workspace.env]",
      'WITT_REMOTE_WORKSPACE_MCP_ENABLED = "1"',
      `WITT_REMOTE_WORKSPACE_MCP_API = ${JSON.stringify(this.apiBase)}`,
      `WITT_REMOTE_WORKSPACE_CREDENTIAL_FILE = ${JSON.stringify(credentialFile)}`,
      ...(capabilities ? [`WITT_REMOTE_WORKSPACE_CAPABILITIES = ${JSON.stringify(JSON.stringify(capabilities))}`] : []),
      "",
    ].join("\n");
    fs.writeFileSync(path.join(configDir, "config.toml"), config, { mode: 0o600 });
    fs.writeFileSync(path.join(geminiConfigDir, "mcp_config.json"), JSON.stringify({
      mcpServers: { witt_remote_workspace: {
        command: process.execPath,
        args: [this.mcpProgram],
        env: {
          WITT_REMOTE_WORKSPACE_MCP_ENABLED: "1",
          WITT_REMOTE_WORKSPACE_MCP_API: this.apiBase,
          WITT_REMOTE_WORKSPACE_CREDENTIAL_FILE: credentialFile,
          ...capabilityEnv,
        },
      } },
    }, null, 2) + "\n", { mode: 0o600 });
    let geminiBin = this.antigravityBin;
    if (process.platform === "linux" && geminiBin && fs.existsSync(`${geminiBin}.orig-elf`)) {
      // Permit the unprivileged runtime to traverse its home without allowing
      // directory listings of the workspace database or other runtime homes.
      fs.chmodSync(path.dirname(this.runtimeDir), 0o711);
      fs.chmodSync(this.runtimeDir, 0o711);
      const launcher = path.join(directory, "gemini-runtime");
      const quote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
      fs.writeFileSync(launcher,
        `#!/bin/sh\nexec /usr/bin/setpriv --reuid=agytest --regid=agytest --clear-groups env HOME=${quote(directory)} USER=agytest /usr/bin/qemu-x86_64 -cpu max ${quote(`${geminiBin}.orig-elf`)} "$@"\n`,
        { mode: 0o700 });
      geminiBin = launcher;
      for (const target of [directory, configDir, path.dirname(geminiConfigDir), geminiConfigDir,
        geminiStateDir, geminiSettingsFile, credentialFile,
        path.join(configDir, "config.toml"), path.join(geminiConfigDir, "mcp_config.json"), launcher]) {
        try { fs.chownSync(target, 1000, 1000); } catch {}
      }
    }
    const codexConfigOverrides = [
      `mcp_servers.witt_remote_workspace.command=${JSON.stringify(process.execPath)}`,
      `mcp_servers.witt_remote_workspace.args=${JSON.stringify([this.mcpProgram])}`,
      "mcp_servers.witt_remote_workspace.enabled=true",
      'mcp_servers.witt_remote_workspace.env.WITT_REMOTE_WORKSPACE_MCP_ENABLED="1"',
      `mcp_servers.witt_remote_workspace.env.WITT_REMOTE_WORKSPACE_MCP_API=${JSON.stringify(this.apiBase)}`,
      `mcp_servers.witt_remote_workspace.env.WITT_REMOTE_WORKSPACE_CREDENTIAL_FILE=${JSON.stringify(credentialFile)}`,
      ...(capabilities ? [`mcp_servers.witt_remote_workspace.env.WITT_REMOTE_WORKSPACE_CAPABILITIES=${JSON.stringify(JSON.stringify(capabilities))}`] : []),
    ];
    const value = Object.freeze({
      workspaceId: binding.workspace_id, assistSession: binding.device_id.startsWith("assist-"), capabilities, cwd: directory, secret, credentialFile,
      apiBase: this.apiBase, home: directory, geminiBin, codexConfigOverrides,
    });
    this.sessions.set(binding.workspace_id, value);
    return value;
  }

  authenticate(secret) {
    for (const [workspaceId, session] of this.sessions) {
      if (safeEqual(secret, session.secret)) {
        const binding = this.workspaceStore.get(workspaceId);
        if (binding?.state === "active") return binding;
      }
    }
    return null;
  }

  stageAttachments(binding, files) {
    if (!files.length) return files;
    const runtime = this.runtimeFor(binding);
    // Keep the copy destination outside the model-writable working directory.
    // A new root-owned directory and exclusive copies prevent symlink overwrite.
    const directory = fs.mkdtempSync(path.join(this.runtimeDir, "attachments-"));
    fs.chmodSync(directory, 0o711);
    const staged = files.map((file) => {
      if (fs.statSync(file.path).size > 16 * 1024 * 1024) {
        throw new RemoteWorkspaceServiceError("ATTACHMENT_TOO_LARGE");
      }
      const destination = path.join(directory,
        crypto.randomUUID() + path.extname(file.path).slice(0, 18));
      fs.copyFileSync(file.path, destination, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(destination, 0o600);
      if (process.platform === "linux" && runtime.geminiBin !== this.antigravityBin) {
        fs.chownSync(destination, 1000, 1000);
      }
      return { ...file, path: destination };
    });
    return staged;
  }

  async prepareRuntimeFor(binding) {
    if (!this.cliRuntimeFactory || binding.harness_id !== "google-antigravity") return this.runtimeFor(binding);
    if (this.closed) throw new RemoteWorkspaceServiceError("SERVER_SHUTDOWN");
    if (this.cliRuntimes.has(binding.workspace_id)) return this.cliRuntimes.get(binding.workspace_id);
    if (this.cliPreparing.has(binding.workspace_id)) return this.cliPreparing.get(binding.workspace_id);
    if (binding.state !== "active") throw new RemoteWorkspaceServiceError("WORKSPACE_NOT_ACTIVE");
    const preparing = Promise.resolve().then(async () => {
      const runtime = await this.cliRuntimeFactory(binding, (operation, args, options) => this.executeBinding(binding.workspace_id, operation, args, options), {
        fullAccessFor: () => this.fullAccessFor(this.workspaceStore.get(binding.workspace_id)),
      });
      try {
        if (runtime?.remoteCli?.isolated !== true || !runtime.geminiBin || !runtime.cwd || !runtime.home)
          throw new RemoteWorkspaceServiceError("ISOLATED_REMOTE_CLI_REQUIRED");
        if (this.closed || this.workspaceStore.get(binding.workspace_id)?.state !== "active")
          throw new RemoteWorkspaceServiceError("WORKSPACE_NOT_ACTIVE");
        const value = Object.freeze({ ...runtime, workspaceId: binding.workspace_id, assistSession: true });
        this.cliRuntimes.set(binding.workspace_id, value);
        return value;
      } catch (error) { await runtime?.close?.(); throw error; }
    }).finally(() => this.cliPreparing.delete(binding.workspace_id));
    this.cliPreparing.set(binding.workspace_id, preparing);
    return preparing;
  }

  async executeMcp(secret, operation, args, options) {
    const binding = this.authenticate(secret);
    if (!binding) throw new RemoteWorkspaceServiceError("WORKSPACE_SESSION_INVALID");
    return this.executeBinding(binding.workspace_id, operation, args, options);
  }

  async executeBinding(workspaceId, operation, args, { signal } = {}) {
    const binding = this.workspaceStore.get(workspaceId);
    if (!binding || binding.state !== "active") throw new RemoteWorkspaceServiceError("WORKSPACE_NOT_ACTIVE");
    const first = await this.dispatcher.execute({ workspace_id: binding.workspace_id, operation, args, signal });
    if (first.status !== "approval_required") return first.result;
    await this.waitForApproval(binding, first.approval);
    const completed = await this.dispatcher.execute({
      workspace_id: binding.workspace_id, operation, args, approval_id: first.approval.id,
      signal,
    });
    return completed.result;
  }

  waitForApproval(binding, approval) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(approval.id);
        try { this.approvals.reject(approval.id, binding.workspace_id); } catch {}
        reject(new RemoteWorkspaceServiceError("APPROVAL_EXPIRED"));
      }, Math.max(1, approval.expires_at - Date.now()));
      timer.unref?.();
      this.waiters.set(approval.id, { binding, resolve, reject, timer });
      try {
        this.notifyApproval(binding, approval);
      } catch (error) {
        clearTimeout(timer);
        this.waiters.delete(approval.id);
        try { this.approvals.reject(approval.id, binding.workspace_id); } catch {}
        reject(error);
      }
    });
  }

  resolveApproval(workspaceId, approvalId, accepted) {
    const waiter = this.waiters.get(approvalId);
    if (!waiter || waiter.binding.workspace_id !== workspaceId) throw new RemoteWorkspaceServiceError("APPROVAL_NOT_FOUND");
    clearTimeout(waiter.timer);
    this.waiters.delete(approvalId);
    if (accepted) {
      this.approvals.accept(approvalId, workspaceId);
      waiter.resolve();
    } else {
      this.approvals.reject(approvalId, workspaceId);
      waiter.reject(new RemoteWorkspaceServiceError("APPROVAL_REJECTED"));
    }
  }

  close() {
    this.closed = true;
    for (const runtime of this.cliRuntimes.values()) Promise.resolve(runtime.close?.()).catch(() => {});
    this.cliRuntimes.clear();
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new RemoteWorkspaceServiceError("SERVER_SHUTDOWN"));
    }
    this.waiters.clear();
    this.sessions.clear();
  }
}

module.exports = { RemoteWorkspaceService, RemoteWorkspaceServiceError };
