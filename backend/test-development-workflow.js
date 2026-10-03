'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const {
  DevelopmentWorkflow, REPO_DIR, BRANCH, ORIGIN, UNIT, validatePath, collectPaths, validateTest, syntaxCheckPaths, redact, runProgram,
} = require('./development-workflow');
const { createGitChangeBaseline, collectGitChanges } = require('./git-change-collector');

const TEST_DIR = path.join(REPO_DIR, '.development-workflow-test-' + process.pid);
const VERSION_SHA = 'a'.repeat(40);
const versionFetch = async (url) => ({ ok: true, status: 200, json: async () =>
  url.endsWith('/version') ? { backendSha: VERSION_SHA } :
    url.endsWith('/version.json') ? { frontendSha: VERSION_SHA } : { ok: true } });


function sourceChange(file = 'backend/development-workflow.js', extra = {}) {
  return { path: file, kind: 'update', baselineDirty: false,
    afterHash: createHash('sha256').update(fs.readFileSync(path.join(REPO_DIR, file))).digest('hex'), ...extra };
}

function fakeRunner(options = {}) {
  const calls = [];
  let staged = '';
  let headIndex = 0;
  return {
    calls,
    async runProgram(command, args, opts) {
      calls.push({ command, args: [...args], cwd: opts.cwd });
      if (options.failCommand === args[0] && command === 'git') return { code: 1, stdout: '', stderr: 'expected failure' };
      if (options.fail && options.fail(command, args)) return { code: 1, stdout: '', stderr: 'expected failure' };
      if (command === 'git') {
        if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return { code: 0, stdout: REPO_DIR };
        if (args[0] === 'branch') return { code: 0, stdout: BRANCH };
        if (args[0] === 'status') return { code: 0, stdout: options.status || '' };
        if (args[0] === 'remote') return { code: 0, stdout: ORIGIN };
        if (args[0] === 'ls-remote') return { code: 0, stdout: (options.headSha || 'a'.repeat(40)) + '\trefs/heads/' + BRANCH };
        if (args[0] === 'diff' && args[1] === '--cached' && args[2] === '--name-only') {
          return { code: 0, stdout: staged };
        }
        if (args[0] === 'add') { staged = args.slice(2).join('\0'); return { code: 0, stdout: '' }; }
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
          const sha = options.headSequence ? options.headSequence[Math.min(headIndex++, options.headSequence.length - 1)] : (options.headSha || 'a'.repeat(40));
          return { code: 0, stdout: sha };
        }
        return { code: 0, stdout: '' };
      }
      if (command === 'systemctl' && args[0] === 'is-active') return { code: 0, stdout: 'active' };
      if (command === 'systemctl' && args[0] === 'show') return { code: 0, stdout: new Date().toISOString() };
      return { code: options.testExit || 0, stdout: 'test passed', stderr: '' };
    },
  };
}

async function waitUntil(predicate, timeoutMs = 2000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for workflow state');
}

async function confirmAfterTests(workflow, jobId, commitMessage = 'test: confirmed change') {
  await waitUntil(() => ['awaiting_commit_confirmation', 'failed'].includes(workflow.query(jobId).status));
  assert.equal(workflow.query(jobId).status, 'awaiting_commit_confirmation');
  await workflow.confirmCommit(jobId, commitMessage);
}

test('path validation keeps staged files inside the worktree and expands renames', () => {
  assert.equal(validatePath('backend/a.js'), 'backend/a.js');
  assert.throws(() => validatePath('../secrets'), /escapes/);
  assert.throws(() => validatePath('/etc/passwd'), /repository-relative/);
  assert.throws(() => validatePath('.git/config'), /Git metadata/);
  assert.deepEqual(collectPaths([
    { path: 'new-name.js', oldPath: 'old-name.js', kind: 'rename', baselineDirty: false, afterHash: 'a'.repeat(64) },
  ]), ['new-name.js', 'old-name.js']);
});

test('syntax checks include only extant JavaScript destinations, including web and root paths', () => {
  assert.deepEqual(syntaxCheckPaths([
    { path: 'backend/gone.js', kind: 'delete' },
    { path: 'web/app.js', oldPath: 'backend/old.js', kind: 'rename' },
    { path: 'web/app.js', kind: 'update' },
    { path: 'root-tool.mjs', kind: 'add' },
    { path: 'assets/image.png', kind: 'update' },
  ]), ['root-tool.mjs', 'web/app.js']);
});

