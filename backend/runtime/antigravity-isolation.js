"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// Identity comes from the authenticated principal, never from a model/tool argument.
function antigravityIsolation(userId) {
  if (!userId) throw new Error("ANTIGRAVITY_USER_REQUIRED");
  const scope = crypto.createHash("sha256").update(String(userId)).digest("hex").slice(0, 32);
  const root = `/var/lib/chloe-antigravity-${scope}`;
  return Object.freeze({ scope, root, workspace: `${root}/workspace`, inputDirectory: `/run/chloe-antigravity-inputs/${scope}` });
}

function ensureWorkspace(isolation) {
  if (fs.existsSync(isolation.workspace) && fs.lstatSync(isolation.workspace).isSymbolicLink())
    throw new Error("ANTIGRAVITY_WORKSPACE_SYMLINK_REFUSED");
  fs.mkdirSync(isolation.workspace, { recursive: true, mode: 0o700 });
  const root = fs.realpathSync(isolation.root);
  const workspace = fs.realpathSync(isolation.workspace);
  if (path.dirname(workspace) !== root) throw new Error("ANTIGRAVITY_WORKSPACE_OUTSIDE_USER_SCOPE");
  return isolation.workspace;
}

function stageAntigravityAttachments(isolation, files) {
  if (!isolation || !files.length) return files;
  // The writable workspace is untrusted: never copy as root into a user-chosen
  // symlink. This parent is root-only; systemd binds just this user's subtree RO.
  fs.mkdirSync("/run/chloe-antigravity-inputs", { recursive: true, mode: 0o700 });
  fs.mkdirSync(isolation.inputDirectory, { recursive: true, mode: 0o755 });
  const id = crypto.randomUUID();
  const directory = path.join(isolation.inputDirectory, id);
  fs.mkdirSync(directory, { mode: 0o755 });
  return files.map(file => {
    const destination = path.join(directory, crypto.randomUUID() + path.extname(file.path).slice(0, 18));
    fs.copyFileSync(file.path, destination, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(destination, 0o444);
    return { ...file, path: `/inputs/${id}/${path.basename(destination)}` };
  });
}

module.exports = { antigravityIsolation, ensureWorkspace, stageAntigravityAttachments };
