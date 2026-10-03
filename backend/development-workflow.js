'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');

const REPO_DIR = '/opt/witt';
const BRANCH = 'platform/personal-ai-ops';
const ORIGIN = 'git@github-witt-autumn:Autumn8001/Witt.git';
const UNIT = 'witt.service';
const DEFAULT_TESTS = [
  { command: 'node', args: ['backend/test-runtime-parsers.js'] },
  { command: 'node', args: ['backend/test-runtime-process.js'] },
  { command: 'node', args: ['backend/test-runtime-layer.js'] },
  { command: 'node', args: ['backend/test-git-change-collector.js'] },
  { command: 'node', args: ['backend/test-tool-content-redaction.js'] },
  { command: 'node', args: ['--test', 'backend/test-development-workflow.js'] },
  { command: 'node', args: ['backend/test-chat-history-regressions.js'] },
  { command: 'node', args: ['backend/test-chat-improvements.js'] },
  { command: 'node', args: ['backend/test-chat-isolation.js'] },
  { command: 'node', args: ['backend/test-sqlite-store.js'] },
  { command: 'node', args: ['backend/test-workdir-roots.js'] },
  { command: 'node', args: ['tests/ui-mvp-check.cjs'] },
  { command: 'node', args: ['tests/ui-check.mjs'] },
];

function runProgram(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: process.platform !== 'win32',
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    const stdout = [];
    const stderr = [];
    let outBytes = 0;
    let errBytes = 0;
    const maxBytes = options.maxOutputBytes || 256 * 1024;
    child.stdout.on('data', (chunk) => { outBytes += chunk.length; if (outBytes <= maxBytes) stdout.push(chunk); });
    child.stderr.on('data', (chunk) => { errBytes += chunk.length; if (errBytes <= maxBytes) stderr.push(chunk); });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({
      code: Number.isInteger(code) ? code : 1,
      signal: signal || null,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      outputTruncated: outBytes > maxBytes || errBytes > maxBytes,
    }));
    let hardKill;
    let terminating = false;
    const terminate = () => {
      if (terminating) return;
      terminating = true;
      try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); } catch {}
      hardKill = setTimeout(() => {
        try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {}
      }, 1500);
      hardKill.unref?.();
    };
    const onAbort = () => terminate();
    if (options.signal) {
      if (options.signal.aborted) terminate();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }
    let timer;
    if (options.timeoutMs) timer = setTimeout(terminate, options.timeoutMs);
    child.once('close', () => {
      if (timer) clearTimeout(timer);
      if (hardKill && !terminating) clearTimeout(hardKill);
      options.signal?.removeEventListener('abort', onAbort);
    });
  });
}

