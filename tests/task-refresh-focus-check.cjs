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
      const row = page.locator('[data-select-task="task-a"]');
      await page.locator('#taskOverviewSheet section header button').focus();
      await page.keyboard.press('Tab');
      assert.equal(await row.evaluate(node => node === document.activeElement), true);
      await page.evaluate(() => window.__renderTasks([...window.__tasks].reverse()));
      assert.equal(await row.evaluate(node => node === document.activeElement), true, 'refresh keeps task row focus');
      await page.keyboard.press('Tab');
      const cancel = page.locator('[data-task-action="cancel"][data-id="task-a"]');
      assert.equal(await cancel.evaluate(node => node === document.activeElement), true);
      await page.evaluate(() => window.__renderTasks());
      assert.equal(await cancel.evaluate(node => node === document.activeElement), true, 'refresh keeps action focus');
      // A vanished action or task returns to the stable refresh control.
      await page.evaluate(() => window.__renderTasks([
        { ...window.__tasks[0], taskStatus: { state: 'running' } }, window.__tasks[1],
      ]));
      const refresh = page.locator('#taskOverviewRefresh');
      assert.equal(await refresh.evaluate(node => node === document.activeElement), true, 'vanished action fallback');
      await row.focus();
      await page.evaluate(() => window.__renderTasks([]));
      assert.equal(await refresh.evaluate(node => node === document.activeElement), true, 'vanished row fallback');
      await page.evaluate(() => window.__renderTasks());
      await page.locator('[data-task-action="retry"]').focus();
      await page.evaluate(() => window.__renderTasks());
      assert.equal(await page.locator('[data-task-action="retry"]').evaluate(node => node === document.activeElement), true);
      // Refresh while focus is outside the list must leave it alone.
      await refresh.focus();
      await page.evaluate(() => window.__renderTasks());
      assert.equal(await refresh.evaluate(node => node === document.activeElement), true);
      await page.keyboard.press('Tab');
      assert.equal(await page.locator('#taskOverviewSheet > button').evaluate(node => node === document.activeElement), true, 'Tab still wraps');
      await page.keyboard.press('Escape');
      const trigger = page.locator('#taskFocusTrigger');
      assert.equal(await trigger.evaluate(node => node === document.activeElement), true);
      await page.evaluate(() => window.__renderTasks());
      assert.equal(await trigger.evaluate(node => node === document.activeElement), true, 'hidden refresh never steals focus');
      // Enter on the restored row still selects exactly the intended task.
      await trigger.click();
      await page.evaluate(() => {
        window.__selected = [];
        window.WittUI.select = id => window.__selected.push(id);
        window.__renderTasks();
      });
      await row.focus();
      await page.evaluate(() => window.__renderTasks());
      await page.keyboard.press('Enter');
      assert.deepEqual(await page.evaluate(() => window.__selected), ['task-a']);
      assert.equal(await page.locator('#taskOverviewSheet').evaluate(node => node.hidden), true);
      assert.deepEqual(await page.evaluate(() => window.__writes), []);
      assert.deepEqual(errors, []);
      console.log(`PASS ${viewport.width}x${viewport.height}: row/action refresh, reorder, vanished action/task, outside and hidden focus, Tab/Escape`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
