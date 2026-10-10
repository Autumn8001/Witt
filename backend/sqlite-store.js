"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

class ConversationStore {
  constructor(directory, options = {}) {
    this.directory = directory;
    this.file = path.join(directory, "conversations.sqlite");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.file);
    try { fs.chmodSync(this.file, 0o600); } catch {}
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=NORMAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        updated_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        position INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (conversation_id, id)
      );
      CREATE INDEX IF NOT EXISTS conversations_updated_idx
        ON conversations(updated_at DESC);
      CREATE INDEX IF NOT EXISTS messages_position_idx
        ON messages(conversation_id, position);
      CREATE INDEX IF NOT EXISTS messages_id_idx ON messages(id);
    `);
    this.selectConversation = this.db.prepare(
      "SELECT payload_json FROM conversations WHERE id = ?");
    this.selectMessages = this.db.prepare(
      "SELECT payload_json FROM messages WHERE conversation_id = ? ORDER BY position");
    this.selectIds = this.db.prepare("SELECT id FROM conversations ORDER BY updated_at DESC");
    this.selectMetadata = this.db.prepare(
      "SELECT id, payload_json FROM conversations ORDER BY updated_at DESC");
    this.selectMessagePage = this.db.prepare(`
      SELECT position, payload_json FROM messages
      WHERE conversation_id = ? AND position < ? ORDER BY position DESC LIMIT ?`);
    this.selectSummary = this.db.prepare(`
      SELECT COUNT(*) AS totalMessages,
        COALESCE(MAX(CASE WHEN json_extract(payload_json, '$.role') = 'assistant'
          AND json_extract(payload_json, '$.status') IN ('queued', 'running') THEN 1 ELSE 0 END), 0) AS busy,
        COALESCE(MAX(CASE WHEN json_array_length(payload_json, '$.attachments') > 0
          OR json_array_length(payload_json, '$.artifacts') > 0 THEN 1 ELSE 0 END), 0) AS hasAttachments
      FROM messages WHERE conversation_id = ?`);
    this.selectLastMessage = this.db.prepare(`
      SELECT json_extract(payload_json, '$.text') AS text FROM messages
      WHERE conversation_id = ? ORDER BY position DESC LIMIT 1`);
    this.selectLastAssistant = this.db.prepare(`
      SELECT json_extract(payload_json, '$.status') AS status,
        EXISTS(SELECT 1 FROM json_each(messages.payload_json, '$.stream') entry
          WHERE json_extract(entry.value, '$.kind') = 'approval'
            AND json_extract(entry.value, '$.status') = 'pending') AS awaitingConfirmation
      FROM messages WHERE conversation_id = ? AND json_extract(payload_json, '$.role') = 'assistant'
      ORDER BY position DESC LIMIT 1`);
    this.searchMessages = this.db.prepare(`
      SELECT conversation_id, id, json_extract(payload_json, '$.text') AS text
      FROM messages WHERE instr(lower(COALESCE(json_extract(payload_json, '$.text'), '')), lower(?)) > 0
      ORDER BY conversation_id, position DESC`);
    this.selectMessageIds = this.db.prepare(
      "SELECT id FROM messages WHERE conversation_id = ?");
    this.selectMessageConversation = this.db.prepare(
      "SELECT conversation_id FROM messages WHERE id = ?");
    this.upsertConversation = this.db.prepare(`
      INSERT INTO conversations (id, updated_at, payload_json) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,
        payload_json=excluded.payload_json
      WHERE conversations.updated_at != excluded.updated_at
        OR conversations.payload_json != excluded.payload_json`);
    this.upsertMessage = this.db.prepare(`
      INSERT INTO messages (conversation_id, id, position, payload_json) VALUES (?, ?, ?, ?)
      ON CONFLICT(conversation_id, id) DO UPDATE SET position=excluded.position,
        payload_json=excluded.payload_json
      WHERE messages.position != excluded.position OR messages.payload_json != excluded.payload_json`);
    this.deleteMessage = this.db.prepare(
      "DELETE FROM messages WHERE conversation_id = ? AND id = ?");
    // Chat updates arrive as a burst of fine-grained app-server notifications. Persisting the
    // complete conversation for every notification makes long threads monopolize Node's event
    // loop. Keep the live object in memory and coalesce disk writes per conversation instead.
    this.cache = new Map();
    this.cacheAccess = new Map();
    this.cacheSizes = new Map();
    this.legacySummaries = new Map();
    this.pendingSaves = new Map();
    this.saveDelayMs = 1_000;
    this.maxCachedConversations = options.maxCachedConversations ?? 16;
    this.maxCacheBytes = options.maxCacheBytes ?? 64 * 1024 * 1024;
    this.cacheIdleMs = options.cacheIdleMs ?? 10 * 60 * 1_000;
  }

  load(id, { forceFresh = false } = {}) {
    if (!forceFresh && this.cache.has(id)) {
      this.cacheAccess.set(id, Date.now());
      this.pruneCache(id);
      return this.cache.get(id);
    }
    this.evict(id);
    const row = this.selectConversation.get(id);
    if (!row) return null;
    try {
      const conversation = JSON.parse(row.payload_json);
      delete conversation._storageSummary;
      const rows = this.selectMessages.all(id);
      conversation.messages = rows.map((message) => JSON.parse(message.payload_json));
      this.cache.set(id, conversation);
      this.cacheAccess.set(id, Date.now());
      this.cacheSizes.set(id, Buffer.byteLength(row.payload_json) +
        rows.reduce((size, message) => size + Buffer.byteLength(message.payload_json), 0));
      this.pruneCache(id);
      return conversation;
    } catch {
      return null;
    }
  }

  persist(conversation, { transaction = true } = {}) {
    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    const metadata = { ...conversation };
    delete metadata.messages;
    metadata._storageSummary = this.summarize(conversation);
    let bytes = 0;
    if (transaction) this.db.exec("BEGIN IMMEDIATE");
    try {
      const metadataJson = JSON.stringify(metadata);
      bytes += Buffer.byteLength(metadataJson);
      this.upsertConversation.run(conversation.id, conversation.updatedAt || "", metadataJson);
      const currentIds = new Set(messages.map((message) => message.id));
      for (const row of this.selectMessageIds.all(conversation.id)) {
        if (!currentIds.has(row.id)) this.deleteMessage.run(conversation.id, row.id);
      }
      messages.forEach((message, position) => {
        const payload = JSON.stringify(message);
        bytes += Buffer.byteLength(payload);
        this.upsertMessage.run(conversation.id, message.id, position, payload);
      });
      if (transaction) this.db.exec("COMMIT");
      this.cacheSizes.set(conversation.id, bytes);
      this.legacySummaries.delete(conversation.id);
    } catch (error) {
      if (transaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  save(conversation, { immediate = false } = {}) {
    this.cache.set(conversation.id, conversation);
    this.cacheAccess.set(conversation.id, Date.now());
    const pending = this.pendingSaves.get(conversation.id);
    if (pending) {
      pending.conversation = conversation;
      if (!immediate) return;
      clearTimeout(pending.timer);
      this.pendingSaves.delete(conversation.id);
    }
    if (immediate) {
      this.persist(conversation);
      this.pruneCache(conversation.id);
      return;
    }
    const entry = { conversation, timer: null };
    entry.timer = setTimeout(() => {
      this.pendingSaves.delete(conversation.id);
      try {
        this.persist(entry.conversation);
        this.pruneCache();
      } catch (error) {
        console.error(`Failed to persist conversation ${conversation.id}:`, error);
        this.save(entry.conversation);
      }
    }, this.saveDelayMs);
    entry.timer.unref();
    this.pendingSaves.set(conversation.id, entry);
    this.pruneCache(conversation.id);
  }

  evict(id) {
    if (!id) return;
    if (this.pendingSaves.has(id)) {
      const pending = this.pendingSaves.get(id);
      clearTimeout(pending.timer);
      this.pendingSaves.delete(id);
    }
    this.cache.delete(id);
    this.cacheAccess.delete(id);
    this.cacheSizes.delete(id);
    this.legacySummaries.delete(id);
  }

  patchMessages(id, messages, metadata = {}) {
    return this.mutate(id, (conversation) => {
      const updates = new Map(messages.map((message) => [message.id, message]));
      conversation.messages = conversation.messages.map((message) => updates.get(message.id) || message);
      for (const key of ["harnessSessionId", "harnessId", "providerId", "remoteWorkspaceStarted"]) {
        if (Object.hasOwn(metadata, key)) conversation[key] = metadata[key];
      }
      return conversation;
    });
  }

  // Read and patch under the same SQLite write lock. The Worker owns its current
  // turn; the web process may concurrently append other messages to this thread.
  mutate(id, update) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const conversation = this.load(id, { forceFresh: true });
      if (!conversation) { this.db.exec("COMMIT"); return null; }
      const result = update(conversation);
      result.updatedAt = new Date().toISOString();
      this.persist(result, { transaction: false });
      this.db.exec("COMMIT");
      this.evict(id);
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      this.evict(id);
      throw error;
    }
  }

  summarize(conversation) {
    const messages = conversation.messages || [];
    const assistant = messages.findLast((message) => message.role === "assistant");
    return {
      totalMessages: messages.length,
      busy: messages.some((message) => message.role === "assistant" &&
        ["queued", "running"].includes(message.status)),
      lastMessage: messages.at(-1)?.text || "",
      hasAttachments: messages.some((message) => message.attachments?.length || message.artifacts?.length),
      lastAssistantStatus: assistant?.status || null,
      awaitingConfirmation: Boolean(assistant?.stream?.some((entry) =>
        entry.kind === "approval" && entry.status === "pending")),
    };
  }

  // Live conversation objects are intentionally mutable. Flush inactive entries before
  // eviction, including edits callers made before save(); pending/active objects stay pinned.
  pruneCache(protectedId = null) {
    let bytes = [...this.cacheSizes.values()].reduce((sum, value) => sum + value, 0);
    const now = Date.now();
    const entries = [...this.cache.keys()].sort((a, b) =>
      (this.cacheAccess.get(a) || 0) - (this.cacheAccess.get(b) || 0));
    for (const id of entries) {
      if (id === protectedId || this.pendingSaves.has(id)) continue;
      if (this.cache.size <= this.maxCachedConversations && bytes <= this.maxCacheBytes &&
          now - (this.cacheAccess.get(id) || now) < this.cacheIdleMs) continue;
      const conversation = this.cache.get(id);
      if (conversation.messages?.some((message) => ["queued", "running"].includes(message.status))) continue;
      const previousBytes = this.cacheSizes.get(id) || 0;
      try { this.persist(conversation); } catch { continue; }
      bytes -= previousBytes;
      this.cache.delete(id);
      this.cacheAccess.delete(id);
      this.cacheSizes.delete(id);
    }
  }

  metadata(conversation) {
    const { messages, _storageSummary, ...metadata } = conversation;
    let summary = messages ? this.summarize(conversation) : _storageSummary;
    if (!summary) {
      summary = this.legacySummaries.get(conversation.id);
      if (!summary) {
        const row = this.selectSummary.get(conversation.id);
        const assistant = this.selectLastAssistant.get(conversation.id);
        summary = { ...row, busy: Boolean(row.busy), hasAttachments: Boolean(row.hasAttachments),
          lastMessage: this.selectLastMessage.get(conversation.id)?.text || "",
          lastAssistantStatus: assistant?.status || null,
          awaitingConfirmation: Boolean(assistant?.awaitingConfirmation) };
        this.legacySummaries.set(conversation.id, summary);
      }
    }
    return { ...metadata, ...summary };
  }

  listMetadata() {
    const values = new Map();
    for (const row of this.selectMetadata.all()) {
      try { values.set(row.id, this.metadata(this.cache.get(row.id) || JSON.parse(row.payload_json))); }
      catch { /* A malformed legacy row should not hide other conversations. */ }
    }
    for (const [id, conversation] of this.cache) values.set(id, this.metadata(conversation));
    this.pruneCache();
    return [...values.values()].sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  }

  loadPage(id, { before, limit = 50 } = {}) {
    const cached = this.cache.get(id);
    const row = cached ? null : this.selectConversation.get(id);
    if (!cached && !row) return null;
    const metadata = this.metadata(cached || JSON.parse(row.payload_json));
    const count = metadata.totalMessages;
    const end = before == null ? count : Math.max(0, Math.min(count, Math.floor(Number(before) || 0)));
    const size = Math.max(1, Math.min(100, Math.floor(Number(limit) || 50)));
    const rows = cached ? null : this.selectMessagePage.all(id, end, size).reverse();
    const messages = cached ? cached.messages.slice(Math.max(0, end - size), end)
      : rows.map((item) => JSON.parse(item.payload_json));
    const offset = cached ? Math.max(0, end - size) : (rows[0]?.position ?? end);
    return { ...metadata, messages, messageOffset: offset, totalMessages: count, hasMore: offset > 0 };
  }

  search(query, { limit = 50, attachmentsOnly = false } = {}) {
    const needle = String(query || "").trim().slice(0, 500);
    const matches = new Map();
    if (needle) {
      for (const row of this.searchMessages.iterate(needle)) {
        // Cached objects are authoritative while a coalesced save is pending.
        if (!this.cache.has(row.conversation_id) && !matches.has(row.conversation_id)) {
          matches.set(row.conversation_id, { matchingMessageId: row.id, snippet: this.snippet(row.text, needle) });
        }
      }
      for (const [id, conversation] of this.cache) {
        const message = conversation.messages?.findLast((item) => String(item.text || "").toLowerCase().includes(needle.toLowerCase()));
        if (message) matches.set(id, { matchingMessageId: message.id, snippet: this.snippet(message.text, needle) });
      }
    }
    return this.listMetadata().filter((item) => (!attachmentsOnly || item.hasAttachments) &&
      (!needle || String(item.title || "").toLowerCase().includes(needle.toLowerCase()) || matches.has(item.id)))
      .slice(0, Math.max(1, Math.min(200, Number(limit) || 50)))
      .map((item) => ({ ...item, ...(matches.get(item.id) || {}) }));
  }

  snippet(text, query) {
    const value = String(text || "");
    const index = value.toLowerCase().indexOf(query.toLowerCase());
    const start = Math.max(0, index - 60);
    return `${start ? "…" : ""}${value.slice(start, start + 200)}${value.length > start + 200 ? "…" : ""}`;
  }

  findConversationIdByMessageId(messageId) {
    for (const [id, conversation] of this.cache) {
      if (conversation.messages?.some((message) => message.id === messageId)) return id;
    }
    // Cached conversations may have been rolled back since their last disk write.
    for (const row of this.selectMessageConversation.all(messageId)) {
      if (!this.cache.has(row.conversation_id)) return row.conversation_id;
    }
    return null;
  }

  close() {
    for (const entry of this.pendingSaves.values()) clearTimeout(entry.timer);
    for (const conversation of this.cache.values()) this.persist(conversation);
    this.pendingSaves.clear();
    this.db.close();
    this.cache.clear();
    this.cacheAccess.clear();
    this.cacheSizes.clear();
    this.legacySummaries.clear();
  }

  all() {
    const ids = new Set([
      ...this.selectIds.all().map((row) => row.id),
      ...this.cache.keys(),
    ]);
    return [...ids].map((id) => this.load(id)).filter(Boolean);
  }

  importJsonFiles() {
    if (this.selectIds.all().length) return 0;
    let imported = 0;
    for (const name of fs.readdirSync(this.directory)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      try {
        this.save(JSON.parse(fs.readFileSync(path.join(this.directory, name), "utf8")),
          { immediate: true });
        imported += 1;
      } catch {}
    }
    return imported;
  }
}

class AuthStore {
  constructor(directory) {
    this.file = path.join(directory, "auth.sqlite");
    this.db = new DatabaseSync(this.file);
    try { fs.chmodSync(this.file, 0o600); } catch {}
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS auth_state (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        updated_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
    `);
    this.select = this.db.prepare("SELECT payload_json FROM auth_state WHERE singleton = 1");
    this.upsert = this.db.prepare(`
      INSERT INTO auth_state (singleton, updated_at, payload_json) VALUES (1, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET updated_at=excluded.updated_at,
        payload_json=excluded.payload_json`);
  }

  load() {
    const row = this.select.get();
    if (!row) return null;
    try { return JSON.parse(row.payload_json); } catch { return null; }
  }

  save(value) {
    this.upsert.run(new Date().toISOString(), JSON.stringify(value));
  }
}

module.exports = { AuthStore, ConversationStore };
