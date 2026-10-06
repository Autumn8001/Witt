"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { validUuid } = require("./validation");

class AuditStoreError extends Error { constructor(code) { super(code); this.code = code; } }

function nonSecretText(value, name, max) {
  if (typeof value !== "string" || !value || value.length > max || value.includes("\0")) throw new AuditStoreError(`INVALID_${name}`);
  return value;
}

class WorkspaceAuditStore {
  constructor(directory, options = {}) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = path.join(directory, "remote-workspace-audit.sqlite");
    this.now = options.now || (() => new Date().toISOString());
    this.db = new DatabaseSync(this.file);
    try { fs.chmodSync(this.file, 0o600); } catch {}
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=NORMAL;
      CREATE TABLE IF NOT EXISTS remote_workspace_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL, device_id TEXT NOT NULL, operation TEXT NOT NULL,
        path TEXT, category TEXT NOT NULL, duration_ms INTEGER NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS remote_workspace_audit_workspace_idx
        ON remote_workspace_audit(workspace_id, id DESC);
    `);
    this.insert = this.db.prepare(`INSERT INTO remote_workspace_audit
      (workspace_id, device_id, operation, path, category, duration_ms, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    this.listByWorkspace = this.db.prepare(`SELECT workspace_id, device_id, operation, path, category,
      duration_ms, status, created_at FROM remote_workspace_audit WHERE workspace_id = ? ORDER BY id DESC LIMIT ?`);
  }

  record(event) {
    if (!event || !validUuid(event.workspace_id)) throw new AuditStoreError("INVALID_WORKSPACE_ID");
    const deviceId = nonSecretText(event.device_id, "DEVICE_ID", 100);
    const operation = nonSecretText(event.operation, "OPERATION", 80);
    const category = nonSecretText(event.category, "CATEGORY", 20);
    const status = nonSecretText(event.status, "STATUS", 80);
    if (!Number.isInteger(event.duration_ms) || event.duration_ms < 0 || event.duration_ms > 86_400_000) throw new AuditStoreError("INVALID_DURATION");
    if (event.path !== null && event.path !== undefined && (typeof event.path !== "string" || event.path.length > 1024 || event.path.includes("\0"))) {
      throw new AuditStoreError("INVALID_PATH");
    }
    this.insert.run(event.workspace_id.toLowerCase(), deviceId, operation, event.path || null, category,
      event.duration_ms, status, this.now());
  }

  list(workspaceId, limit = 100) {
    if (!validUuid(workspaceId)) throw new AuditStoreError("INVALID_WORKSPACE_ID");
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new AuditStoreError("INVALID_LIMIT");
    return this.listByWorkspace.all(workspaceId.toLowerCase(), limit);
  }

  close() { this.db.close(); }
}

module.exports = { WorkspaceAuditStore, AuditStoreError };
