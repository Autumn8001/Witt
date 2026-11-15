// All requests and user state are simulated; this test never contacts a server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const web = path.resolve(process.env.WEB_ROOT || path.join(__dirname, '../web'));
const conversationId = '00000000-0000-4000-8000-000000000001';

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
      const page = await browser.newPage({ viewport });
      page.setDefaultTimeout(5000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => {
        window.WittFeatures = { request: async () => { throw new Error('Mock task action not configured'); }, watch() {} };
        window.DropVaultAndroid = new Proxy({
          getCacheScope: () => 'focus-test', hasBundledLumoraMedia: () => false,
        }, { get: (target, key) => target[key] || (() => {}) });
      });
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.hostname !== 'witt.test') return route.abort();
        const name = decodeURIComponent(url.pathname).replace(/^\/vault\//, '') || 'index.html';
        const file = path.resolve(web, name);
        if (!file.startsWith(web + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
          return route.fulfill({ status: 404, body: '' });
        }
        const types = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
        return route.fulfill({ path: file, contentType: types[path.extname(file)] });
      });
      await page.goto('https://witt.test/vault/index.html');
      await page.evaluate(id => {
        window.DropVault.nativeReady({ nativeLaunch: true, workspaceFeatures: true, workspaceOperations: true, versionName: 'test', cacheScope: 'focus-test' });
        window.DropVault.onAuthStatus(JSON.stringify({ initialized: true, authenticated: true, principal: { admin: false, label: '测试用户' } }));
      });
      await page.waitForTimeout(100); // let the empty simulated cache hydrate first
      await page.evaluate(id => {
        window.DropVault.onConversationCreated(JSON.stringify({ conversation: {
          id, title: '焦点测试', model: 'gpt-6.1-sol', messages: [], workDir: '',
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        } }));
        window.DropVault.onConversations(JSON.stringify({ conversations: [{ id, title: '焦点测试', busy: false }] }));
        window.__writes = [];
        window.WittUI.updateMetadata = (id, changes) => { window.__writes.push({ id, changes }); return true; };
      }, conversationId);
      await page.locator('#bootScreen').waitFor({ state: 'hidden' });
      await page.evaluate(() => {
        const trigger = document.createElement('button');
        trigger.id = 'taskFocusTrigger'; trigger.textContent = '测试任务列表';
        trigger.style.cssText = 'position:fixed;top:2px;left:2px;z-index:100';
        trigger.onclick = () => document.querySelector('#taskOverviewButton').click();
        document.body.append(trigger);
        window.__tasks = [
          { id: 'task-a', title: '测试任务 A', taskStatus: { state: 'queued' } },
          { id: 'task-b', title: '测试任务 B', taskStatus: { state: 'failed' } },
        ];
        window.__renderTasks = tasks => window.WittUpgrades.renderTasks(tasks || window.__tasks, 2);
      });
      await page.locator('#taskFocusTrigger').click();
      await page.evaluate(() => window.__renderTasks());
      await page.evaluate(() => {
        window.__requests = [];
        window.__refreshes = 0;
        window.WittUI.refreshSummaries = () => { window.__refreshes++; };
        window.WittFeatures.request = (endpoint, method, body) => new Promise((resolve, reject) => {
          window.__requests.push({ endpoint, method, body, resolve, reject });
        });
      });
      const cancel = page.locator('[data-task-action="cancel"][data-id="task-a"]');
      const retry = page.locator('[data-task-action="retry"][data-id="task-b"]');
      await cancel.click();
      assert.equal(await cancel.isDisabled(), true);
      await page.evaluate(() => window.__renderTasks([...window.__tasks].reverse()));
      assert.equal(await cancel.isDisabled(), true, 'refresh must keep pending action disabled');
      // Even delegated synthetic clicks cannot bypass the in-flight guard.
      await cancel.dispatchEvent('click');
      assert.equal(await page.evaluate(() => window.__requests.length), 1, 'pending action submitted once');
      await page.keyboard.press('Escape');
      await page.locator('#taskFocusTrigger').click();
      await page.evaluate(() => window.__renderTasks());
      assert.equal(await cancel.isDisabled(), true, 'close/reopen retains pending state');
      assert.equal(await retry.isEnabled(), true, 'other tasks remain usable');
      await retry.focus();
      await page.keyboard.press('Enter');
      assert.equal(await retry.isDisabled(), true);
      assert.deepEqual(await page.evaluate(() => window.__requests.map(({ endpoint, method, body }) => ({ endpoint, method, body }))), [
        { endpoint: 'chat/conversations/task-a/cancel', method: 'POST', body: {} },
        { endpoint: 'chat/conversations/task-b/retry', method: 'POST', body: {} },
      ]);
      // A refresh may change which operation the same task offers.
      await page.evaluate(() => window.__renderTasks([
        { ...window.__tasks[0], taskStatus: { state: 'failed' } }, window.__tasks[1],
      ]));
      const changedAction = page.locator('[data-task-action="retry"][data-id="task-a"]');
      assert.equal(await changedAction.isDisabled(), true, 'same task stays guarded across state changes');
      await changedAction.dispatchEvent('click');
      assert.equal(await page.evaluate(() => window.__requests.length), 2);
      await page.evaluate(() => window.__requests[0].reject(new Error('模拟请求失败')));
      await page.waitForFunction(() => !document.querySelector('[data-task-action="retry"][data-id="task-a"]').disabled);
      assert.equal(await retry.isDisabled(), true, 'settling one task keeps the other guarded');
      await page.evaluate(() => window.__renderTasks());
      assert.equal(await cancel.isEnabled(), true, 'failed request permits retry');
      await cancel.click();
      await page.evaluate(() => {
        window.__refreshes = 0;
        window.__renderTasks();
        window.__requests[2].resolve({});
        window.__requests[1].resolve({});
      });
      await page.waitForFunction(() => [...document.querySelectorAll('[data-task-action]')].every(b => !b.disabled));
      assert.equal(await page.evaluate(() => window.__refreshes), 2);
      // Synchronous request failures also release the guard.
      await page.evaluate(() => { window.WittFeatures.request = () => { throw new Error('模拟同步失败'); }; });
      await cancel.click();
      assert.equal(await cancel.isEnabled(), true);
      await page.evaluate(() => window.__renderTasks());
      assert.equal(await cancel.isEnabled(), true);
      // Pending controls are skipped by keyboard navigation.
      await page.evaluate(() => {
        window.WittFeatures.request = () => new Promise(resolve => { window.__finish = resolve; });
      });
      await cancel.click();
      await page.locator('[data-select-task="task-a"]').focus();
      await page.keyboard.press('Tab');
      assert.equal(await page.locator('[data-select-task="task-b"]').evaluate(node => node === document.activeElement), true);
      const rect = await retry.boundingBox();
      assert.ok(rect && rect.x >= 0 && rect.x + rect.width <= viewport.width && rect.y >= 0 && rect.y + rect.height <= viewport.height, 'enabled action stays in viewport');
      await page.evaluate(() => window.__finish({}));
      await page.waitForFunction(() => !document.querySelector('[data-task-action="cancel"]').disabled);
      assert.deepEqual(await page.evaluate(() => window.__writes), []);
      assert.deepEqual(errors, []);
      console.log(`PASS ${viewport.width}x${viewport.height}: pending refresh/reopen/state change, duplicate guard, independent tasks, failure/retry, sync error, keyboard`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
