"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const { createGitChangeBaseline, collectGitChanges, eligiblePath, redactDiff } = require("./git-change-collector");

function git(cwd, ...args) {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
}
function makeRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "witt-git-diff-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "Witt test");
  git(root, "config", "user.email", "witt-test@example.invalid");
  fs.writeFileSync(path.join(root, "clean.txt"), "before\n");
  fs.writeFileSync(path.join(root, "updated.txt"), "old tracked value\n");
  fs.writeFileSync(path.join(root, "rename-source.txt"), "rename me\n");
  fs.writeFileSync(path.join(root, "deleted.txt"), "remove me\n");
  git(root, "add", "clean.txt", "updated.txt", "rename-source.txt", "deleted.txt");
  git(root, "commit", "-qm", "baseline");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("collector excludes preexisting edits and returns turn additions, edits, deletes and renames", async (t) => {
  const root = makeRepo(t);
  fs.writeFileSync(path.join(root, "clean.txt"), "preexisting user edit\n");
  fs.writeFileSync(path.join(root, "before-turn.txt"), "already here\n");
  const baseline = await createGitChangeBaseline(root);

  fs.writeFileSync(path.join(root, "new-file.txt"), "new content\n");
  fs.writeFileSync(path.join(root, "staged-file.txt"), "staged content\n");
  git(root, "add", "staged-file.txt");
  fs.writeFileSync(path.join(root, "updated.txt"), "updated value\n");
  git(root, "mv", "rename-source.txt", "rename-target.txt");
  fs.unlinkSync(path.join(root, "deleted.txt"));

  const result = await collectGitChanges(baseline);
  const byPath = new Map(result.changes.map((change) => [change.path, change]));
  assert.equal(byPath.has("clean.txt"), false, "pre-turn modified path is excluded");
  assert.equal(byPath.has("before-turn.txt"), false, "pre-turn untracked path is excluded");
  assert.equal(byPath.get("new-file.txt")?.kind, "untracked");
  assert.equal(byPath.get("new-file.txt")?.status, "U");
  assert.equal(byPath.get("updated.txt")?.kind, "update");
  assert.match(byPath.get("new-file.txt").diff, /new content/);
  assert.equal(byPath.get("staged-file.txt")?.kind, "add");
  assert.equal(byPath.get("staged-file.txt")?.status, "A");
  assert.equal(byPath.get("deleted.txt")?.kind, "delete");
  assert.equal(byPath.get("deleted.txt")?.afterHash, null);
  assert.equal(byPath.get("rename-target.txt")?.kind, "rename");
  assert.match(byPath.get("rename-target.txt").afterHash, /^[a-f0-9]{64}$/);
  assert.match(byPath.get("new-file.txt").afterHash, /^[a-f0-9]{64}$/);
  assert.match(byPath.get("staged-file.txt").afterHash, /^[a-f0-9]{64}$/);
  assert.equal(byPath.get("rename-target.txt")?.oldPath, "rename-source.txt");
});

test("collector marks binary and large files without inlining their contents", async (t) => {
  const root = makeRepo(t);
  const baseline = await createGitChangeBaseline(root);
  fs.writeFileSync(path.join(root, "image.bin"), Buffer.from([0, 1, 2, 3]));
  fs.writeFileSync(path.join(root, "large.txt"), "x".repeat(1024 * 1024 + 10));
  const result = await collectGitChanges(baseline);
  const binary = result.changes.find((change) => change.path === "image.bin");
  const large = result.changes.find((change) => change.path === "large.txt");
  assert.equal(binary.binary, true);
  assert.equal(binary.diff, "二进制文件，未显示文本 Diff");
  assert.equal(large.binary, false);
  assert.equal(large.truncated, true);
  assert.doesNotMatch(large.diff, /x{100}/);
});