test('runChecks syntax-checks a renamed destination and configured test path separately', async (t) => {
  const dir = path.join(TEST_DIR, 'syntax-paths'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(TEST_DIR, { recursive: true, force: true }));
  const fake = fakeRunner();
  const workflow = new DevelopmentWorkflow({ repoDir: REPO_DIR, jobDir: dir, runProgram: fake.runProgram,
    testCommands: [{ command: 'node', args: ['backend/test-runtime-layer.js'] }] });
  const job = { id: '82345678-1234-1234-1234-123456789abc', paths: ['backend/old.js', 'web/new-app.js'],
    changes: [{ path: 'backend/old.js', kind: 'delete' }, { path: 'web/new-app.js', oldPath: 'backend/old.js', kind: 'rename' }],
    events: [] };
  const results = await workflow.runChecks(job);
  assert.equal(results.length, 2);
  assert.deepEqual(fake.calls.filter((call) => call.command === 'node').map((call) => call.args),
    [['--check', 'web/new-app.js'], ['backend/test-runtime-layer.js']]);
  workflow.close();
});

test('test runner accepts only explicit repository scripts without shell execution', () => {
  assert.deepEqual(validateTest({ command: 'node', args: ['backend/test-runtime-layer.js'] }), {
    command: 'node', args: ['backend/test-runtime-layer.js'],
  });
  assert.throws(() => validateTest({ command: 'sh', args: ['-c', 'whoami'] }), /node, python3, or bash/);
  assert.throws(() => validateTest({ command: 'bash', args: ['-c', 'echo nope'] }), /stay under backend/);
  assert.throws(() => validateTest({ command: 'node', args: ['../../outside.js'] }), /escapes/);
});

test('workflow output scrubs credential-shaped values before persistence or events', () => {
  const sample = 'WITT_CPA_API_KEY=sample-key Authorization: Bearer sample-bearer {"token":"sample-json"}';
  const cleaned = redact(sample);
  assert.doesNotMatch(cleaned, /sample-key|sample-bearer|sample-json/);
  assert.match(cleaned, /\[redacted\]/);
  const privateKey = '-----BEGIN OPENSSH PRIVATE KEY-----private-material-----END OPENSSH PRIVATE KEY-----';
  assert.doesNotMatch(redact(privateKey), /private-material/);
});

test('workflow is pinned to /opt/witt', () => {
  assert.throws(() => new DevelopmentWorkflow({ repoDir: '/tmp/witt' }), /only supports \/opt\/witt/);
  assert.equal(BRANCH, 'platform/personal-ai-ops');
  assert.equal(ORIGIN, 'git@github-witt-autumn:Autumn8001/Witt.git');
  assert.equal(UNIT, 'witt.service');
});

