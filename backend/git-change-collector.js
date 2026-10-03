"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);

const MAX_FILES = 100;
const MAX_DIFF_BYTES = 64 * 1024;
const MAX_TOTAL_DIFF_BYTES = 512 * 1024;
const MAX_TEXT_FILE_BYTES = 1024 * 1024;
const MAX_BASELINE_DIRTY_FILES = 100;
const MAX_BASELINE_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_DIGEST_FILE_BYTES = 8 * 1024 * 1024;
const MAX_GIT_OUTPUT = 4 * 1024 * 1024;
const SECRET_PATH = /(^|\/)(?:\.env(?:\..*)?|secrets?(?:\..*)?|credentials?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)|authorized_keys|known_hosts)(?:$|\/)|\.(?:pem|key|p12|pfx|jks|keystore|asc)$/i;

function eligiblePath(value) {
  const file = String(value || "").replace(/\\/g, "/");
  return Boolean(file) && !file.startsWith("/") && !file.split("/").includes("..") &&
    !file.split("/").includes(".git") && !SECRET_PATH.test(file) &&
    !/(^|\/)(?:node_modules|vendor|\.next|dist|build)\//.test(file);
}

function parsePorcelain(buffer) {
  const fields = buffer.toString("utf8").split("\0");
  const paths = new Set();
  for (let i = 0; i < fields.length; i += 1) {
    const record = fields[i];
    if (!record) continue;
    if (record.startsWith("?? ")) {
      paths.add(record.slice(3));
      continue;
    }
    if (record.length >= 4) {
      paths.add(record.slice(3));
      if (/[RC]/.test(record.slice(0, 2)) && fields[i + 1]) paths.add(fields[++i]);
    }
  }
  return paths;
}

function parseNameStatus(buffer) {
  const fields = buffer.toString("utf8").split("\0");
  const changes = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++];
    if (!status) continue;
    const first = fields[i++];
    if (!first) break;
    if (status[0] === "R" || status[0] === "C") {
      const second = fields[i++];
      if (second) changes.push({ status: "R", path: second, oldPath: first });
    } else {
      changes.push({ status: status[0], path: first });
    }
  }
  return changes;
}

async function git(cwd, args, options = {}) {
  const result = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "buffer", maxBuffer: options.maxBuffer || MAX_GIT_OUTPUT,
    timeout: options.timeout || 15000,
  });
  return result.stdout;
}

async function capturePath(cwd, file, { maxBytes = MAX_DIGEST_FILE_BYTES } = {}) {
  try {
    const absolute = path.join(cwd, file);
    const real = await fs.promises.realpath(absolute);
    if (!isWithin(cwd, real)) return { size: 0, mtimeMs: 0, hash: null, buffer: null,
      symlink: true, unavailable: true };
    const stat = await fs.promises.lstat(absolute);
    if (stat.isSymbolicLink()) return { size: stat.size, mtimeMs: stat.mtimeMs,
      hash: null, buffer: null, symlink: true, unavailable: true };
    if (!stat.isFile()) return null;
    if (stat.size > maxBytes) {
      return { size: stat.size, mtimeMs: stat.mtimeMs, hash: null, buffer: null,
        symlink: false, unavailable: true };
    }
    const hash = crypto.createHash("sha256");
    if (stat.size <= MAX_TEXT_FILE_BYTES) {
      const buffer = await fs.promises.readFile(absolute);
      hash.update(buffer);
      return { size: stat.size, mtimeMs: stat.mtimeMs, hash: hash.digest("hex"), buffer, symlink: false };
    }
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(absolute);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", resolve);
    });
    return { size: stat.size, mtimeMs: stat.mtimeMs, hash: hash.digest("hex"), buffer: null, symlink: false };
  } catch {
    return null;
  }
}