test("secret paths are filtered and per-turn output is bounded", async (t) => {
  const root = makeRepo(t);
  const baseline = await createGitChangeBaseline(root);
  fs.writeFileSync(path.join(root, ".env.local"), "PRIVATE=do-not-show\n");
  fs.writeFileSync(path.join(root, "private.pem"), "private material\n");
  fs.writeFileSync(path.join(root, "secret.json"), "private material\n");
  fs.writeFileSync(path.join(root, "long.txt"), "line\n".repeat(100));
  assert.equal(eligiblePath("config/secret.json"), false);
  assert.equal(eligiblePath(".env.local"), false);
  fs.writeFileSync(path.join(root, "safe-config.txt"), "api_key = should-not-render\npassword: hidden-value\n");
  const result = await collectGitChanges(baseline, { maxTotalDiffBytes: 2048, maxFiles: 10 });
  assert.equal(result.changes.some((change) => change.path.includes(".env")), false);
  assert.equal(result.changes.some((change) => change.path.endsWith(".pem")), false);
  assert.equal(result.changes.some((change) => change.path === "secret.json"), false);
  assert.ok(result.changes.length <= 10);
  assert.ok(result.changes.every((change) => change.diff.length < 2048));
  const safeConfig = result.changes.find((change) => change.path === "safe-config.txt");
  assert.match(safeConfig.diff, /\[REDACTED\]/);
  assert.doesNotMatch(safeConfig.diff, /should-not-render|hidden-value/);
  const bounded = await collectGitChanges(baseline, { maxTotalDiffBytes: 48, maxFiles: 2 });
  assert.ok(bounded.changes.length <= 2);
  assert.ok(bounded.changes.every((change) => change.diff.length < 256));
});


test("collector reports the delta on a preexisting dirty path and hashes the final file", async (t) => {
  const root = makeRepo(t);
  fs.writeFileSync(path.join(root, "clean.txt"), "preexisting value\n");
  const baseline = await createGitChangeBaseline(root);
  fs.writeFileSync(path.join(root, "clean.txt"), "turn value\n");
  const result = await collectGitChanges(baseline);
  const change = result.changes.find((entry) => entry.path === "clean.txt");
  assert.equal(change.baselineDirty, true);
  assert.match(change.afterHash, /^[a-f0-9]{64}$/);
  assert.match(change.diff, /preexisting value/);
  assert.match(change.diff, /turn value/);
});


test("baseline snapshots obey per-file and total byte caps and expose omissions", async (t) => {
  const root = makeRepo(t);
  fs.writeFileSync(path.join(root, "oversize-dirty.txt"), "x".repeat(8 * 1024 * 1024 + 1));
  const baseline = await createGitChangeBaseline(root);
  assert.equal(baseline.baselineUnavailable, 1);
  assert.equal(baseline.preexistingSnapshots.get("oversize-dirty.txt").unavailable, true);
  assert.ok(baseline.snapshotBytes <= 16 * 1024 * 1024);
});

test("symlinks that leave the worktree are never read into a file diff", async (t) => {
  const root = makeRepo(t);
  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.txt`);
  fs.writeFileSync(outside, "OUTSIDE-CONTENT-MUST-NOT-APPEAR\n");
  t.after(() => fs.rmSync(outside, { force: true }));
  const baseline = await createGitChangeBaseline(root);
  fs.symlinkSync(outside, path.join(root, "escape.txt"));
  const result = await collectGitChanges(baseline);
  const change = result.changes.find((entry) => entry.path === "escape.txt");
  assert.equal(change.binary, true);
  assert.equal(change.afterHashUnavailable, true);
  assert.doesNotMatch(change.diff, /OUTSIDE-CONTENT/);
});

test("collector includes files committed after the turn baseline", async (t) => {
  const root = makeRepo(t);
  const baseline = await createGitChangeBaseline(root);
  fs.writeFileSync(path.join(root, "clean.txt"), "committed during turn\n");
  git(root, "add", "clean.txt");
  git(root, "commit", "-qm", "turn commit");
  const result = await collectGitChanges(baseline);
  const change = result.changes.find((entry) => entry.path === "clean.txt");
  assert.equal(change.kind, "update");
  assert.match(change.diff, /committed during turn/);
  assert.match(change.afterHash, /^[a-f0-9]{64}$/);
});

test("diff redaction covers unchanged context lines as well as additions", () => {
  const diff = ["@@ -1,2 +1,2 @@", " password: context-secret",
    "-api_key = old-secret", "+api_key = new-secret"].join("\n");
  const cleaned = redactDiff(diff);
  assert.doesNotMatch(cleaned, /context-secret|old-secret|new-secret/);
  assert.equal((cleaned.match(/\[REDACTED\]/g) || []).length, 3);
});
