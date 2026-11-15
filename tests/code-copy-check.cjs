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
      const page = await browser.newPage({ viewport, hasTouch: viewport.width < 1000 });
      page.setDefaultTimeout(5000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => {
        window.DropVaultAndroid = new Proxy({
          getCacheScope: () => 'copy-test', hasBundledLumoraMedia: () => false,
        }, { get: (target, key) => target[key] || (() => {}) });
      });
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.hostname !== 'witt.test') return route.abort();
        const name = decodeURIComponent(url.pathname).replace(/^\/vault\//, '') || 'index.html';
        let file = path.resolve(web, name);
        if (process.env.OVERLAY_ROOT && ['index.html', 'app-workspace-20260916-r3.js'].includes(name)) {
          file = path.resolve(process.env.OVERLAY_ROOT, name);
        }
        if ((!file.startsWith(web + path.sep) && !process.env.OVERLAY_ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
          return route.fulfill({ status: 404, body: '' });
        }
        const types = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
        return route.fulfill({ path: file, contentType: types[path.extname(file)] });
      });
      await page.goto('https://witt.test/vault/index.html');
      await page.evaluate(id => {
        window.DropVault.nativeReady({ nativeLaunch: true, workspaceFeatures: true, workspaceOperations: true, versionName: 'test', cacheScope: 'copy-test' });
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
      const source = 'const greeting = "你好 <Witt>";\nconsole.log(greeting);';
      await page.evaluate(({ id, source }) => {
        window.DropVault.onConversation(JSON.stringify({ conversation: {
          id, title: '代码复制测试', model: 'gpt-6.1-sol', messages: [{
            id: 'copy-test-message', role: 'assistant', status: 'completed', createdAt: new Date().toISOString(),
            text: '```js\n' + source + '\n```',
          }], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        } }));
        window.__copied = [];
      }, { id: conversationId, source });
      const button = page.locator('[data-copy-code]').first();
      const code = page.locator('.chat-code-block code').first();
      await button.waitFor({ state: 'visible' });
      assert.equal(await code.textContent(), source, 'test uses rendered markdown code');
      for (const mode of ['denied', 'missing', 'throws', 'success', 'success']) {
        await page.evaluate(mode => {
          window.getSelection().removeAllRanges();
          Object.defineProperty(navigator, 'clipboard', { configurable: true, value:
            mode === 'missing' ? undefined : { writeText(text) {
              if (mode === 'throws') throw new Error('simulated unavailable clipboard');
              if (mode === 'denied') return Promise.reject(new Error('simulated permission denied'));
              window.__copied.push(text); return Promise.resolve();
            } }
          });
        }, mode);
        // Activate the existing control with both keyboard and pointer input.
        if (mode === 'missing' || mode === 'success') {
          await button.focus();
          await page.keyboard.press('Enter');
        } else if (mode === 'denied' && viewport.width < 1000) await button.tap();
        else await button.click();
        if (mode === 'success') {
          await page.waitForFunction(() => document.querySelector('[data-copy-code]').textContent === '已复制');
          assert.equal(await page.evaluate(() => window.__copied.at(-1)), source);
          assert.equal(await page.evaluate(() => window.getSelection().toString()), '');
          await page.waitForFunction(() => document.querySelector('[data-copy-code]').textContent === '复制');
          assert.equal(await button.evaluate(n => n.classList.contains('copied')), false);
        } else {
          await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('手动复制'));
          assert.equal(await page.evaluate(() => window.getSelection().toString()), source, 'fallback selects only code');
          assert.equal(await button.textContent(), '复制', 'never reports copied on failure');
          assert.equal(await button.evaluate(n => n.classList.contains('copied')), false);
          if (process.env.SCREENSHOT_DIR && mode === 'missing') {
            fs.mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true });
            await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `copy-${viewport.width}.png`) });
          }
        }
        const bounds = await button.boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y >= 0 && bounds.y + bounds.height <= viewport.height, 'copy control fits viewport');
      }
      // Empty code must not copy or throw.
      await page.evaluate(() => { document.querySelector('.chat-code-block code').textContent = ''; });
      await button.click();
      assert.equal(await page.evaluate(() => window.__copied.length), 2);
      assert.deepEqual(errors, []);
      console.log(`PASS ${viewport.width}x${viewport.height}: rendered code, denied/missing/throwing clipboard, manual selection, keyboard, success/retry/reset, empty code`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
