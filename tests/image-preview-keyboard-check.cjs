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
      await page.evaluate(id => window.DropVault.onConversation(JSON.stringify({ conversation: {
        id, title: '图片预览测试', model: 'gpt-6.1-sol', messages: [{
          id: 'preview-message', role: 'assistant', status: 'completed', text: '模拟图片预览', createdAt: new Date().toISOString(),
        }], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      } })), conversationId);
      await page.evaluate(() => {
        window.__downloads = [];
        window.DropVaultAndroid.downloadImage = (...args) => window.__downloads.push(args);
        const trigger = document.createElement('button');
        trigger.style.cssText = 'position:fixed;top:80px;left:20px;z-index:20';
        trigger.type = 'button';
        trigger.id = 'previewTestImage'; trigger.textContent = '测试图片';
        trigger.dataset.inlineImage = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="teal"/></svg>');
        trigger.dataset.imageName = '测试图片.svg'; trigger.dataset.imageMime = 'image/svg+xml';
        document.querySelector('#messageList').append(trigger);
      });
      const trigger = page.locator('#previewTestImage');
      const viewer = page.locator('#imageViewer');
      const close = page.locator('#closeImageViewer');
      const download = page.locator('#downloadImageViewer');
      await trigger.focus();
      await page.keyboard.press('Enter');
      assert.equal(await viewer.getAttribute('aria-hidden'), 'false');
      assert.equal(await close.evaluate(node => node === document.activeElement), true, 'opening image moves keyboard focus into preview');
      assert.equal(await page.locator('.image-viewer-panel').getAttribute('role'), 'dialog');
      assert.equal(await page.locator('.image-viewer-panel').getAttribute('aria-modal'), 'true');
      assert.equal(await page.locator('.image-viewer-panel').getAttribute('aria-labelledby'), 'imageViewerName');
      // Both directions stay in the preview; neither enters the covered chat.
      await page.keyboard.press('Tab');
      assert.equal(await download.evaluate(node => node === document.activeElement), true);
      await page.keyboard.press('Shift+Tab');
      assert.equal(await close.evaluate(node => node === document.activeElement), true);
      await page.keyboard.press('Shift+Tab');
      assert.equal(await download.evaluate(node => node === document.activeElement), true);
      await page.keyboard.press('Tab');
      assert.equal(await close.evaluate(node => node === document.activeElement), true);
      await page.locator('#messageInput').focus();
      await page.keyboard.press('Tab');
      assert.equal(await download.evaluate(node => node === document.activeElement), true, 'Tab recovers focus moved outside preview');
      // Input methods retain Escape until composition has finished.
      for (const flags of [{ isComposing: true }, { keyCode: 229 }]) {
        await close.evaluate((node, flags) => node.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape', bubbles: true, cancelable: true, ...flags,
        })), flags);
        assert.equal(await viewer.getAttribute('aria-hidden'), 'false');
      }
      await page.keyboard.press('Escape');
      assert.equal(await viewer.getAttribute('aria-hidden'), 'true', 'Escape closes preview');
      assert.equal(await trigger.evaluate(node => node === document.activeElement), true, 'Escape restores image trigger');
      assert.equal(await page.locator('#imageViewerImage').getAttribute('src'), null);
      assert.equal(await download.getAttribute('data-url'), null);
      // Existing click/touch, native download and backdrop paths still work.
      for (const method of ['close', 'backdrop', ...(viewport.width !== 1280 ? ['touch'] : [])]) {
        if (method === 'touch') await trigger.tap();
        else await trigger.click();
        await download.click();
        const bounds = await close.boundingBox();
        assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height, 'close control in viewport');
        if (method === 'touch') await close.tap();
        else if (method === 'close') await close.click();
        else await page.locator('#imageViewerBackdrop').click({ position: { x: 2, y: 2 } });
        assert.equal(await viewer.getAttribute('aria-hidden'), 'true');
        assert.equal(await trigger.evaluate(node => node === document.activeElement), true, 'click close restores trigger');
      }
      assert.equal(await page.evaluate(() => window.__downloads.length), viewport.width === 1280 ? 2 : 3);
      assert.equal(await page.evaluate(() => window.__downloads.every(args => args[1] === '测试图片.svg' && args[2] === 'image/svg+xml')), true);
      // A launcher removed by rerender must not leave focus in a hidden viewer.
      await trigger.click();
      await trigger.evaluate(node => node.remove());
      await page.keyboard.press('Escape');
      assert.equal(await viewer.getAttribute('aria-hidden'), 'true');
      assert.equal(await page.locator('#messageInput').evaluate(node => node === document.activeElement), true);
      // Closing an already hidden viewer must not steal unrelated focus.
      await page.locator('#chatMoreButton').focus();
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#chatMoreButton').evaluate(node => node === document.activeElement), true);
      assert.deepEqual(errors, []);
      assert.deepEqual(await page.evaluate(() => window.__writes), []);
      console.log(`PASS image preview keyboard/click/download ${viewport.width}x${viewport.height}`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