function redact(value) {
  return String(value || '')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi, '[redacted private key]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|xai-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,})\b/g, '[redacted]')
    .replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/(["']?(?:api[_-]?key|token|password|secret|authorization)["']?\s*:\s*["'])[^"']*(["'])/gi, '$1[redacted]$2')
    .slice(-16000);
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.tmp-' + process.pid + '-' + randomUUID();
  fs.writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

function validatePath(input) {
  if (typeof input !== 'string' || !input || input.includes('\\') || path.posix.isAbsolute(input)) {
    throw new Error('change paths must be repository-relative');
  }
  const normalized = path.posix.normalize(input);
  if (normalized !== input || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error('change path escapes the repository');
  }
  if (normalized === '.git' || normalized.startsWith('.git/')) throw new Error('Git metadata is not a project file');
  return normalized;
}

function collectPaths(changes) {
  if (!Array.isArray(changes) || !changes.length) throw new Error('this turn has no file changes to commit');
  const result = new Set();
  for (const change of changes) {
    if (!change || typeof change !== 'object') throw new Error('invalid file change event');
    if (changes.length > 100) throw new Error('this turn exceeds the 100 file change limit');
    if (change.baselineDirty !== false) throw new Error('change event is not proven clean at turn start');
    const deleted = change.kind === 'delete';
    if (deleted ? change.afterHash !== null : !/^[a-f0-9]{64}$/i.test(String(change.afterHash || ''))) {
      throw new Error('change event is missing a valid afterHash snapshot');
    }
    result.add(validatePath(change.path));
    const oldPath = change.oldPath || (change.kind && change.kind.old_path);
    const movePath = change.movePath || (change.kind && change.kind.move_path);
    if (oldPath) result.add(validatePath(oldPath));
    if (movePath) result.add(validatePath(movePath));
  }
  return [...result].sort();
}


function syntaxCheckPaths(changes) {
  if (!Array.isArray(changes)) return [];
  return [...new Set(changes
    .filter((change) => change && change.kind !== 'delete')
    .map((change) => validatePath(change.path))
    .filter((file) => ['.js', '.cjs', '.mjs'].includes(path.posix.extname(file))))].sort();
}

function validateTest(spec) {
  if (!spec || !['node', 'python3', 'bash'].includes(spec.command) || !Array.isArray(spec.args)) {
    throw new Error('test command must use node, python3, or bash');
  }
  const args = spec.args.map(String);
  const file = args.find((arg) => !arg.startsWith('-'));
  if (!file) throw new Error('test command must name a repository test file');
  const relative = validatePath(file);
  if (!['backend/', 'tests/', 'scripts/'].some((prefix) => relative.startsWith(prefix))) {
    throw new Error('test file must stay under backend/, tests/, or scripts/');
  }
  const extension = path.posix.extname(relative);
  const validExtensions = spec.command === 'node' ? ['.js', '.cjs', '.mjs']
    : spec.command === 'python3' ? ['.py'] : ['.sh'];
  if (!validExtensions.includes(extension)) throw new Error('test runner and file extension do not match');
  return { command: spec.command, args };
}

class DevelopmentWorkflow {
  constructor(options = {}) {
    this.repoDir = path.resolve(options.repoDir || REPO_DIR);
    const fixtureRoot = '/opt/witt/.git/witt-workflow-fixture-';
    this.testOnly = options.testOnly === true && this.repoDir.startsWith(fixtureRoot) &&
      typeof options.origin === 'string' && path.resolve(options.origin).startsWith(fixtureRoot);
    this.branch = BRANCH;
    this.origin = this.testOnly ? options.origin : ORIGIN;
    this.jobDir = path.resolve(options.jobDir || '/opt/witt/.git/witt-development-jobs');
    this.onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};
    this.testCommands = options.testCommands || DEFAULT_TESTS;
    this.restartDelayMs = options.restartDelayMs === undefined ? 5000 : options.restartDelayMs;
    this.run = options.runProgram || runProgram;
    this.childEnv = options.childEnv || Object.fromEntries(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'NODE_ENV', 'SSH_AUTH_SOCK']
      .filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
    this.testEnv = options.testEnv || this.childEnv;
    this.fetch = options.fetch || globalThis.fetch;
    this.timers = new Map();
    this.watchdogs = new Map();
    this.abortControllers = new Map();
    this.activeTasks = new Map();
    this.cancelRequested = new Set();
    this.recoveryQueue = [];
    this.activeLock = path.join(this.jobDir, '.development-workflow.lock');
    if (this.repoDir !== REPO_DIR && !this.testOnly) throw new Error('workflow only supports /opt/witt');
    if (!Number.isInteger(this.restartDelayMs) || this.restartDelayMs < 5000 || this.restartDelayMs > 600000) {
      throw new Error('restart delay must be from 5000 ms to 600000 ms');
    }
  }

  file(jobId) {
    if (!/^[0-9a-f-]{36}$/i.test(jobId)) throw new Error('invalid workflow job id');
    return path.join(this.jobDir, 'development-' + jobId + '.json');
  }

  read(jobId) {
    try { return JSON.parse(fs.readFileSync(this.file(jobId), 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new Error('cannot read workflow job: ' + error.message);
    }
  }

  write(job) { atomicWrite(this.file(job.id), job); }

  async update(job, stage, fields = {}) {
    Object.assign(job, fields, { stage, updatedAt: new Date().toISOString() });
    job.events.push({ at: job.updatedAt, type: 'workflow_stage', stage, status: job.status, detail: fields.detail || null });
    if (job.events.length > 100) job.events.splice(0, job.events.length - 100);
    this.write(job);
    const messages = { testing: '正在运行测试', awaiting_commit_confirmation: '测试通过，等待确认提交', awaiting_deploy_confirmation: '已提交并推送，等待部署确认', staging: '正在暂存本轮文件', committing: '正在创建提交', pushing: '正在推送产品分支', restart_queued: '已安排延迟重启', restarting: '正在重启 Witt', health_check: '正在检查服务健康', complete: '部署完成', failed: '开发工作流失败' };
    try { await this.onEvent({ type: 'development_workflow', jobId: job.id, userId: job.userId, conversationId: job.conversationId || null,
      messageId: job.messageId, status: job.status, stage: job.stage, message: messages[job.stage] || job.stage, job: structuredClone(job) }); }
    catch {}
  }

  async git(args, timeoutMs = 120000, signal) {
    const result = await this.run('git', args, { cwd: this.repoDir, timeoutMs, signal, env: this.childEnv });
    if (result.code !== 0) {
      const error = new Error('git ' + args[0] + ' failed with exit code ' + result.code);
      error.code = result.code;
      error.stderr = redact(result.stderr);
      throw error;
    }
    return result.stdout;
  }

  async assertTarget() {
    const top = (await this.git(['rev-parse', '--show-toplevel'])).trim();
    const actualDir = await fs.promises.realpath(this.repoDir);
    if (top !== actualDir || actualDir !== this.repoDir) throw new Error('Git worktree is outside the configured repository');
    const branch = (await this.git(['branch', '--show-current'])).trim();
    if (branch !== this.branch) throw new Error('current branch is not platform/personal-ai-ops');
    const origin = (await this.git(['remote', 'get-url', 'origin'])).trim();
    if (origin !== this.origin) throw new Error('origin does not match the configured repository URL');
  }

  async assertHead(expected, context) {
    const actual = (await this.git(['rev-parse', 'HEAD'])).trim();
    if (!expected || actual !== expected) throw new Error('refusing ' + context + ': local HEAD does not match the workflow commit');
    return actual;
  }

  async assertNoUnrelatedTrackedChanges(paths) {
    const allowed = new Set(paths);
    const raw = await this.git(['status', '--porcelain=v1', '-z', '--untracked-files=no']);
    const fields = raw.split('\0').filter(Boolean);
    for (let i = 0; i < fields.length; i++) {
      const entry = fields[i], name = entry.slice(3);
      if (!allowed.has(name)) throw new Error('refusing deployment while unrelated tracked worktree changes exist: ' + name);
      if (entry[0] === 'R' || entry[0] === 'C' || entry[1] === 'R' || entry[1] === 'C') {
        const source = fields[++i];
        if (source && !allowed.has(source)) throw new Error('refusing deployment while unrelated tracked worktree changes exist: ' + source);
      }
    }
  }

  async runChecks(job, signal) {
    if (!Array.isArray(this.testCommands) || !this.testCommands.length) throw new Error('no tests are configured');
    const results = [];
    const syntaxChecks = syntaxCheckPaths(job.changes || [])
      .map((file) => ({ syntaxCheck: true, command: 'node', args: ['--check', file] }));
    for (const candidate of [...syntaxChecks, ...this.testCommands]) {
      const spec = candidate.syntaxCheck
        ? { command: 'node', args: ['--check', validatePath(candidate.args[1])] }
        : validateTest(candidate);
      const result = await this.run(spec.command, spec.args, { cwd: this.repoDir, timeoutMs: 15 * 60 * 1000, signal, env: this.testEnv });
      if (signal?.aborted) { const cancelled = new Error('workflow cancelled before commit'); cancelled.cancelled = true; throw cancelled; }
      const item = { command: spec.command, args: spec.args, code: result.code, signal: result.signal || null,
        stdout: redact(result.stdout), stderr: redact(result.stderr), outputTruncated: Boolean(result.outputTruncated) };
      results.push(item);
      job.testResults = results;
      this.write(job);
      await this.update(job, 'testing', { status: 'running', detail: { command: spec.command + ' ' + spec.args.join(' '), exitCode: result.code, stdout: item.stdout, stderr: item.stderr } });
      if (result.code !== 0) throw new Error(spec.command + ' test failed with exit code ' + result.code);
    }
    return results;
  }

  validateTargets(paths) {
    for (const relative of paths) {
      const target = path.resolve(this.repoDir, relative);
      if (!target.startsWith(this.repoDir + path.sep)) throw new Error('change path resolves outside /opt/witt');
      const segments = relative.split('/');
      let cursor = this.repoDir;
      for (const segment of segments.slice(0, -1)) {
        cursor = path.join(cursor, segment);
        try { if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('change path traverses a symbolic link'); }
        catch (error) { if (error.code === 'ENOENT') break; throw error; }
      }
      try { const stat = fs.lstatSync(target); if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error('change target is not a file'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }

  async submit({ userId, messageId, conversationId, changes }) {
    if (typeof userId !== 'string' || !userId.trim()) throw new Error('userId is required');
    if (typeof messageId !== 'string' || !messageId.trim()) throw new Error('messageId is required');
    const paths = collectPaths(changes);
    await this.assertTarget();
    await this.assertNoUnrelatedTrackedChanges(paths);
    this.validateTargets(paths);
    const baseSha = (await this.git(['rev-parse', 'HEAD'])).trim();
    fs.mkdirSync(this.jobDir, { recursive: true, mode: 0o700 });
    let lockFd;
    try { lockFd = fs.openSync(this.activeLock, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw new Error('another development workflow is active'); throw error; }
    const job = {
      id: randomUUID(), userId, messageId, conversationId: conversationId || null,
      status: 'queued', stage: 'queued', branch: this.branch, origin: this.origin,
      paths, changes: changes.map((change) => ({ path: change.path, oldPath: change.oldPath || null,
        kind: change.kind, baselineDirty: change.baselineDirty, afterHash: change.afterHash })),
      commitMessage: null, baseSha,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      sha: null, push: null, restartAt: null, restartStartedAt: null,
      health: null, error: null, testResults: [], events: [],
    };
    try { this.write(job); } catch (error) { fs.closeSync(lockFd); this.releaseLock(); throw error; }
    fs.writeFileSync(lockFd, JSON.stringify({ jobId: job.id, pid: process.pid }));
    fs.closeSync(lockFd);
    await this.update(job, 'testing', { status: 'running' });
    const controller = new AbortController(); this.abortControllers.set(job.id, controller);
    const task = Promise.resolve().then(() => this.advance(job.id, controller.signal))
      .catch((error) => this.fail(job.id, error))
      .finally(() => {
        this.abortControllers.delete(job.id);
        this.activeTasks.delete(job.id);
        this.cancelRequested.delete(job.id);
      });
    this.activeTasks.set(job.id, task);
    return this.read(job.id);
  }

  async validateSnapshots(changes) {
    for (const change of changes) {
      const target = path.join(this.repoDir, change.path);
      let stat;
      try { stat = await fs.promises.lstat(target); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (change.kind === 'delete') {
        if (stat) throw new Error('deleted file has reappeared since its turn snapshot: ' + change.path);
        continue;
      }
      if (!stat || !stat.isFile() || stat.isSymbolicLink()) throw new Error('changed file is missing or not a regular file: ' + change.path);
      const digest = createHash('sha256');
      await new Promise((resolve, reject) => {
        const stream = fs.createReadStream(target);
        stream.on('data', (chunk) => digest.update(chunk));
        stream.once('error', reject);
        stream.once('end', resolve);
      });
      if (digest.digest('hex') !== change.afterHash.toLowerCase()) throw new Error('file changed after the turn snapshot: ' + change.path);
      if (change.oldPath) {
        try { await fs.promises.lstat(path.join(this.repoDir, change.oldPath)); throw new Error('rename source still exists: ' + change.oldPath); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
  }

  async advance(jobId, signal) {
    const job = this.read(jobId);
    if (!job || ['succeeded', 'failed', 'cancelled'].includes(job.status)) return job;
    try {
      await this.assertTarget();
      await this.assertHead(job.baseSha, 'testing changes');
      await this.validateSnapshots(job.changes);
      await this.runChecks(job, signal);
      await this.validateSnapshots(job.changes);
      await this.assertHead(job.baseSha, 'finishing tests');
      if (signal?.aborted) throw Object.assign(new Error('workflow cancelled before commit'), { cancelled: true });
      job.testsPassedAt = new Date().toISOString();
      await this.update(job, 'awaiting_commit_confirmation', {
        status: 'awaiting_commit_confirmation',
        detail: { testsPassedAt: job.testsPassedAt, paths: job.paths },
      });
      this.releaseLock(job.id);
      this.processRecoveryQueue();
      return this.read(job.id);
    } catch (error) {
      if (signal?.aborted) error.cancelled = true;
      await this.fail(job.id, error);
      return this.read(job.id);
    }
  }

  async confirmCommit(jobId, commitMessage) {
    if (typeof commitMessage !== 'string' || !commitMessage.trim() || commitMessage.length > 240) {
      throw new Error('commitMessage must contain 1 to 240 characters');
    }
    const job = this.read(jobId);
    if (!job || job.status !== 'awaiting_commit_confirmation' ||
        !job.testsPassedAt || !Array.isArray(job.testResults) || !job.testResults.length ||
        job.testResults.some((result) => result.code !== 0)) {
      throw new Error('no passing test run awaits commit confirmation');
    }
    await this.assertTarget();
    await this.assertHead(job.baseSha, 'confirming commit');
    await this.validateSnapshots(job.changes);
    await this.assertNoUnrelatedTrackedChanges(job.paths);
    this.acquireLock(job.id);
    job.commitMessage = commitMessage.trim();
    const controller = new AbortController();
    this.abortControllers.set(job.id, controller);
    try {
      await this.update(job, 'staging', { status: 'running',
        detail: { command: 'git add -- <explicit file paths>', paths: job.paths } });
    } catch (error) {
      this.abortControllers.delete(job.id);
      this.releaseLock(job.id);
      throw error;
    }
    const task = Promise.resolve().then(() => this.commitAndPush(job.id, controller.signal))
      .catch((error) => this.fail(job.id, error))
      .finally(() => {
        this.abortControllers.delete(job.id);
        this.activeTasks.delete(job.id);
        this.cancelRequested.delete(job.id);
      });
    this.activeTasks.set(job.id, task);
    return this.read(job.id);
  }

  async commitAndPush(jobId, signal) {
    const job = this.read(jobId);
    if (!job || job.status !== 'running' || job.stage !== 'staging') return job;
    try {
      await this.assertTarget();
      await this.assertHead(job.baseSha, 'staging changes');
      await this.validateSnapshots(job.changes);
      await this.assertNoUnrelatedTrackedChanges(job.paths);
      if (signal?.aborted) throw new Error('workflow cancelled before commit');
      const stagedBefore = (await this.git(['diff', '--cached', '--name-only', '--no-renames', '-z'])).split('\0').filter(Boolean);
      if (stagedBefore.length) throw new Error('refusing to include changes staged before this job');
      job.stagedPaths = true; this.write(job);
      await this.git(['add', '--', ...job.paths], 120000, signal);
      const staged = (await this.git(['diff', '--cached', '--name-only', '--no-renames', '-z'])).split('\0').filter(Boolean).sort();
      const expected = [...job.paths].sort();
      if (staged.length !== expected.length || staged.some((name, index) => name !== expected[index])) {
        throw new Error('staged paths do not exactly match this turn file list');
      }
      await this.update(job, 'staging', { detail: { command: 'git add -- <explicit file paths>', exitCode: 0, paths: staged } });
      await this.git(['diff', '--cached', '--check']);
      await this.assertHead(job.baseSha, 'committing changes');
      await this.validateSnapshots(job.changes);
      if (signal?.aborted) throw new Error('workflow cancelled before commit');
      await this.update(job, 'committing', { detail: { command: 'git commit -m [commit message]' } });
      await this.git(['commit', '-m', job.commitMessage], 300000);
      job.sha = (await this.git(['rev-parse', 'HEAD'])).trim();
      job.stagedPaths = false; this.write(job);
      await this.update(job, 'committing', { detail: { command: 'git commit -m [commit message]', exitCode: 0, sha: job.sha } });
      await this.update(job, 'pushing', { detail: { command: 'git push origin HEAD:refs/heads/' + this.branch, sha: job.sha } });
      await this.assertHead(job.sha, 'pushing the commit');
      await this.assertNoUnrelatedTrackedChanges([]);
      await this.git(['push', 'origin', 'HEAD:refs/heads/' + this.branch], 300000);
      job.push = 'complete';
      await this.update(job, 'pushing', { detail: { command: 'git push origin HEAD:refs/heads/' + this.branch, exitCode: 0, sha: job.sha } });
      await this.awaitDeploymentConfirmation(job);
      return this.read(job.id);
    } catch (error) {
      if (signal?.aborted) error.cancelled = true;
      await this.fail(job.id, error);
      return this.read(job.id);
    }
  }

  async awaitDeploymentConfirmation(job) {
    job.push = 'complete';
    job.error = null;
    job.finishedAt = null;
    await this.update(job, 'awaiting_deploy_confirmation', {
      status: 'awaiting_deploy_confirmation',
      detail: { sha: job.sha, message: 'Commit and push complete; deployment requires separate confirmation' },
    });
    this.releaseLock(job.id);
    this.processRecoveryQueue();
  }

  async assertCleanWorktree() {
    const status = await this.git(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (status) throw new Error('refusing deployment while the worktree contains uncommitted or untracked files');
  }

  async assertRemoteHead(sha) {
    const output = await this.git(['ls-remote', 'origin', 'refs/heads/' + this.branch]);
    if (output.split(/\s+/)[0] !== sha) {
      throw new Error('refusing deployment: origin product branch does not match the confirmed commit');
    }
  }

  async deploy(jobId) {
    if (this.testOnly) throw new Error('test fixture cannot restart the production service');
    const job = this.read(jobId);
    if (!job || !job.sha || job.push !== 'complete' ||
        !['awaiting_deploy_confirmation', 'failed'].includes(job.status)) {
      throw new Error('no pushed commit awaits deployment confirmation');
    }
    await this.assertTarget();
    await this.assertHead(job.sha, 'deploying the confirmed commit');
    await this.assertCleanWorktree();
    await this.assertRemoteHead(job.sha);
    this.acquireLock(job.id);
    try {
      await this.scheduleRestart(job);
      return this.read(job.id);
    } catch (error) {
      this.releaseLock(job.id);
      throw error;
    }
  }

  async scheduleRestart(job) {
    job.status = 'restart_queued';
    job.finishedAt = null;
    job.health = null;
    job.restartAt = new Date(Date.now() + this.restartDelayMs).toISOString();
    job.error = null;
    await this.update(job, 'restart_queued', { status: 'restart_queued', detail: { restartAt: job.restartAt } });
    this.armRestart(job);
  }

  armRestart(job) {
    const old = this.timers.get(job.id);
    if (old) clearTimeout(old);
    const delay = Math.max(0, Date.parse(job.restartAt) - Date.now());
    const timer = setTimeout(() => {
      this.timers.delete(job.id);
      this.restartAndCheck(job.id).catch((error) => this.fail(job.id, error));
    }, delay);
    if (typeof timer.unref === 'function') timer.unref();
    this.timers.set(job.id, timer);
  }

  async restartAndCheck(jobId) {
    if (this.testOnly) throw new Error('test fixture cannot restart the production service');
    const job = this.read(jobId);
    if (!job || job.status !== 'restart_queued') return job;
    await this.assertTarget();
    await this.assertHead(job.sha, 'restarting the service');
    await this.assertCleanWorktree();
    await this.assertRemoteHead(job.sha);
    job.status = 'restarting';
    job.restartStartedAt = new Date().toISOString();
    const command = '/opt/witt/scripts/deploy-commit.sh';
    const unit = 'witt-deploy-' + job.id.slice(0, 8) + '-' + Date.now();
    await this.update(job, 'restarting', { status: 'restarting',
      detail: { command: 'systemd-run --on-active=3s ' + command + ' ' + job.sha, unit } });
    job.deploymentUnit = unit;
    this.write(job);
    const result = await this.run('systemd-run',
      ['--collect', '--on-active=3s', '--unit=' + unit, '/bin/bash', command, job.sha],
      { timeoutMs: 30000, env: this.childEnv });
    if (result.code !== 0) throw new Error('could not schedule confirmed Witt deployment: exit code ' + result.code);
    await this.update(job, 'restarting', { status: 'restarting',
      detail: { unit, scheduled: true, exitCode: 0 } });
    // The transient unit restarts Witt. A watchdog covers script failures that
    // leave this old backend running; a new backend process uses recover().
    this.armWatchdog(job.id);
    return this.read(job.id);
  }

  armWatchdog(jobId) {
    const previous = this.watchdogs.get(jobId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.watchdogs.delete(jobId);
      this.watchdogCheck(jobId).catch((error) => this.fail(jobId, error));
    }, 90000);
    timer.unref?.();
    this.watchdogs.set(jobId, timer);
  }

  async watchdogCheck(jobId) {
    const job = this.read(jobId);
    if (!job || !['restarting', 'health_check'].includes(job.status)) return job;
    const health = await this.checkHealth(job.sha);
    if (health.ok) return this.reconcileRecovered(job);
    let unitState = 'unknown';
    if (job.deploymentUnit) {
      try {
        const result = await this.run('systemctl',
          ['show', job.deploymentUnit + '.service', '--property=ActiveState,Result', '--value'],
          { timeoutMs: 10000, env: this.childEnv });
        unitState = redact(result.stdout.trim() || result.stderr.trim() || 'unknown');
      } catch {}
    }
    return this.fail(job.id, new Error('confirmed deployment did not reach the requested backend/frontend SHA within 90 seconds; unit: ' + unitState));
  }

  async checkHealth(expectedSha, retryMs = 0) {
    if (typeof this.fetch !== 'function') return { ok: false, error: 'fetch is unavailable' };
    const deadline = Date.now() + retryMs;
    let last = { ok: false, error: 'deployment version has not been observed' };
    do {
      try {
        const [healthResponse, backendResponse, frontendResponse] = await Promise.all([
          this.fetch('http://127.0.0.1:3003/health', { signal: AbortSignal.timeout(5000) }),
          this.fetch('http://127.0.0.1:3003/version', { signal: AbortSignal.timeout(5000) }),
          this.fetch('https://cpa.stellarbit.site/vault/version.json', { signal: AbortSignal.timeout(5000) }),
        ]);
        const [health, backend, frontend] = await Promise.all([
          healthResponse.ok ? healthResponse.json() : null,
          backendResponse.ok ? backendResponse.json() : null,
          frontendResponse.ok ? frontendResponse.json() : null,
        ]);
        const backendSha = backend?.backendSha || null;
        const frontendSha = frontend?.frontendSha || null;
        last = { ok: healthResponse.ok && health?.ok === true &&
          backendResponse.ok && frontendResponse.ok &&
          backendSha === expectedSha && frontendSha === expectedSha,
        backendSha, frontendSha, status: healthResponse.status };
        if (last.ok) return last;
      } catch (error) { last = { ok: false, error: redact(error.message) }; }
      if (Date.now() >= deadline) return last;
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000, Math.max(1, deadline - Date.now()))));
    } while (true);
  }

  async fail(jobId, error) {
    const job = this.read(jobId);
    if (!job || ['succeeded', 'failed', 'cancelled'].includes(job.status)) return job;
    const timer = this.timers.get(jobId);
    if (timer) clearTimeout(timer);
    this.timers.delete(jobId);
    const watchdog = this.watchdogs.get(jobId);
    if (watchdog) clearTimeout(watchdog);
    this.watchdogs.delete(jobId);
    this.abortControllers.delete(jobId);
    if (job.stagedPaths && !job.sha) {
      try { await this.git(['restore', '--staged', '--', ...job.paths]); job.stagedPaths = false; }
      catch (cleanupError) { job.cleanupError = redact(cleanupError.message); }
    }
    job.status = error && error.cancelled ? 'cancelled' : 'failed';
    job.error = redact(error && error.message || error || 'unknown workflow failure');
    job.finishedAt = new Date().toISOString();
    await this.update(job, job.status, { status: job.status, error: job.error });
    this.releaseLock(jobId);
    this.processRecoveryQueue();
    return job;
  }

  releaseLock(jobId) {
    try {
      if (jobId) {
        const owner = JSON.parse(fs.readFileSync(this.activeLock, 'utf8'));
        if (owner.jobId !== jobId) return false;
      }
      fs.unlinkSync(this.activeLock); return true;
    } catch (error) { if (error.code !== 'ENOENT') throw error; return false; }
  }

  async cancel(jobId) {
    const job = this.read(jobId);
    if (!job) return null;
    if (job.sha || ['pushing', 'restart_queued', 'restarting', 'health_check', 'succeeded'].includes(job.status) || job.stage === 'committing')
      throw new Error('workflow cannot be cancelled after commit begins');
    if (['failed', 'cancelled'].includes(job.status)) return job;
    this.abortControllers.get(jobId)?.abort();
    job.status = 'cancelled'; job.error = 'cancelled by user before commit'; job.finishedAt = new Date().toISOString();
    await this.update(job, 'cancelled', { status: 'cancelled', error: job.error });
    this.abortControllers.delete(jobId);
    if (job.stagedPaths) { await this.git(['restore', '--staged', '--', ...job.paths]); job.stagedPaths = false; this.write(job); }
    this.releaseLock(jobId); return job;
  }

  async resumePush(jobId) {
    const job = this.read(jobId);
    if (!job || job.status !== 'failed' || !job.sha || job.push === 'complete') throw new Error('no committed failed-push job to resume');
    await this.assertTarget();
    const head = (await this.git(['rev-parse', 'HEAD'])).trim();
    if (head !== job.sha) throw new Error('cannot resume push because local HEAD differs from the recorded commit');
    await this.assertNoUnrelatedTrackedChanges([]);
    this.acquireLock(job.id);
    job.status = 'running'; job.stage = 'pushing'; job.error = null;
    await this.update(job, 'pushing', { status: 'running', detail: { resume: true, sha: job.sha } });
    try {
      await this.git(['push', 'origin', 'HEAD:refs/heads/' + this.branch], 300000);
      job.push = 'complete'; await this.awaitDeploymentConfirmation(job);
      return this.read(job.id);
    } catch (error) { return this.fail(job.id, error); }
  }

  query(jobId) { return this.read(jobId); }

  acquireLock(jobId) {
    const fd = fs.openSync(this.activeLock, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify({ jobId, pid: process.pid })); fs.closeSync(fd);
  }

  async reconcileRecovered(job) {
    if (job.status === 'restarting' || job.status === 'health_check') {
      const head = (await this.git(['rev-parse', 'HEAD'])).trim();
      if (!job.sha || head !== job.sha) throw new Error('recovered deployment SHA does not match local HEAD');
      const health = await this.checkHealth(job.sha, 60000);
      if (health.ok) {
        job.status = 'succeeded'; job.health = health; job.finishedAt = new Date().toISOString();
        await this.update(job, 'complete', { status: 'succeeded', detail: { recovered: true, health, sha: head } });
      } else {
        job.status = 'failed'; job.error = 'service restarted but recovery health check failed'; job.finishedAt = new Date().toISOString();
        await this.update(job, 'failed', { status: 'failed', error: job.error });
      }
      const watchdog = this.watchdogs.get(job.id);
      if (watchdog) clearTimeout(watchdog);
      this.watchdogs.delete(job.id);
      this.releaseLock(job.id); this.processRecoveryQueue(); return;
    }
    if (job.status === 'restart_queued') { this.armRestart(job); return; }
    if (job.status === 'running' && job.stage === 'pushing' && job.sha) {
      job.status = 'failed';
      job.error = 'push was interrupted; confirm a retry before any network write';
      job.finishedAt = new Date().toISOString();
      await this.update(job, 'failed', { status: 'failed', error: job.error });
      this.releaseLock(job.id); this.processRecoveryQueue();
      return;
    }
    if (job.stagedPaths && !job.sha) {
      try { await this.assertTarget(); await this.git(['restore', '--staged', '--', ...job.paths]); job.stagedPaths = false; }
      catch (error) { job.cleanupError = redact(error.message); }
    }
    job.status = 'failed'; job.error = 'workflow process stopped before this stage completed'; job.finishedAt = new Date().toISOString();
    await this.update(job, 'failed', { status: 'failed', error: job.error });
    this.releaseLock(job.id); this.processRecoveryQueue();
  }

  processRecoveryQueue() {
    if (this.recoveryBusy || !this.recoveryQueue.length) return;
    this.recoveryBusy = true;
    const id = this.recoveryQueue.shift();
    try { this.acquireLock(id); }
    catch (error) { this.recoveryBusy = false; if (error.code === 'EEXIST') return; return; }
    const job = this.read(id);
    Promise.resolve(job ? this.reconcileRecovered(job) : null).catch((error) => this.fail(id, error))
      .finally(() => { this.recoveryBusy = false; if (!fs.existsSync(this.activeLock)) this.processRecoveryQueue(); });
  }

  async recover() {
    fs.mkdirSync(this.jobDir, { recursive: true, mode: 0o700 }); this.releaseLock();
    const files = fs.readdirSync(this.jobDir).filter((name) => /^development-[0-9a-f-]{36}\.json$/i.test(name));
    const jobs = files.map((name) => JSON.parse(fs.readFileSync(path.join(this.jobDir, name), 'utf8')));
    const pending = jobs.filter((job) => !['succeeded', 'failed', 'cancelled', 'awaiting_commit_confirmation', 'awaiting_deploy_confirmation'].includes(job.status));
    const priority = (job) => job.status === 'restarting' || job.status === 'health_check' ? 0
      : job.status === 'restart_queued' ? 1 : job.stage === 'pushing' && job.sha ? 2 : 3;
    pending.sort((a, b) => priority(a) - priority(b) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    this.recoveryQueue = pending.map((job) => job.id); this.recoveryBusy = false; this.processRecoveryQueue();
    return jobs.map((job) => this.read(job.id));
  }

  close() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const timer of this.watchdogs.values()) clearTimeout(timer);
    this.watchdogs.clear();
    for (const controller of this.abortControllers.values()) controller.abort();
    this.abortControllers.clear();
  }
}

module.exports = { DevelopmentWorkflow, REPO_DIR, BRANCH, ORIGIN, UNIT, DEFAULT_TESTS, validatePath, collectPaths, validateTest, syntaxCheckPaths, runProgram, redact };