function boundedBufferDiff(before, after, oldPath, newPath) {
  const oldLines = before.toString("utf8").match(/[^\n]*\n|[^\n]+$/g) || [];
  const newLines = after.toString("utf8").match(/[^\n]*\n|[^\n]+$/g) || [];
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix &&
      oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix += 1;
  const contextStart = Math.max(0, prefix - 1);
  const oldEnd = Math.min(oldLines.length, oldLines.length - suffix + 1);
  const newEnd = Math.min(newLines.length, newLines.length - suffix + 1);
  const body = [
    ...oldLines.slice(contextStart, prefix).map((line) => ` ${line.replace(/\n$/, "")}`),
    ...oldLines.slice(prefix, oldEnd - (suffix ? 1 : 0)).map((line) => `-${line.replace(/\n$/, "")}`),
    ...newLines.slice(prefix, newEnd - (suffix ? 1 : 0)).map((line) => `+${line.replace(/\n$/, "")}`),
  ];
  if (suffix) body.push(` ${oldLines[oldLines.length - suffix].replace(/\n$/, "")}`);
  return [`--- a/${oldPath}`, `+++ b/${newPath}`,
    `@@ -${contextStart + 1},${Math.max(0, oldEnd - contextStart)} +${contextStart + 1},${Math.max(0, newEnd - contextStart)} @@`,
    ...body].join("\n");
}

async function createGitChangeBaseline(workDir) {
  const cwd = path.resolve(workDir);
  const root = path.resolve((await git(cwd, ["rev-parse", "--show-toplevel"]))
    .toString("utf8").trim());
  if (path.relative(root, cwd).startsWith("..")) throw new Error("Invalid Git work directory");
  const status = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const branch = (await git(root, ["branch", "--show-current"])).toString("utf8").trim();
  const headSha = (await git(root, ["rev-parse", "HEAD"])).toString("utf8").trim();
  const preexisting = parsePorcelain(status);
  const preexistingSnapshots = new Map();
  const unavailablePaths = new Set();
  let snapshotBytes = 0;
  let snapshotCount = 0;
  for (const file of preexisting) {
    if (!eligiblePath(file)) continue;
    if (snapshotCount >= MAX_BASELINE_DIRTY_FILES) {
      unavailablePaths.add(file);
      continue;
    }
    snapshotCount += 1;
    const metadata = await capturePath(root, file, { maxBytes: MAX_DIGEST_FILE_BYTES });
    if (!metadata) {
      preexistingSnapshots.set(file, { size: null, mtimeMs: null, hash: null,
        buffer: null, symlink: false, unavailable: true });
      unavailablePaths.add(file);
      continue;
    }
    if (metadata.size > MAX_BASELINE_TOTAL_BYTES - snapshotBytes || metadata.unavailable) {
      preexistingSnapshots.set(file, { ...metadata, unavailable: true, buffer: null, hash: null });
      unavailablePaths.add(file);
      continue;
    }
    snapshotBytes += metadata.size;
    preexistingSnapshots.set(file, metadata);
  }
  return { cwd: root, root, branch, headSha, preexisting, preexistingSnapshots, unavailablePaths,
    baselineUnavailable: unavailablePaths.size, snapshotBytes, createdAt: Date.now() };
}

async function readBlob(cwd, file, status, baseSha = "HEAD") {
  try {
    if (status === "D") {
      const size = Number((await git(cwd, ["cat-file", "-s", `${baseSha}:${file}`])).toString("utf8").trim());
      const buffer = size <= MAX_TEXT_FILE_BYTES
        ? await git(cwd, ["show", `${baseSha}:${file}`], { maxBuffer: MAX_TEXT_FILE_BYTES + 1 })
        : Buffer.alloc(0);
      return { buffer, size, symlink: false };
    }
    const absolute = path.join(cwd, file);
    const real = await fs.promises.realpath(absolute);
    if (!isWithin(cwd, real)) return { buffer: Buffer.alloc(0), size: 0, symlink: true };
    const stat = await fs.promises.lstat(absolute);
    if (stat.isSymbolicLink()) return { buffer: Buffer.alloc(0), size: stat.size, symlink: true };
    if (!stat.isFile()) return { buffer: Buffer.alloc(0), size: stat.size, symlink: false };
    if (stat.size > MAX_TEXT_FILE_BYTES) {
      const handle = await fs.promises.open(absolute, "r");
      try {
        const sample = Buffer.alloc(8192);
        const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
        return { buffer: sample.subarray(0, bytesRead), size: stat.size, symlink: false };
      } finally { await handle.close(); }
    }
    return { buffer: await fs.promises.readFile(absolute), size: stat.size, symlink: false };
  } catch {
    return { buffer: Buffer.alloc(0), size: 0, symlink: false };
  }
}

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." &&
    !relative.startsWith(`..${path.sep}`));
}