test('prepare, explicit commit/push, and separate deploy confirmation stay distinct', async (t) => {
  fs.mkdirSync(TEST_DIR, { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(TEST_DIR, { recursive: true, force: true }));
  const fake = fakeRunner();
  const events = [];
  const workflow = new DevelopmentWorkflow({
    repoDir: REPO_DIR,
    jobDir: TEST_DIR,
    onEvent: (event) => events.push(event),
    testCommands: [{ command: 'node', args: ['backend/test-development-workflow.js'] }],
    runProgram: fake.runProgram,
    restartDelayMs: 5000,
    fetch: versionFetch,
  });
  t.after(() => workflow.close());

  const initial = await workflow.submit({
    userId: 'user-1', conversationId: 'conversation-1', messageId: 'message-1',
    changes: [sourceChange(), { path: 'backend/deleted-file.js', kind: 'delete', baselineDirty: false, afterHash: null }],
    commitMessage: 'feat: add workflow',
  });
  assert.equal(initial.status, 'running');
  await waitUntil(() => ['awaiting_commit_confirmation', 'failed'].includes(workflow.query(initial.id).status));
  assert.equal(workflow.query(initial.id).status, 'awaiting_commit_confirmation');
  assert.equal(fake.calls.some((call) => call.command === 'git' && ['add', 'commit', 'push'].includes(call.args[0])), false);
  await workflow.confirmCommit(initial.id, 'feat: add workflow');
  await waitUntil(() => ['awaiting_deploy_confirmation', 'failed'].includes(workflow.query(initial.id).status));
  let job = workflow.query(initial.id);
  assert.equal(job.status, 'awaiting_deploy_confirmation');
  assert.equal(job.branch, BRANCH);
  assert.equal(job.userId, 'user-1');
  assert.equal(job.conversationId, 'conversation-1');
  assert.equal(job.origin, ORIGIN);
  assert.equal(job.push, 'complete');
  assert.equal(job.sha, 'a'.repeat(40));
  assert.equal(job.restartAt, null);
  assert.ok(fake.calls.some((call) => call.command === 'git' && call.args[0] === 'add' && call.args.includes('--')
    && call.args.includes('backend/deleted-file.js')));
  assert.ok(fake.calls.some((call) => call.command === 'git' && call.args[0] === 'push'
    && call.args.includes('HEAD:refs/heads/' + BRANCH) && !call.args.includes('--force')));
  assert.equal(fake.calls.some((call) => call.command === 'systemctl'), false);
  assert.ok(events.some((event) => event.job.stage === 'testing' && event.jobId === initial.id
    && event.userId === 'user-1' && event.conversationId === 'conversation-1' && event.message));

  job = await workflow.deploy(job.id);
  assert.equal(job.status, 'restart_queued');
  assert.ok(Date.parse(job.restartAt) - Date.now() >= 4900);
  job.restartAt = new Date(Date.now() - 1).toISOString();
  workflow.write(job);
  job = await workflow.restartAndCheck(job.id);
  assert.equal(job.status, 'restarting');
  assert.ok(fake.calls.some((call) => call.command === 'systemd-run' &&
    call.args.includes('/opt/witt/scripts/deploy-commit.sh') && call.args.includes(job.sha)));
  await workflow.reconcileRecovered(job);
  job = workflow.query(job.id);
  assert.equal(job.status, 'succeeded');
  assert.equal(job.health.ok, true);
});

test('failed test records a queryable failed job and never stages or pushes', async (t) => {
  const dir = path.join(TEST_DIR, 'failed');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(TEST_DIR, { recursive: true, force: true }));
  const fake = fakeRunner({ testExit: 3 });
  const workflow = new DevelopmentWorkflow({
    repoDir: REPO_DIR, jobDir: dir,
    testCommands: [{ command: 'node', args: ['backend/test-runtime-layer.js'] }],
    runProgram: fake.runProgram,
  });
  const initial = await workflow.submit({ userId: 'user-1', messageId: 'message-fail', changes: [sourceChange()], commitMessage: 'fix: fail test' });
  await waitUntil(() => workflow.query(initial.id).status === 'failed');
  const job = workflow.query(initial.id);
  assert.match(job.error, /test failed/);
  assert.equal(fake.calls.some((call) => call.command === 'git' && ['add', 'commit', 'push'].includes(call.args[0])), false);
  workflow.close();
});

