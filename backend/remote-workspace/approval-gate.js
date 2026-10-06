"use strict";

const { randomUUID } = require("node:crypto");
const { validUuid, stableIntentEquals } = require("./validation");

class ApprovalError extends Error { constructor(code) { super(code); this.code = code; } }

function cloneIntent(intent) {
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) throw new ApprovalError("INVALID_INTENT");
  const encoded = JSON.stringify(intent);
  if (encoded.length > 600 * 1024) throw new ApprovalError("INTENT_TOO_LARGE");
  return JSON.parse(encoded);
}

function freezeDeep(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeDeep(child);
  }
  return value;
}

class ApprovalGate {
  constructor(options = {}) {
    this.now = options.now || (() => Date.now());
    this.randomUUID = options.randomUUID || randomUUID;
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
    this.items = new Map();
  }

  create(workspaceId, intent, options = {}) {
    if (!validUuid(workspaceId)) throw new ApprovalError("INVALID_WORKSPACE_ID");
    const ttlMs = options.ttlMs ?? this.ttlMs;
    if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 30 * 60_000) throw new ApprovalError("INVALID_EXPIRY");
    const item = freezeDeep({
      id: this.randomUUID(), workspace_id: workspaceId.toLowerCase(), intent: cloneIntent(intent),
      created_at: this.now(), expires_at: this.now() + ttlMs, state: "pending",
    });
    this.items.set(item.id, item);
    return this.publicItem(item);
  }

  get(id, workspaceId) {
    const item = this.require(id, workspaceId);
    return this.publicItem(this.expire(item));
  }

  accept(id, workspaceId) { return this.transition(id, workspaceId, "accepted"); }
  reject(id, workspaceId) { return this.transition(id, workspaceId, "rejected"); }

  consume(id, workspaceId, intent) {
    const item = this.expire(this.require(id, workspaceId));
    if (item.state !== "accepted") throw new ApprovalError(item.state === "expired" ? "APPROVAL_EXPIRED" : "APPROVAL_NOT_ACCEPTED");
    if (!stableIntentEquals(item.intent, intent)) throw new ApprovalError("APPROVAL_INTENT_MISMATCH");
    const used = freezeDeep({ ...item, state: "consumed", consumed_at: this.now() });
    this.items.set(id, used);
    return this.publicItem(used);
  }

  require(id, workspaceId) {
    if (typeof id !== "string" || !validUuid(workspaceId)) throw new ApprovalError("INVALID_APPROVAL");
    const item = this.items.get(id);
    if (!item || item.workspace_id !== workspaceId.toLowerCase()) throw new ApprovalError("APPROVAL_NOT_FOUND");
    return item;
  }

  expire(item) {
    if (item.state === "pending" && this.now() >= item.expires_at) {
      const expired = freezeDeep({ ...item, state: "expired" });
      this.items.set(item.id, expired);
      return expired;
    }
    return item;
  }

  transition(id, workspaceId, state) {
    const item = this.expire(this.require(id, workspaceId));
    if (item.state !== "pending") throw new ApprovalError(item.state === "expired" ? "APPROVAL_EXPIRED" : "APPROVAL_ALREADY_RESOLVED");
    const next = freezeDeep({ ...item, state, resolved_at: this.now() });
    this.items.set(id, next);
    return this.publicItem(next);
  }

  publicItem(item) {
    return { id: item.id, workspace_id: item.workspace_id, intent: item.intent,
      created_at: item.created_at, expires_at: item.expires_at, state: item.state };
  }
}

module.exports = { ApprovalGate, ApprovalError };