function isBinary(buffer) {
  return buffer.includes(0);
}


function redactDiff(value) {
  return String(value || "")
    .replace(/(^[ +\-]\s*[^\n]*(?:api[_-]?key|access[_-]?token|secret|password|authorization|private[_-]?key)[^\n]*?[=:]\s*).*$/gim,
      "$1[REDACTED]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|xai-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,})\b/g,
      "[REDACTED]")
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
      "[REDACTED PRIVATE KEY]");
}

function clipDiff(diff, remaining) {
  const bytes = Buffer.from(diff, "utf8");
  const limit = Math.max(0, Math.min(MAX_DIFF_BYTES, remaining));
  if (bytes.length <= limit) return { diff, truncated: false, bytes: bytes.length };
  return {
    diff: `${bytes.subarray(0, limit).toString("utf8")}\n… Diff 已截断 …`,
    truncated: true,
    bytes: bytes.length,
  };
}

async function getDiff(cwd, change, baseSha = "HEAD") {
  if (change.status === "U") {
    try {
      const { stdout } = await execFileAsync("git", ["-C", cwd, "diff", "--no-index", "--no-ext-diff",
        "--unified=3", "--", "/dev/null", path.join(cwd, change.path)], {
        encoding: "buffer", maxBuffer: MAX_GIT_OUTPUT, timeout: 15000,
      });
      return stdout.toString("utf8");
    } catch (error) {
      if (error.stdout) return Buffer.from(error.stdout).toString("utf8");
      return "";
    }
  }
  const paths = change.oldPath ? [change.oldPath, change.path] : [change.path];
  const args = ["diff", baseSha, "--no-ext-diff", "--no-color", "--find-renames", "--unified=3", "--", ...paths];
  try { return (await git(cwd, args)).toString("utf8"); }
  catch (error) { return Buffer.from(error.stdout || "").toString("utf8"); }
}

