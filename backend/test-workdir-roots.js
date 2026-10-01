"use strict";

// Regression suite for workspace root validation.
//
// The production bug: normalizeWorkDir used a hardcoded allowlist
// (["/home/ubuntu", "/data/drop-vault", "/data/xuanyu-build-console"]) and ignored
// the operator's configured DROP_VAULT_CODEX_WORKDIR, so every deployment whose
// project directory lived elsewhere could not create a session at all.
//
// These tests construct a real ChatService and call normalizeWorkDir, so the
// original failure is reproduced rather than mocked.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ChatService } = require("./chat-service");

const savedRoots = process.env.WITT_WORKDIR_ROOTS;

function makeService(workDir) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "witt-workdir-"));
  return new ChatService({
    chatDir: path.join(root, "chat"),
    imageDir: path.join(root, "images"),
    dataDir: path.join(root, "files"),
    codexBin: "/bin/false",
    codexWorkDir: workDir,
    sendJson() {},
    readJsonBody() {},
    codexProfiles: {
      default: { id: "default", label: "test", codexHome: path.join(root, "codex"), workDir },
    },
  });
}

function withWorkspace() {
  // A configured workspace root that is deliberately NOT one of the hardcoded
  // upstream roots, mirroring the real server (/root/witt-grok-work).
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "witt-ws-"));
  const project = path.join(workspace, "project-a");
  fs.mkdirSync(project);
  return { workspace, project, service: makeService(workspace) };
}

test.after(() => {
  if (savedRoots === undefined) delete process.env.WITT_WORKDIR_ROOTS;
  else process.env.WITT_WORKDIR_ROOTS = savedRoots;
});

test("T-WORKDIR-01 the configured workspace root itself is allowed", () => {
  delete process.env.WITT_WORKDIR_ROOTS;
  const { workspace, service } = withWorkspace();
  assert.equal(service.normalizeWorkDir(workspace), fs.realpathSync(workspace));
});

test("T-WORKDIR-02 a child project under the configured root is allowed", () => {
  delete process.env.WITT_WORKDIR_ROOTS;
  const { project, service } = withWorkspace();
  assert.equal(service.normalizeWorkDir(project), fs.realpathSync(project));
});

test("T-WORKDIR-03 the parent of the configured root is rejected", () => {
  delete process.env.WITT_WORKDIR_ROOTS;
  const { workspace, service } = withWorkspace();
  assert.throws(() => service.normalizeWorkDir(path.dirname(workspace)),
    /不在 Witt 允许的工作目录范围内/);
});

test("T-WORKDIR-04 path traversal out of the root is rejected", () => {
  delete process.env.WITT_WORKDIR_ROOTS;
  const { workspace, service } = withWorkspace();
  assert.throws(() => service.normalizeWorkDir(path.join(workspace, "..")),
    /不在 Witt 允许的工作目录范围内/);
  assert.throws(() => service.normalizeWorkDir(path.join(workspace, "..", "..")),
    /不在 Witt 允许的工作目录范围内/);
  assert.throws(() => service.normalizeWorkDir(`${workspace}${path.sep}..${path.sep}elsewhere`),
    /不在 Witt 允许的工作目录范围内/);
});

test("T-WORKDIR-05 an unrelated absolute path is rejected", () => {
  delete process.env.WITT_WORKDIR_ROOTS;
  const { service } = withWorkspace();
  const unrelated = fs.mkdtempSync(path.join(os.tmpdir(), "witt-outside-"));
  assert.throws(() => service.normalizeWorkDir(unrelated), /不在 Witt 允许的工作目录范围内/);
  // Sensitive locations that must never become a workspace.
  for (const candidate of ["/etc", "/root/.ssh", "/var/lib", "/"]) {
    assert.throws(() => service.normalizeWorkDir(candidate), /不在 Witt 允许的工作目录范围内/);
  }
});

test("T-WORKDIR-06 an extra root from the environment is honoured", () => {
  const extra = fs.mkdtempSync(path.join(os.tmpdir(), "witt-extra-"));
  const nested = path.join(extra, "nested");
  fs.mkdirSync(nested);
  process.env.WITT_WORKDIR_ROOTS = extra;
  try {
    const { service } = withWorkspace();
    assert.equal(service.normalizeWorkDir(extra), fs.realpathSync(extra));
    assert.equal(service.normalizeWorkDir(nested), fs.realpathSync(nested));
  } finally {
    delete process.env.WITT_WORKDIR_ROOTS;
  }
});

test("T-WORKDIR-07 a symlink escaping the root cannot bypass the restriction", (t) => {
  delete process.env.WITT_WORKDIR_ROOTS;
  const { workspace, service } = withWorkspace();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "witt-secret-"));
  const link = path.join(workspace, "escape");
  try {
    fs.symlinkSync(outside, link, "dir");
  } catch (error) {
    // Windows without developer mode cannot create symlinks; say so instead of
    // pretending the check passed.
    t.skip(`symlink unavailable on this host: ${error.code}`);
    return;
  }
  assert.throws(() => service.normalizeWorkDir(link), /不在 Witt 允许的工作目录范围内/);
});

test("T-WORKDIR-08 relative and missing paths are rejected", () => {
  delete process.env.WITT_WORKDIR_ROOTS;
  const { workspace, service } = withWorkspace();
  assert.throws(() => service.normalizeWorkDir("relative/project"), /必须是绝对路径/);
  assert.throws(() => service.normalizeWorkDir(path.join(workspace, "does-not-exist")),
    /项目路径不存在/);
  // An empty value means "use the default", not an error.
  assert.equal(service.normalizeWorkDir(""), null);
});

test("T-WORKDIR-09 a prefix-similar sibling directory is not treated as inside", () => {
  delete process.env.WITT_WORKDIR_ROOTS;
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "witt-ws-"));
  const project = path.join(workspace, "project-a");
  fs.mkdirSync(project);
  const service = makeService(workspace);
  // "project-ab" shares a prefix with "project-a" but is outside the workspace.
  const sibling = fs.mkdtempSync(path.join(path.dirname(workspace), "witt-ws-evil-"));
  assert.throws(() => service.normalizeWorkDir(sibling), /不在 Witt 允许的工作目录范围内/);
  assert.equal(service.normalizeWorkDir(project), fs.realpathSync(project));
});