test('missing provenance or a changed post-turn snapshot fails before staging', async (t) => {
  fs.mkdirSync(TEST_DIR, { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(TEST_DIR, { recursive: true, force: true }));
  const fake = fakeRunner();
  const workflow = new DevelopmentWorkflow({ repoDir: REPO_DIR, jobDir: path.join(TEST_DIR, 'snapshots'),
    testCommands: [{ command: 'node', args: ['backend/test-runtime-layer.js'] }], runProgram: fake.runProgram });
  await assert.rejects(workflow.submit({ userId: 'user-1', messageId: 'missing', changes: [{ path: 'backend/development-workflow.js' }],
    commitMessage: 'fix: require provenance' }), /not proven clean/);
  const stale = sourceChange('backend/development-workflow.js', { afterHash: 'f'.repeat(64) });
  const initial = await workflow.submit({ userId: 'user-1', messageId: 'stale', changes: [stale], commitMessage: 'fix: reject stale snapshot' });
  await waitUntil(() => workflow.query(initial.id).status === 'failed');
  assert.match(workflow.query(initial.id).error, /changed after the turn snapshot/);
  assert.equal(fake.calls.some((call) => call.command === 'git' && ['add', 'commit', 'push'].includes(call.args[0])), false);
  workflow.close();
});

test('failed commit restores only job paths; failed push retains the created SHA', async (t) => {
  fs.mkdirSync(TEST_DIR, { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(TEST_DIR, { recursive: true, force: true }));
  const failedCommit = fakeRunner({ fail: (command, args) => command === 'git' && args[0] === 'commit' });
  const first = new DevelopmentWorkflow({ repoDir: REPO_DIR, jobDir: path.join(TEST_DIR, 'commit-fail'),
    testCommands: [{ command: 'node', args: ['backend/test-runtime-layer.js'] }], runProgram: failedCommit.runProgram });
  const firstJob = await first.submit({ userId: 'user-1', messageId: 'commit-fail', changes: [sourceChange()] });
  await confirmAfterTests(first, firstJob.id, 'fix: fail commit');
  await waitUntil(() => first.query(firstJob.id).status === 'failed');
  const restore = failedCommit.calls.find((call) => call.command === 'git' && call.args[0] === 'restore');
  assert.deepEqual(restore.args, ['restore', '--staged', '--', 'backend/development-workflow.js']);
  first.close();

  const failedPush = fakeRunner({ fail: (command, args) => command === 'git' && args[0] === 'push' });
  const second = new DevelopmentWorkflow({ repoDir: REPO_DIR, jobDir: path.join(TEST_DIR, 'push-fail'),
    testCommands: [{ command: 'node', args: ['backend/test-runtime-layer.js'] }], runProgram: failedPush.runProgram });
  const secondJob = await second.submit({ userId: 'user-1', messageId: 'push-fail', changes: [sourceChange()] });
  await confirmAfterTests(second, secondJob.id, 'fix: preserve local commit');
  await waitUntil(() => second.query(secondJob.id).status === 'failed');
  assert.equal(second.query(secondJob.id).sha, 'a'.repeat(40));
  assert.equal(failedPush.calls.some((call) => call.command === 'git' && call.args[0] === 'restore'), false);
  second.close();
});


test('base SHA changes before staging or commit fail closed', async (t) => {
  const dir = path.join(TEST_DIR, 'base-sha'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(TEST_DIR, { recursive: true, force: true }));
  const fake = fakeRunner({ headSequence: ['a'.repeat(40), 'b'.repeat(40)] });
  const workflow = new DevelopmentWorkflow({ repoDir: REPO_DIR, jobDir: dir, runProgram: fake.runProgram,
    testCommands: [{ command: 'node', args: ['backend/test-runtime-layer.js'] }] });
  const initial = await workflow.submit({ userId: 'u', messageId: 'head-moved', changes: [sourceChange()],
    commitMessage: 'feat: reject moved base' });
  await waitUntil(() => workflow.query(initial.id).status === 'failed');
  assert.match(workflow.query(initial.id).error, /HEAD does not match/);
  assert.equal(fake.calls.some((call) => call.command === 'git' && ['add', 'commit', 'push'].includes(call.args[0])), false);
  workflow.close();
});

test('push and restart refuse a HEAD different from the recorded job SHA', async (t) => {
  const dir = path.join(TEST_DIR, 'head-before-deploy'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(TEST_DIR, { recursive: true, force: true }));
  const fake = fakeRunner({ headSequence: [...Array(7).fill('a'.repeat(40)), 'b'.repeat(40)] });
  const workflow = new DevelopmentWorkflow({ repoDir: REPO_DIR, jobDir: dir, runProgram: fake.runProgram,
    testCommands: [{ command: 'node', args: ['backend/test-runtime-layer.js'] }] });
  const initial = await workflow.submit({ userId: 'u', messageId: 'head-before-push', changes: [sourceChange()] });
  await confirmAfterTests(workflow, initial.id, 'feat: reject moved head');
  await waitUntil(() => workflow.query(initial.id).status === 'failed');
  assert.equal(workflow.query(initial.id).sha, 'a'.repeat(40));
  assert.match(workflow.query(initial.id).error, /HEAD does not match/);
  assert.equal(fake.calls.some((call) => call.command === 'git' && call.args[0] === 'push'), false);

  const restartFake = fakeRunner({ headSha: 'b'.repeat(40) });
  const restartWorkflow = new DevelopmentWorkflow({ repoDir: REPO_DIR, jobDir: path.join(dir, 'restart'),
    runProgram: restartFake.runProgram });
  const job = { id: 'a2345678-1234-1234-1234-123456789abc', status: 'restart_queued', stage: 'restart_queued',
    sha: 'a'.repeat(40), restartAt: new Date().toISOString(), events: [] };
  restartWorkflow.write(job);
  await assert.rejects(restartWorkflow.restartAndCheck(job.id), /HEAD does not match/);
  assert.equal(restartFake.calls.some((call) => call.command === 'systemd-run'), false);
  restartWorkflow.close(); workflow.close();
});

test('recovery does not push a pending job when local HEAD moved', async (t) => {
  const dir = path.join(TEST_DIR, 'recover-head-moved'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(TEST_DIR, { recursive: true, force: true }));
  const fake = fakeRunner({ headSha: 'b'.repeat(40) });
  const workflow = new DevelopmentWorkflow({ repoDir: REPO_DIR, jobDir: dir, runProgram: fake.runProgram });
  const job = { id: 'b2345678-1234-1234-1234-123456789abc', status: 'running', stage: 'pushing',
    sha: 'a'.repeat(40), paths: [], changes: [], events: [] };
  workflow.write(job);
  await workflow.recover();
  await waitUntil(() => workflow.query(job.id).status === 'failed');
  assert.match(workflow.query(job.id).error, /push was interrupted/);
  assert.equal(fake.calls.some((call) => call.command === 'git' && call.args[0] === 'push'), false);
  workflow.close();
});

test('delete pathspec stages only the tracked deletion', (t) => {
  const repo = path.join(TEST_DIR, 'delete-pathspec');
  fs.mkdirSync(repo, { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.name', 'Witt test');
  git('config', 'user.email', 'witt-test@example.invalid');
  fs.writeFileSync(path.join(repo, 'deleted.txt'), 'tracked\n');
  fs.writeFileSync(path.join(repo, 'unrelated.txt'), 'keep\n');
  git('add', '--', 'deleted.txt', 'unrelated.txt');
  git('commit', '-qm', 'fixture');
  fs.unlinkSync(path.join(repo, 'deleted.txt'));
  git('add', '--', 'deleted.txt');
  const staged = execFileSync('git', ['-C', repo, 'diff', '--cached', '--name-status'], { encoding: 'utf8' });
  assert.equal(staged.trim(), 'D\tdeleted.txt');
  assert.equal(fs.readFileSync(path.join(repo, 'unrelated.txt'), 'utf8'), 'keep\n');
});

test('recover restores a persisted delayed restart and reconciles a process interrupted during restart', async (t) => {
  const dir = path.join(TEST_DIR, 'recover');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(TEST_DIR, { recursive: true, force: true }));
  const fake = fakeRunner();
  const workflow = new DevelopmentWorkflow({ repoDir: REPO_DIR, jobDir: dir, runProgram: fake.runProgram,
    fetch: versionFetch });
  const restartQueued = {
    id: '12345678-1234-1234-1234-123456789abc', messageId: 'm', status: 'restart_queued', stage: 'restart_queued',
    restartAt: new Date(Date.now() + 60000).toISOString(), events: [],
  };
  workflow.write(restartQueued);
  const [restored] = await workflow.recover();
  assert.equal(restored.status, 'restart_queued');
  assert.equal(workflow.timers.size, 1);
  workflow.close();

  const interruptedDir = path.join(TEST_DIR, 'interrupted');
  fs.mkdirSync(interruptedDir, { recursive: true, mode: 0o700 });
  const interruptedWorkflow = new DevelopmentWorkflow({ repoDir: REPO_DIR, jobDir: interruptedDir, runProgram: fake.runProgram,
    fetch: versionFetch });
  const interrupted = { ...restartQueued, id: '22345678-1234-1234-1234-123456789abc', sha: 'a'.repeat(40), status: 'restarting', stage: 'restarting',
    restartStartedAt: new Date(Date.now() - 1000).toISOString() };
  interruptedWorkflow.write(interrupted);
  await interruptedWorkflow.recover();
  await waitUntil(() => interruptedWorkflow.query(interrupted.id).status === 'succeeded');
  const reconciled = interruptedWorkflow.query(interrupted.id);
  assert.equal(reconciled.health.ok, true);
  interruptedWorkflow.close();
});


test('recovery serializes multiple pending jobs under one global lock', async (t) => {
  const dir = path.join(TEST_DIR, 'multiple-recovery'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(TEST_DIR, { recursive: true, force: true }));
  const fake = fakeRunner();
  const workflow = new DevelopmentWorkflow({ repoDir: REPO_DIR, jobDir: dir, runProgram: fake.runProgram,
    fetch: versionFetch });
  for (const [id, status] of [
    ['32345678-1234-1234-1234-123456789abc', 'restarting'],
    ['42345678-1234-1234-1234-123456789abc', 'health_check'],
  ]) workflow.write({ id, userId: 'u', conversationId: 'c', sha: 'a'.repeat(40), messageId: id,
    status, stage: status, events: [], createdAt: id });
  await workflow.recover();
  await waitUntil(() => ['succeeded', 'failed'].includes(workflow.query('32345678-1234-1234-1234-123456789abc').status)
    && ['succeeded', 'failed'].includes(workflow.query('42345678-1234-1234-1234-123456789abc').status));
  assert.equal(workflow.query('32345678-1234-1234-1234-123456789abc').status, 'succeeded');
  assert.equal(workflow.query('42345678-1234-1234-1234-123456789abc').status, 'succeeded');
  workflow.close();
});

test('unrelated tracked edits block submit before tests or staging', async (t) => {
  const dir = path.join(TEST_DIR, 'unrelated-edit'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(TEST_DIR, { recursive: true, force: true }));
  const fake = fakeRunner({ status: ' M web/unrelated.js\0 M docs/unrelated.md\0' });
  const workflow = new DevelopmentWorkflow({ repoDir: REPO_DIR, jobDir: dir, runProgram: fake.runProgram,
    testCommands: [{ command: 'node', args: ['backend/test-runtime-layer.js'] }] });
  await assert.rejects(workflow.submit({ userId: 'u', messageId: 'dirty', changes: [sourceChange()],
    commitMessage: 'feat: should not deploy' }), /unrelated tracked worktree changes/);
  assert.equal(fake.calls.some((call) => call.command === 'node'), false);
  workflow.close();
});

test('cancel aborts pre-commit work and cannot be reported as failed or cancelled after commit', async (t) => {
  const dir = path.join(TEST_DIR, 'cancel'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(TEST_DIR, { recursive: true, force: true }));
  const calls = [];
  const runner = async (command, args, opts) => {
    calls.push({ command, args });
    if (command === 'git') {
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return { code: 0, stdout: REPO_DIR };
      if (args[0] === 'branch') return { code: 0, stdout: BRANCH };
      if (args[0] === 'remote') return { code: 0, stdout: ORIGIN };
      if (args[0] === 'status') return { code: 0, stdout: '' };
      if (args[0] === 'rev-parse') return { code: 0, stdout: 'a'.repeat(40) };
    }
    return new Promise((resolve) => opts.signal.addEventListener('abort', () => resolve({ code: 1, stdout: '', stderr: 'aborted' }), { once: true }));
  };
  const workflow = new DevelopmentWorkflow({ repoDir: REPO_DIR, jobDir: dir, runProgram: runner,
    testCommands: [{ command: 'node', args: ['backend/test-runtime-layer.js'] }] });
  const job = await workflow.submit({ userId: 'u', messageId: 'cancel-me', changes: [sourceChange()],
    commitMessage: 'feat: cancel safely' });
  await waitUntil(() => workflow.query(job.id).stage === 'testing');
  const cancelled = await workflow.cancel(job.id);
  assert.equal(cancelled.status, 'cancelled');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(workflow.query(job.id).status, 'cancelled');
  assert.equal(calls.some((call) => call.command === 'git' && ['commit', 'push'].includes(call.args[0])), false);
  await assert.rejects(workflow.cancel('not-a-valid-existing-job'), /invalid workflow job id/);
  workflow.close();
});

test('resumePush reuses the recorded commit and refuses changed HEAD', async (t) => {
  const dir = path.join(TEST_DIR, 'resume-push'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(TEST_DIR, { recursive: true, force: true }));
  const fake = fakeRunner();
  const workflow = new DevelopmentWorkflow({ repoDir: REPO_DIR, jobDir: dir, runProgram: fake.runProgram,
    restartDelayMs: 5000 });
  const job = { id: '52345678-1234-1234-1234-123456789abc', userId: 'u', messageId: 'm', status: 'failed',
    stage: 'failed', sha: 'a'.repeat(40), paths: [], changes: [], events: [], commitMessage: 'already committed' };
  workflow.write(job);
  const resumed = await workflow.resumePush(job.id);
  assert.equal(resumed.status, 'awaiting_deploy_confirmation');
  assert.equal(resumed.sha, job.sha);
  assert.ok(fake.calls.some((call) => call.command === 'git' && call.args[0] === 'push'
    && call.args.includes('HEAD:refs/heads/' + BRANCH)));
  workflow.close();
});


test('a new service process resumes a restart interrupted by its own systemctl restart', async (t) => {
  const dir = path.join(TEST_DIR, 'process-death'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(TEST_DIR, { recursive: true, force: true }));
  const job = { id: '62345678-1234-1234-1234-123456789abc', userId: 'u', conversationId: 'c',
    messageId: 'm', status: 'restart_queued', stage: 'restart_queued', sha: 'a'.repeat(40),
    restartAt: new Date(Date.now() - 5).toISOString(), paths: [], changes: [], events: [] };
  const writer = new DevelopmentWorkflow({ repoDir: REPO_DIR, jobDir: dir });
  writer.write(job);
  const childCode = `
    const { DevelopmentWorkflow, REPO_DIR, BRANCH, ORIGIN } = require('./backend/development-workflow');
    const dir = process.argv[1];
    const runProgram = async (command, args) => {
      if (command === 'systemd-run') process.exit(0);
      if (command === 'git') {
        if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return {code:0,stdout:REPO_DIR};
        if (args[0] === 'branch') return {code:0,stdout:BRANCH};
        if (args[0] === 'remote') return {code:0,stdout:ORIGIN};
        if (args[0] === 'ls-remote') return {code:0,stdout:'a'.repeat(40)+'\trefs/heads/'+BRANCH};
        if (args[0] === 'status') return {code:0,stdout:''};
        if (args[0] === 'rev-parse') return {code:0,stdout:'a'.repeat(40)};
      }
      return {code:0,stdout:''};
    };
    const w = new DevelopmentWorkflow({repoDir:REPO_DIR,jobDir:dir,runProgram});
    w.recover();
    setTimeout(()=>process.exit(9),3000);
  `;
  execFileSync(process.execPath, ['-e', childCode, dir], { cwd: REPO_DIR, timeout: 5000, stdio: 'ignore' });
  const resumed = new DevelopmentWorkflow({ repoDir: REPO_DIR, jobDir: dir, runProgram: fakeRunner().runProgram,
    fetch: versionFetch });
  await resumed.recover();
  await waitUntil(() => resumed.query(job.id).status === 'succeeded');
  assert.equal(resumed.query(job.id).health.ok, true);
  resumed.close();
});


test('runProgram enforces a hard timeout for a child that ignores SIGTERM', async () => {
  const started = Date.now();
  const result = await runProgram(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],
    { cwd: REPO_DIR, timeoutMs: 40 });
  assert.notEqual(result.code, 0);
  assert.ok(Date.now() - started < 3000, 'hard timeout should not leave the process hanging');
});

test('isolated Git fixture completes Diff, test, explicit commit and local push without production access', async (t) => {
  const fixture = fs.mkdtempSync(path.join(REPO_DIR, '.git/witt-workflow-fixture-'));
  const repo = path.join(fixture, 'project');
  const remote = path.join(fixture, 'remote.git');
  fs.mkdirSync(repo, { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const git = (where, ...args) => execFileSync('git', ['-C', where, ...args], { encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '--bare', '-q', remote], { stdio: 'ignore' });
  git(repo, 'init', '-q', '-b', BRANCH);
  git(repo, 'config', 'user.name', 'Witt workflow fixture');
  git(repo, 'config', 'user.email', 'witt-workflow@example.invalid');
  git(repo, 'remote', 'add', 'origin', remote);
  fs.mkdirSync(path.join(repo, 'tests'));
  fs.writeFileSync(path.join(repo, 'src.js'), "module.exports = 'before';\n");
  fs.writeFileSync(path.join(repo, 'tests/check.js'),
    "const assert = require('node:assert/strict'); assert.equal(require('../src'), 'after');\n");
  git(repo, 'add', '--', 'src.js', 'tests/check.js');
  git(repo, 'commit', '-qm', 'fixture baseline');
  git(repo, 'push', '-q', 'origin', 'HEAD:refs/heads/' + BRANCH);
  const baseline = await createGitChangeBaseline(repo);
  fs.writeFileSync(path.join(repo, 'src.js'), "module.exports = 'after';\n");
  const collected = await collectGitChanges(baseline);
  assert.equal(collected.changes.length, 1);
  assert.equal(collected.changes[0].path, 'src.js');
  assert.match(collected.changes[0].diff, /after/);
  const workflow = new DevelopmentWorkflow({
    repoDir: repo, jobDir: path.join(repo, '.git', 'jobs'), testOnly: true, origin: remote,
    testCommands: [{ command: 'node', args: ['tests/check.js'] }],
  });
  t.after(() => workflow.close());
  const job = await workflow.submit({ userId: 'fixture', messageId: 'fixture-message',
    changes: collected.changes });
  await waitUntil(() => ['awaiting_commit_confirmation', 'failed'].includes(workflow.query(job.id).status), 5000);
  assert.equal(workflow.query(job.id).status, 'awaiting_commit_confirmation');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), baseline.headSha);
  assert.equal(git(remote, 'rev-parse', 'refs/heads/' + BRANCH), baseline.headSha);
  fs.writeFileSync(path.join(repo, 'src.js'), "module.exports = 'changed-after-tests';\n");
  await assert.rejects(workflow.confirmCommit(job.id, 'test: stale fixture'), /changed after the turn snapshot/);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), baseline.headSha);
  assert.equal(git(remote, 'rev-parse', 'refs/heads/' + BRANCH), baseline.headSha);
  fs.writeFileSync(path.join(repo, 'src.js'), "module.exports = 'after';\n");
  await workflow.confirmCommit(job.id, 'test: confirmed local fixture');
  await waitUntil(() => ['awaiting_deploy_confirmation', 'failed'].includes(workflow.query(job.id).status), 5000);
  const completed = workflow.query(job.id);
  assert.equal(completed.status, 'awaiting_deploy_confirmation');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), completed.sha);
  assert.equal(git(remote, 'rev-parse', 'refs/heads/' + BRANCH), completed.sha);
  assert.equal(git(repo, 'status', '--porcelain'), '');
  await assert.rejects(workflow.deploy(job.id), /test fixture cannot restart/);
});

test('deployment watchdog fails an old process when the transient unit never delivers both SHAs', async (t) => {
  const dir = path.join(TEST_DIR, 'watchdog');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(TEST_DIR, { recursive: true, force: true }));
  const fake = fakeRunner();
  const workflow = new DevelopmentWorkflow({ repoDir: REPO_DIR, jobDir: dir,
    runProgram: fake.runProgram,
    fetch: async (url) => ({ ok: true, status: 200, json: async () =>
      url.endsWith('/version') ? { backendSha: 'b'.repeat(40) } :
        url.endsWith('/version.json') ? { frontendSha: 'a'.repeat(40) } : { ok: true } }),
  });
  const job = { id: '72345678-1234-1234-1234-123456789abc', status: 'restarting',
    stage: 'restarting', sha: 'a'.repeat(40), deploymentUnit: 'witt-deploy-test',
    paths: [], changes: [], events: [] };
  workflow.write(job);
  const result = await workflow.watchdogCheck(job.id);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /did not reach the requested backend\/frontend SHA/);
  assert.equal(fake.calls.some((call) => call.command === 'systemctl' &&
    call.args.includes('witt-deploy-test.service')), true);
  workflow.close();
});