async function collectGitChanges(baseline, options = {}) {
  const cwd = baseline.cwd;
  const maxFiles = Math.max(1, Math.min(MAX_FILES, Number(options.maxFiles) || MAX_FILES));
  const currentStatus = parsePorcelain(await git(cwd,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
  const baseSha = baseline.headSha || "HEAD";
  const endBranch = (await git(cwd, ["branch", "--show-current"])).toString("utf8").trim();
  const tracked = parseNameStatus(await git(cwd,
    ["diff", baseSha, "--name-status", "-z", "--find-renames=50%"]));
  const untracked = [...currentStatus].filter((file) => !baseline.preexisting.has(file) &&
    !tracked.some((entry) => entry.path === file || entry.oldPath === file) &&
    eligiblePath(file)).map((file) => ({ status: "U", path: file }));
  const baselineDirty = [];
  let baselineCompareBytes = 0;
  let baselineUnavailable = Number(baseline.baselineUnavailable || 0);
  for (const [file, before] of baseline.preexistingSnapshots || []) {
    const after = await capturePath(cwd, file, { maxBytes: Math.min(MAX_DIGEST_FILE_BYTES,
      MAX_BASELINE_TOTAL_BYTES - baselineCompareBytes) });
    if (after && !after.unavailable) baselineCompareBytes += after.size;
    if (before.unavailable || after?.unavailable) {
      baselineUnavailable += before.unavailable ? 0 : 1;
      const changed = !after || before.size !== after.size || before.mtimeMs !== after.mtimeMs;
      if (changed) baselineDirty.push({ status: after ? "M" : "D", path: file,
        baselineDirty: true, baselineUnavailable: true, beforeSnapshot: before,
        afterSnapshot: after });
      continue;
    }
    if (before.hash === (after?.hash || null)) continue;
    baselineDirty.push({ status: after ? "M" : "D", path: file, baselineDirty: true,
      beforeSnapshot: before, afterSnapshot: after });
  }
  const candidates = tracked.filter((entry) => eligiblePath(entry.path) &&
    (!entry.oldPath || eligiblePath(entry.oldPath)) &&
    !baseline.preexisting.has(entry.path) && !baseline.preexisting.has(entry.oldPath));
  const unique = [...baselineDirty, ...candidates, ...untracked].filter((entry, index, all) =>
    all.findIndex((other) => other.path === entry.path && other.oldPath === entry.oldPath) === index);
  const records = [];
  let remaining = Math.max(0, Number(options.maxTotalDiffBytes) || MAX_TOTAL_DIFF_BYTES);
  let omitted = 0;
  let digestBytes = 0;
  for (const change of unique) {
    if (records.length >= maxFiles) { omitted += 1; continue; }
    const currentSnapshot = change.baselineDirty ? change.afterSnapshot :
      await capturePath(cwd, change.path, { maxBytes: Math.min(MAX_DIGEST_FILE_BYTES,
        Math.max(0, MAX_BASELINE_TOTAL_BYTES - digestBytes)) });
    if (currentSnapshot && !currentSnapshot.unavailable) digestBytes += currentSnapshot.size;
    const { buffer, size } = change.baselineDirty
      ? { buffer: currentSnapshot?.buffer || Buffer.alloc(0), size: currentSnapshot?.size || 0 }
      : await readBlob(cwd, change.path, change.status);
    const oldBlob = change.baselineDirty ? change.beforeSnapshot : change.oldPath || !["A", "U"].includes(change.status)
      ? await readBlob(cwd, change.oldPath || change.path, "D", baseSha)
      : { buffer: Buffer.alloc(0), size: 0, symlink: false };
    const oldBuffer = oldBlob.buffer || Buffer.alloc(0);
    const currentBlob = change.baselineDirty ? currentSnapshot : await readBlob(cwd, change.path, change.status);
    const binary = Boolean(currentBlob?.symlink || oldBlob.symlink) ||
      isBinary(buffer) || isBinary(oldBuffer);
    let diff = "";
    let truncated = false;
    let diffBytes = 0;
    if (binary) {
      diff = "二进制文件，未显示文本 Diff";
    } else if (change.baselineUnavailable) {
      diff = "回合基线采集超出上限，无法可靠归因本轮差异";
      truncated = true;
    } else if (size > MAX_TEXT_FILE_BYTES || oldBlob.size > MAX_TEXT_FILE_BYTES) {
      diff = `文件超过 ${MAX_TEXT_FILE_BYTES} 字节，未内联 Diff`;
      truncated = true;
    } else if (remaining > 0) {
      const rawDiff = change.baselineDirty
        ? boundedBufferDiff(oldBuffer, buffer, change.path, change.path)
        : await getDiff(cwd, change, baseSha);
      const clipped = clipDiff(redactDiff(rawDiff), remaining);
      diff = clipped.diff;
      truncated = clipped.truncated;
      diffBytes = clipped.bytes;
      remaining = Math.max(0, remaining - Buffer.byteLength(diff, "utf8"));
    } else {
      diff = "Diff 总量已达上限，未内联显示";
      truncated = true;
    }
    records.push({
      path: change.path,
      oldPath: change.oldPath || null,
      kind: change.status === "U" ? "untracked" : change.status === "A" ? "add" :
        change.status === "D" ? "delete" : change.status === "R" ? "rename" : "update",
      status: change.status,
      baselineDirty: Boolean(change.baselineDirty),
      baselineUnavailable: Boolean(change.baselineUnavailable),
      afterHash: change.status === "D" ? null :
        (change.baselineDirty ? change.afterSnapshot?.hash || null : currentSnapshot?.hash || null),
      afterHashUnavailable: change.status !== "D" && (!currentSnapshot || Boolean(currentSnapshot.unavailable)),
      binary,
      size,
      diff,
      diffBytes,
      truncated,
    });
  }
  return { changes: records, omitted, total: unique.length, baselineUnavailable,
    branch: endBranch, baselineBranch: baseline.branch,
    branchChanged: Boolean(baseline.branch && endBranch !== baseline.branch) };
}

module.exports = {
  createGitChangeBaseline,
  collectGitChanges,
  eligiblePath,
  redactDiff,
  boundedBufferDiff,
  parsePorcelain,
  parseNameStatus,
  MAX_FILES,
  MAX_DIFF_BYTES,
  MAX_TOTAL_DIFF_BYTES,
  MAX_TEXT_FILE_BYTES,
  MAX_BASELINE_DIRTY_FILES,
  MAX_BASELINE_TOTAL_BYTES,
  MAX_DIGEST_FILE_BYTES,
};
