"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { validUuid, validRootAlias } = require("./validation");

const STATES = new Set(["active", "paused", "closed"]);
const TRANSITIONS = { active: new Set(["paused", "closed"]), paused: new Set(["active", "closed"]), closed: new Set() };

class WorkspaceStoreError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function requireText(value, field, max = 255) {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) {
    throw new WorkspaceStoreError(`INVALID_${field.toUpperCase()}`);
  }
  return value;
}

function validateBinding(binding) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) throw new WorkspaceStoreError("INVALID_BINDING");
  const keys = ["workspace_id", "conversation_id", "customer_id", "device_id", "root_alias", "display_path", "harness_id", "model_id", "harness_session_id"];
  if (Object.keys(binding).length !== keys.length || Object.keys(binding).some((key) => !keys.includes(key))) {
    throw new WorkspaceStoreError("INVALID_BINDING");
  }
  if (!validUuid(binding.workspace_id)) throw new WorkspaceStoreError("INVALID_WORKSPACE_ID");
  if (!validUuid(binding.conversation_id)) throw new WorkspaceStoreError("INVALID_CONVERSATION_ID");
  return {
    workspace_id: binding.workspace_id.toLowerCase(),
    conversation_id: binding.conversation_id.toLowerCase(),
    customer_id: requireText(binding.customer_id, "customer_id", 100),
    device_id: requireText(binding.device_id, "device_id", 100),
    root_alias: validRootAlias(binding.root_alias) ? binding.root_alias : (() => { throw new WorkspaceStoreError("INVALID_ROOT_ALIAS"); })(),
    display_path: requireText(binding.display_path, "display_path", 1024),
    harness_id: requireText(binding.harness_id, "harness_id", 100),
    model_id: requireText(binding.model_id, "model_id", 200),
    harness_session_id: requireText(binding.harness_session_id, "harness_session_id", 200),
  };
}

function parseRow(row) {
  if (!row) return null;
  return {
    workspace_id: row.workspace_id, conversation_id: row.conversation_id,
    customer_id: row.customer_id, device_id: row.device_id, root_alias: row.root_alias,
    display_path: row.display_path, harness_id: row.harness_id, model_id: row.model_id,
    harness_session_id: row.harness_session_id, created_at: row.created_at,
    updated_at: row.updated_at, state: row.state,
  };
}

class WorkspaceStore {
  constructor(directory, options = {}) {
    if (typeof directory !== "string" || !directory) throw new WorkspaceStoreError("INVALID_DIRECTORY");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = path.join(directory, "remote-workspaces.sqlite");
    this.now = options.now || (() => new Date().toISOString());
    this.db = new DatabaseSync(this.file);
    try { fs.chmodSync(this.file, 0o600); } catch {}
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=NORMAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS remote_workspaces (
        workspace_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL UNIQUE,
        customer_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        root_alias TEXT NOT NULL,
        display_path TEXT NOT NULL,
        harness_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        harness_session_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'paused', 'closed'))
      );
      CREATE INDEX IF NOT EXISTS remote_workspaces_device_idx ON remote_workspaces(device_id, state);
    `);
    this.selectById = this.db.prepare("SELECT * FROM remote_workspaces WHERE workspace_id = ?");
    this.selectByConversation = this.db.prepare("SELECT * FROM remote_workspaces WHERE conversation_id = ?");
    this.insert = this.db.prepare(`INSERT INTO remote_workspaces (
      workspace_id, conversation_id, customer_id, device_id, root_alias, display_path,
      harness_id, model_id, harness_session_id, created_at, updated_at, state
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.updateState = this.db.prepare("UPDATE remote_workspaces SET state = ?, updated_at = ? WHERE workspace_id = ? AND state = ?");
    this.updateRuntime = this.db.prepare("UPDATE remote_workspaces SET harness_id = ?, model_id = ?, harness_session_id = ?, updated_at = ? WHERE workspace_id = ?");
  }

  create(binding) {
    const value = validateBinding(binding);
    if (this.selectById.get(value.workspace_id) || this.selectByConversation.get(value.conversation_id)) {
      throw new WorkspaceStoreError("IMMUTABLE_BINDING");
    }
    const now = this.now();
    this.insert.run(value.workspace_id, value.conversation_id, value.customer_id, value.device_id,
      value.root_alias, value.display_path, value.harness_id, value.model_id, value.harness_session_id,
      now, now, "active");
    return this.get(value.workspace_id);
  }

  get(workspaceId) {
    if (!validUuid(workspaceId)) throw new WorkspaceStoreError("INVALID_WORKSPACE_ID");
    return parseRow(this.selectById.get(workspaceId.toLowerCase()));
  }

  getByConversation(conversationId) {
    if (!validUuid(conversationId)) throw new WorkspaceStoreError("INVALID_CONVERSATION_ID");
    return parseRow(this.selectByConversation.get(conversationId.toLowerCase()));
  }

  setState(workspaceId, nextState) {
    const record = this.get(workspaceId);
    if (!record) throw new WorkspaceStoreError("WORKSPACE_NOT_FOUND");
    if (!STATES.has(nextState)) throw new WorkspaceStoreError("INVALID_STATE");
    if (record.state === nextState) return record;
    if (!TRANSITIONS[record.state].has(nextState)) throw new WorkspaceStoreError("INVALID_STATE_TRANSITION");
    this.updateState.run(nextState, this.now(), record.workspace_id, record.state);
    return this.get(record.workspace_id);
  }

  setRuntime(workspaceId, runtime) {
    const record = this.get(workspaceId);
    if (!record) throw new WorkspaceStoreError("WORKSPACE_NOT_FOUND");
    if (record.state !== "active") throw new WorkspaceStoreError("WORKSPACE_NOT_ACTIVE");
    const candidate = validateBinding({
      workspace_id: record.workspace_id, conversation_id: record.conversation_id,
      customer_id: record.customer_id, device_id: record.device_id,
      root_alias: record.root_alias, display_path: record.display_path,
      harness_id: runtime?.harness_id, model_id: runtime?.model_id,
      harness_session_id: runtime?.harness_session_id,
    });
    this.updateRuntime.run(candidate.harness_id, candidate.model_id, candidate.harness_session_id,
      this.now(), record.workspace_id);
    return this.get(record.workspace_id);
  }

  list() {
    return this.db.prepare("SELECT * FROM remote_workspaces ORDER BY updated_at DESC LIMIT 100").all().map(parseRow);
  }

  close() { this.db.close(); }
}

module.exports = { WorkspaceStore, WorkspaceStoreError, validateBinding, STATES };
