"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ChatService } = require("../backend/chat-service");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "chloe-access-policy-"));

function make(options = {}) {
  return new ChatService({
    chatDir: path.join(root, options.name || "chat"),
    imageDir: path.join(root, options.name || "chat", "images"),
    dataDir: path.join(root, options.name || "chat", "files"),
    codexBin: "/bin/false",
    codexWorkDir: root,
    sendJson() {},
    readJsonBody() {},
    allowedModels: null,
    allowedAccessModes: options.allowedAccessModes,
    defaultAccessMode: options.defaultAccessMode,
  });
}

try {
  const member = make({
    name: "member",
    allowedAccessModes: ["read-only", "workspace-write"],
    defaultAccessMode: "workspace-write",
  });
  assert.equal(member.createConversation().accessMode, "workspace-write");
  assert.equal(member.createConversation("read only", undefined, undefined, "read-only").accessMode,
    "read-only");
  assert.throws(
    () => member.createConversation("forbidden", undefined, undefined, "danger-full-access"),
    /不能使用这个访问权限/,
  );
  assert.equal(member.accessModeAllowed("danger-full-access"), false);

  const admin = make({ name: "admin", defaultAccessMode: "danger-full-access" });
  assert.equal(admin.createConversation().accessMode, "danger-full-access");
  assert.equal(admin.createConversation("safe", undefined, undefined, "workspace-write").accessMode,
    "workspace-write");
  console.log("access policy checks passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
