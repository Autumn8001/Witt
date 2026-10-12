"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { AuthStore } = require("./sqlite-store");

const ID = /^[a-f0-9-]{36}$/;
const TOKEN_BYTES = 32;
const CODEX_PROFILE_IDS = new Set(["default", "xuanyu", "account4", "account5"]);

function now() { return new Date().toISOString(); }
function randomToken() { return crypto.randomBytes(TOKEN_BYTES).toString("base64url"); }
function hash(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function passwordHash(password, salt = crypto.randomBytes(16).toString("base64url")) {
  return { salt, value: crypto.scryptSync(password, salt, 32).toString("base64url") };
}
function passwordMatches(password, record) {
  if (!record?.salt || !record?.value) return false;
  const candidate = Buffer.from(crypto.scryptSync(password, record.salt, 32).toString("base64url"));
  const expected = Buffer.from(record.value);
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

class AuthService {
  constructor(options) {
    this.dir = options.dir;
    this.sendJson = options.sendJson;
    this.readJsonBody = options.readJsonBody;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.file = path.join(this.dir, "auth.json");
    this.store = new AuthStore(this.dir);
    const legacy = this.readJson();
    if (!this.store.load() && legacy) this.store.save(legacy);
  }

  readJson() {
    try { return JSON.parse(fs.readFileSync(this.file, "utf8")); }
    catch { return null; }
  }

  read() {
    return this.store.load() || this.readJson() ||
      { version: 1, initializedAt: null, admin: null, invites: [], devices: [] };
  }

  write(store) {
    this.store.save(store);
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }

  initialized() { return Boolean(this.read().admin); }

  initialize(password, label = "管理员") {
    if (this.initialized()) throw new Error("管理员已初始化；如需重设请使用恢复流程");
    if (typeof password !== "string" || password.length < 12) throw new Error("管理员密码至少需要 12 个字符");
    const store = this.read();
    const credentials = passwordHash(password);
    store.initializedAt = now();
    store.admin = { id: crypto.randomUUID(), label: String(label || "管理员").slice(0, 48), password: credentials };
    this.write(store);
    return this.createInvite({ label: "管理员设备", maxDevices: 1, admin: true });
  }

  createInvite(input = {}) {
    const store = this.read();
    if (!store.admin) throw new Error("请先初始化管理员");
    const maxDevices = Math.max(1, Math.min(20, Number(input.maxDevices || 1)));
    const invite = {
      id: crypto.randomUUID(), code: randomToken(), label: String(input.label || "新用户").slice(0, 48),
      userId: crypto.randomUUID(), admin: Boolean(input.admin), maxDevices, usedDevices: 0,
      expiresAt: input.expiresAt || null, disabled: false, createdAt: now(),
    };
    store.invites.push(invite);
    this.write(store);
    return invite;
  }

  authenticate(header) {
    const token = String(header || "").startsWith("Bearer ") ? String(header).slice(7) : "";
    return this.authenticateToken(token);
  }

  authenticateToken(token) {
    token = String(token || "");
    if (!token) return null;
    const tokenHash = hash(token);
    const store = this.read();
    const device = store.devices.find((item) => item.tokenHash === tokenHash && !item.disabled);
    if (!device) return null;
    if (!device.lastSeenAt || Date.now() - Date.parse(device.lastSeenAt) > 5 * 60 * 1000) {
      device.lastSeenAt = now();
      this.write(store);
    }
    const policy = store.userPolicies?.[device.userId] || null;
    return {
      userId: device.userId,
      deviceId: device.id,
      admin: Boolean(device.admin),
      label: device.label,
      codexProfiles: Array.isArray(policy?.codexProfiles)
        ? policy.codexProfiles.filter((item) => CODEX_PROFILE_IDS.has(item)) : null,
      unrestrictedModels: Boolean(policy?.unrestrictedModels),
    };
  }

  setUserPolicy(userId, input = {}) {
    if (!ID.test(String(userId || ""))) throw new Error("用户编号无效");
    const store = this.read();
    if (!store.devices.some((device) => device.userId === userId)) {
      throw new Error("用户不存在");
    }
    const profiles = Array.isArray(input.codexProfiles)
      ? [...new Set(input.codexProfiles.map(String))]
        .filter((item) => CODEX_PROFILE_IDS.has(item))
      : [];
    if (!profiles.length) throw new Error("至少需要允许一个 Codex 账号");
    store.userPolicies = store.userPolicies || {};
    store.userPolicies[userId] = {
      codexProfiles: profiles,
      unrestrictedModels: Boolean(input.unrestrictedModels),
      updatedAt: now(),
    };
    this.write(store);
    return store.userPolicies[userId];
  }

  activate(input, { currentDeviceId = null } = {}) {
    const code = String(input?.inviteCode || "").trim();
    const deviceId = String(input?.deviceId || "");
    if (!code || !ID.test(deviceId)) throw new Error("邀请码或设备编号无效");
    const store = this.read();
    const invite = store.invites.find((item) => item.code === code);
    if (!invite || invite.disabled || (invite.expiresAt && Date.parse(invite.expiresAt) <= Date.now())) {
      throw new Error("邀请码无效或已过期");
    }
    const existing = store.devices.find((item) => item.id === deviceId);
    if (existing && !existing.disabled && existing.inviteId === invite.id) {
      const token = randomToken();
      existing.tokenHash = hash(token); existing.lastSeenAt = now(); this.write(store);
      return { token, device: existing };
    }
    if (existing && !existing.disabled && currentDeviceId !== deviceId) {
      throw new Error("此设备已绑定其他账号；请先使用当前账号登录后再切换邀请码");
    }
    if (invite.usedDevices >= invite.maxDevices) {
      throw new Error("邀请码设备数量已满");
    }
    const token = randomToken();
    const device = {
      id: deviceId,
      userId: invite.userId,
      inviteId: invite.id,
      label: String(input.deviceName || existing?.label || "未命名设备").slice(0, 48),
      admin: invite.admin,
      disabled: false,
      tokenHash: hash(token),
      createdAt: existing?.createdAt || now(),
      lastSeenAt: now(),
    };
    if (existing) {
      store.devices[store.devices.indexOf(existing)] = device;
    } else {
      store.devices.push(device);
    }
    invite.usedDevices += 1;
    this.write(store);
    return { token, device };
  }

  publicInvite(invite) { const { code, userId, ...safe } = invite; return safe; }
  publicDevice(device) { const { tokenHash, ...safe } = device; return safe; }

  bootstrapEligible(legacyAuthorized) {
    if (!legacyAuthorized) return false;
    const store = this.read();
    if (!store.admin || store.devices.some((device) => device.admin && !device.disabled)) return false;
    return store.invites.some((invite) => invite.admin && !invite.disabled &&
      invite.usedDevices < invite.maxDevices && (!invite.expiresAt || Date.parse(invite.expiresAt) > Date.now()));
  }

  bootstrapInvite(legacyAuthorized) {
    if (!this.bootstrapEligible(legacyAuthorized)) throw new Error("本机初始化窗口已关闭");
    const store = this.read();
    const invite = store.invites.find((item) => item.admin && !item.disabled &&
      item.usedDevices < item.maxDevices && (!item.expiresAt || Date.parse(item.expiresAt) > Date.now()));
    if (!invite) throw new Error("未找到可用的管理员邀请码");
    return invite.code;
  }

  handle(req, res, url, principal, legacyAuthorized = false) {
    if (req.method === "GET" && url.pathname === "/auth/status") {
      this.sendJson(res, 200, { initialized: this.initialized(), authenticated: Boolean(principal), principal: principal || null,
        bootstrapEligible: this.bootstrapEligible(legacyAuthorized) }); return true;
    }
    if (req.method === "POST" && url.pathname === "/auth/activate") {
      this.readJsonBody(req, 8 * 1024, (error, body) => {
        try {
          if (error) throw error;
          const result = this.activate(body, { currentDeviceId: principal?.deviceId || null });
          const browser = req.headers["x-witt-client"] === "browser";
          const headers = browser ? {
            "Set-Cookie": `witt_session=${encodeURIComponent(result.token)}; Path=/vault-api/; Max-Age=31536000; HttpOnly; Secure; SameSite=Strict`,
          } : {};
          this.sendJson(res, 201, {
            ...(!browser ? { token: result.token } : {}),
            principal: this.publicDevice(result.device),
          }, headers);
        }
        catch (err) { this.sendJson(res, 400, { error: err.message || "无法激活设备" }); }
      }); return true;
    }
    if (req.method === "POST" && url.pathname === "/auth/bootstrap-invite") {
      try { this.sendJson(res, 200, { inviteCode: this.bootstrapInvite(legacyAuthorized) }); }
      catch (err) { this.sendJson(res, 403, { error: err.message || "本机初始化不可用" }); }
      return true;
    }
    if (!principal?.admin) return false;
    if (req.method === "GET" && url.pathname === "/admin/invites") { this.sendJson(res, 200, { invites: this.read().invites.map((item) => this.publicInvite(item)) }); return true; }
    if (req.method === "GET" && url.pathname === "/admin/devices") { this.sendJson(res, 200, { devices: this.read().devices.map((item) => this.publicDevice(item)) }); return true; }
    if (req.method === "POST" && url.pathname === "/admin/invites") {
      this.readJsonBody(req, 8 * 1024, (error, body) => { try { if (error) throw error; this.sendJson(res, 201, { invite: this.createInvite(body) }); } catch (err) { this.sendJson(res, 400, { error: err.message }); } }); return true;
    }
    const deviceMatch = url.pathname.match(/^\/admin\/devices\/([a-f0-9-]{36})\/disable$/);
    if (req.method === "POST" && deviceMatch) {
      const store = this.read(); const device = store.devices.find((item) => item.id === deviceMatch[1]);
      if (!device) { this.sendJson(res, 404, { error: "设备不存在" }); return true; }
      device.disabled = true; device.disabledAt = now(); this.write(store); this.sendJson(res, 200, { device: this.publicDevice(device) }); return true;
    }
    const policyMatch = url.pathname.match(/^\/admin\/users\/([a-f0-9-]{36})\/policy$/);
    if (req.method === "POST" && policyMatch) {
      this.readJsonBody(req, 8 * 1024, (error, body) => {
        try {
          if (error) throw error;
          const policy = this.setUserPolicy(policyMatch[1], body);
          this.sendJson(res, 200, { userId: policyMatch[1], policy });
        } catch (err) {
          this.sendJson(res, 400, { error: err.message || "无法更新用户权限" });
        }
      });
      return true;
    }
    return false;
  }
}

module.exports = { AuthService };
