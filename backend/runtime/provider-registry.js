"use strict";

const fs = require("node:fs");
const path = require("node:path");

const PROTOCOLS = new Set([
  "openai-responses",
  "openai-chat-completions",
  "gemini-native",
  "xai-responses",
  "anthropic-messages",
]);

const SECRET_KEYS = ["apiKey", "token", "secret", "authorization", "password"];

function publicProvider(provider) {
  const copy = { ...provider };
  delete copy.secret;
  copy.secret_ref = provider.secret_ref || null;
  // "Configured" means the secret is resolvable: inline, or through the named
  // environment variable. The value itself is never returned.
  const resolvable = Boolean(provider.secret) ||
    Boolean(provider.secret_ref && process.env[provider.secret_ref]);
  copy.secret_configured = resolvable;
  copy.secret_display = resolvable ? "Configured" : "Missing";
  return copy;
}

class ProviderRegistry {
  constructor(options = {}) {
    this.file = options.file || null;
    this.providers = new Map();
    if (this.file && fs.existsSync(this.file)) this.load();
  }

  load() {
    const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
    for (const provider of parsed.providers || []) this.upsert(provider, { persist: false });
  }

  persist() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const body = {
      providers: [...this.providers.values()].map((provider) => ({ ...provider })),
    };
    fs.writeFileSync(this.file, JSON.stringify(body), { mode: 0o600 });
  }

  upsert(input, options = {}) {
    const id = String(input.id || "").trim();
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error("Provider id is invalid");
    if (!PROTOCOLS.has(input.protocol)) throw new Error("Provider protocol is invalid");
    const base = String(input.base_url || "");
    if (!/^https?:\/\//.test(base)) throw new Error("Provider base_url must be http(s)");
    if (/[?#].*(key|token|secret)=/i.test(base)) {
      throw new Error("Secrets must not be placed in the provider URL");
    }
    const provider = {
      id,
      name: String(input.name || id).slice(0, 80),
      type: String(input.type || "gateway"),
      base_url: base.replace(/\/$/, ""),
      protocol: input.protocol,
      secret_ref: input.secret_ref ? String(input.secret_ref) : null,
      secret: input.secret ? String(input.secret) : null,
      enabled: input.enabled !== false,
      health: input.health || "unknown",
      model_discovery: input.model_discovery || null,
      capabilities: input.capabilities || {},
      last_checked_at: input.last_checked_at || null,
      sticky: input.sticky !== false,
    };
    this.providers.set(id, provider);
    if (options.persist !== false) this.persist();
    return publicProvider(provider);
  }

  list() {
    return [...this.providers.values()].map(publicProvider);
  }

  get(id) {
    const provider = this.providers.get(id);
    return provider ? publicProvider(provider) : null;
  }

  secretFor(id) {
    const provider = this.providers.get(id);
    if (!provider) return null;
    // Prefer an inline secret, otherwise resolve the referenced environment
    // variable so the registry can use an existing server-side secret.
    if (provider.secret) return provider.secret;
    if (provider.secret_ref && process.env[provider.secret_ref]) {
      return process.env[provider.secret_ref];
    }
    return null;
  }

  async check(id, fetchImpl = globalThis.fetch) {
    const provider = this.providers.get(id);
    if (!provider) throw new Error("Provider not found");
    const discovery = provider.model_discovery || `${provider.base_url}/models`;
    const headers = {};
    const secret = this.secretFor(id);
    if (secret) headers.Authorization = `Bearer ${secret}`;
    try {
      const response = await fetchImpl(discovery, { headers });
      const payload = await response.json();
      const models = payload.data || payload.models || [];
      provider.health = response.ok ? "healthy" : "degraded";
      provider.last_checked_at = new Date().toISOString();
      provider.discovered_models = Array.isArray(models)
        ? models.map((model) => String(model.id || model.name || model)).filter(Boolean)
        : [];
      this.persist();
      return publicProvider(provider);
    } catch (error) {
      provider.health = "down";
      provider.last_checked_at = new Date().toISOString();
      provider.last_error = String(error.message || "health check failed").slice(0, 180);
      this.persist();
      return publicProvider(provider);
    }
  }

  static redact(value) {
    const text = JSON.stringify(value);
    return SECRET_KEYS.reduce((current, key) =>
      current.replace(new RegExp(`"${key}"\\s*:\\s*"[^"]*"`, "gi"), `"${key}":"Configured"`), text);
  }
}

module.exports = { ProviderRegistry, PROTOCOLS, publicProvider };
