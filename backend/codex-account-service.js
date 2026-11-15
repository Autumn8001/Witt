"use strict";

const fs = require("node:fs");
const { AppServerClient } = require("./app-server-client");

class CodexAccountService {
  constructor(options) {
    this.codexBin = options.codexBin;
    this.profiles = options.profiles;
    this.sendJson = options.sendJson;
    this.logins = new Map();
    for (const profile of Object.values(this.profiles)) {
      fs.mkdirSync(profile.codexHome, { recursive: true, mode: 0o700 });
    }
  }

  profile(id) {
    return this.profiles[String(id || "")] || null;
  }

  client(profile) {
    return new AppServerClient({
      codexBin: this.codexBin,
      cwd: profile.workDir,
      home: "/home/ubuntu",
      codexHome: profile.codexHome,
    });
  }

  publicAccount(profile, result) {
    const account = result?.account || null;
    return {
      id: profile.id,
      label: profile.label,
      workDir: profile.workDir,
      authenticated: Boolean(account),
      account: account ? {
        type: String(account.type || ""),
        email: account.email ? String(account.email) : "",
        planType: account.planType ? String(account.planType) : "",
      } : null,
      loginPending: this.logins.has(profile.id),
    };
  }

  async readProfile(profile) {
    const client = this.client(profile);
    try {
      await client.start();
      const result = await client.request("account/read", { refreshToken: false });
      return this.publicAccount(profile, result);
    } finally {
      client.close();
    }
  }

  async list(res, allowedProfileIds = null) {
    try {
      const accounts = [];
      const allowed = Array.isArray(allowedProfileIds) ? new Set(allowedProfileIds) : null;
      for (const profile of Object.values(this.profiles)
        .filter((item) => !allowed || allowed.has(item.id))) {
        try {
          accounts.push(await this.readProfile(profile));
        } catch (error) {
          const authRequired = /unauthori[sz]ed|\b401\b|token.*expired|invalid.*refresh/i.test(String(error.message || ""));
          accounts.push({ ...this.publicAccount(profile, null),
            authenticationRequired: authRequired,
            readError: authRequired ? "该账号授权已失效，请重新登录" : "该账号暂时无法读取，请稍后重试",
          });
        }
      }
      this.sendJson(res, 200, { accounts });
    } catch (error) {
      this.sendJson(res, 502, {
        error: `暂时无法读取 Codex 账号：${String(error.message || error).slice(0, 160)}`,
      });
    }
  }

  async startLogin(res, profileId) {
    const profile = this.profile(profileId);
    if (!profile || profile.id === "default") {
      this.sendJson(res, 404, { error: "Codex 账号配置不存在" });
      return;
    }
    const previous = this.logins.get(profile.id);
    if (previous) {
      this.sendJson(res, 200, previous.publicResult);
      return;
    }
    const client = this.client(profile);
    try {
      await client.start();
      const result = await client.request("account/login/start", {
        type: "chatgptDeviceCode",
      });
      const publicResult = {
        profile: profile.id,
        loginId: String(result.loginId || ""),
        verificationUrl: String(result.verificationUrl || ""),
        userCode: String(result.userCode || ""),
      };
      const login = { client, loginId: publicResult.loginId, publicResult, completed: false };
      this.logins.set(profile.id, login);
      client.on("notification", (method, params) => {
        if (method !== "account/login/completed" ||
            String(params?.loginId || "") !== login.loginId) return;
        login.completed = true;
        login.success = Boolean(params?.success);
        login.error = params?.error ? String(params.error) : "";
      });
      client.on("closed", () => {
        if (this.logins.get(profile.id) === login && !login.completed) {
          login.completed = true;
          login.success = false;
          login.error = "Codex 登录连接已关闭";
        }
      });
      this.sendJson(res, 200, publicResult);
    } catch (error) {
      client.close();
      this.sendJson(res, 502, {
        error: `无法启动子账号登录：${String(error.message || error).slice(0, 160)}`,
      });
    }
  }

  async loginStatus(res, profileId) {
    const profile = this.profile(profileId);
    if (!profile) {
      this.sendJson(res, 404, { error: "Codex 账号配置不存在" });
      return;
    }
    const login = this.logins.get(profile.id);
    if (login?.completed) {
      login.client.close();
      this.logins.delete(profile.id);
      if (!login.success) {
        this.sendJson(res, 200, { status: "failed", error: login.error || "登录未完成" });
        return;
      }
    }
    if (login && !login.completed) {
      this.sendJson(res, 200, { status: "pending" });
      return;
    }
    try {
      const account = await this.readProfile(profile);
      this.sendJson(res, 200, {
        status: account.authenticated ? "authenticated" : "signedOut",
        account,
      });
    } catch (error) {
      this.sendJson(res, 502, {
        error: `无法确认登录状态：${String(error.message || error).slice(0, 160)}`,
      });
    }
  }

  async cancelLogin(res, profileId) {
    const login = this.logins.get(profileId);
    if (!login) {
      this.sendJson(res, 200, { ok: true });
      return;
    }
    try {
      await login.client.request("account/login/cancel", { loginId: login.loginId });
    } catch {}
    login.client.close();
    this.logins.delete(profileId);
    this.sendJson(res, 200, { ok: true });
  }
}

module.exports = { CodexAccountService };
