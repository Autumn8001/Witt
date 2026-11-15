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
      await page.locator('#menuButton').click();
      const list = page.locator('#conversationList');
      const row = list.locator('[data-id]').first();
      await row.waitFor({state: 'visible'});
      await page.waitForTimeout(650); // let the drawer entrance finish before measuring
      const sheet = page.locator('#conversationActions');
      const box = await row.boundingBox();
      const listBox = await list.boundingBox();
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      // A real mouse can leave the list before it delivers another pointermove
      // to the list. The old timer then opens a menu after the drag was abandoned.
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(listBox.x + listBox.width + 30, y);
      await page.waitForTimeout(650);
      assert.equal(await sheet.evaluate(n => n.hidden), true, 'leaving the list cancels long press');
      await page.mouse.up();
      // Synthetic touch/pen lifecycle events cover cancellation, scrolling,
      // and movement without invoking any native bridge or server mutation.
      for (const type of ['pointerleave', 'pointercancel', 'scroll', 'pointermove', 'pointerup']) {
        await row.dispatchEvent('pointerdown', {button: 0, clientX: x, clientY: y, pointerType: 'touch'});
        await list.dispatchEvent(type, {clientX: x + 20, clientY: y, pointerType: 'touch'});
        await page.waitForTimeout(650);
        assert.equal(await sheet.evaluate(n => n.hidden), true, `${type} cancels long press`);
      }
      // Ordinary stationary long press still opens the correct conversation menu.
      await page.mouse.move(x, y);
      await page.mouse.down();
      await sheet.waitFor({state: 'visible'});
      assert.equal(await page.locator('#conversationActionsTitle').textContent(), '焦点测试');
      await page.mouse.up();
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      // Leaving and returning must not break the existing keyboard menu entry.
      const more = row.locator('.conversation-more');
      await more.focus();
      await page.keyboard.press('Enter');
      await sheet.waitFor({state: 'visible'});
      await page.keyboard.press('Escape');
      assert.equal(await more.evaluate(n => n === document.activeElement), true);
      // A short click must not leave a delayed menu behind.
      await row.click({position: {x: box.width / 2, y: box.height / 2}});
      await page.waitForTimeout(650);
      assert.equal(await sheet.evaluate(n => n.hidden), true, 'short click never opens delayed menu');
      assert.deepEqual(await page.evaluate(() => window.__writes), []);
      assert.deepEqual(errors, []);
      console.log(`PASS ${viewport.width}x${viewport.height}: real pointer exit, touch cancellation/scroll/movement/release, stationary long press, keyboard menu, short click`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
