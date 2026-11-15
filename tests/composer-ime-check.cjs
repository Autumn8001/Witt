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
      const page = await browser.newPage({ viewport, hasTouch: viewport.width !== 1280 });
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
      const input = page.locator('#messageInput');
      await page.evaluate(() => {
        window.__sends = [];
        window.DropVaultAndroid.sendChatMessageWithRequestId = (...args) => window.__sends.push(args);
      });
      // A candidate-confirmation key must neither consume the IME event nor send a draft.
      await input.fill('尚未确认的中文候选');
      for (const modifier of ['ctrlKey', 'metaKey']) {
        for (const flags of [{ isComposing: true }, { keyCode: 229 }]) {
          const consumed = await input.evaluate((node, data) => !node.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', bubbles: true, cancelable: true,
            [data.modifier]: true, ...data.flags,
          })), { modifier, flags });
          assert.equal(await page.evaluate(() => window.__sends.length), 0, 'IME confirmation must not send');
          assert.equal(consumed, false, 'IME confirmation must remain available to the input method');
          assert.equal(await input.inputValue(), '尚未确认的中文候选');
          assert.equal(await page.locator('.message.user').count(), 0, 'no optimistic message from an IME key');
        }
      }
      // Ordinary Enter and Shift+Enter remain multiline editing keys.
      await input.fill('第一行');
      await input.press('End');
      await input.press('Enter');
      await input.press('Shift+Enter');
      assert.equal(await input.inputValue(), '第一行\n\n');
      assert.deepEqual(await page.evaluate(() => window.__sends), []);
      // Once composition ends, existing Ctrl/Command+Enter shortcuts still work.
      for (const shortcut of ['Control+Enter', 'Meta+Enter']) {
        await input.fill('确认后发送：' + shortcut);
        await input.press(shortcut);
        const sends = await page.evaluate(() => window.__sends);
        assert.equal(sends.at(-1)[0], conversationId);
        assert.equal(sends.at(-1)[1], '确认后发送：' + shortcut);
        assert.equal(sends.at(-1)[2], '[]');
        // Simulate a transport failure so the next shortcut can retry independently.
        await page.evaluate(() => window.DropVault.onMessageSendError('模拟发送失败'));
      }
      assert.equal(await page.evaluate(() => window.__sends.length), 2);
      await input.fill('按钮发送保持可用');
      await page.locator('#sendButton').click();
      assert.equal(await page.evaluate(() => window.__sends.at(-1)[1]), '按钮发送保持可用');
      assert.equal(await page.evaluate(() => window.__sends.length), 3);
      assert.deepEqual(errors, []);
      assert.deepEqual(await page.evaluate(() => window.__writes), []);
      console.log(`PASS composer IME protection, multiline and send shortcuts ${viewport.width}x${viewport.height}`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
