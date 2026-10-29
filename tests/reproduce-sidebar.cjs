const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../web');
const output = process.env.CHLOE_UI_OUTPUT || path.resolve(__dirname,'artifacts/sidebar-repair');
fs.mkdirSync(output, { recursive: true });

const models = [
  { id: 'grok-4.7-high', displayName: 'Grok 4.7 High', isDefault: true, reasoningEfforts: [{id:'medium'},{id:'high'}] },
  { id: 'gemini-3.8-flash-high', displayName:'Gemini 3.8 Flash', reasoningEfforts:[{id:'high'}] }
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const results = [];
    for (const width of [360,390,768,1440,1910]) {
    const page = await browser.newPage({ viewport: { width, height: width<700?844:980 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.stack));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

    const conversation = {
      id: '10000000-0000-4000-8000-000000000001',
      title: '测试会话',
      model: models[0].id,
      reasoning: 'high',
      accessMode: 'workspace-write',
      harnessId: 'grok-build',
      codexProfile: 'default',
      workDir: '',
      busy: false,
      messages: [],
      updatedAt: new Date().toISOString()
    };

    await page.route('https://chloe.test/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/vault/')) {
        const file = path.join(root, decodeURIComponent(url.pathname.slice(7)));
        if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
          if (url.pathname.endsWith('version.json')) return route.fulfill({ json: { frontendSha: '4f7b580' } });
          return route.fulfill({ status: 404, body: 'Missing asset' });
        }
        return route.fulfill({ path: file });
      }
      let body = {};
      if (url.pathname.endsWith('/auth/status')) {
        body = { initialized: true, authenticated: true, principal: { admin: true, label: 'Test admin', codexProfiles: ['default'], allowedCodexProfiles: ['default'] } };
      } else if (url.pathname.endsWith('/chat/capabilities')) {
        body = { models, defaultModel: models[0].id, defaultAccessMode: 'workspace-write', accessModes: ['read-only', 'workspace-write', 'danger-full-access'], runtime: { codex: { available: true }, 'grok-build': { available: true }, 'google-antigravity': { available: true } }, support: { fork: true, compact: true, review: true }, skills: [], mcpServers: [], features: [], codexProfile: 'default' };
      } else if (url.pathname.endsWith('/chat/conversations')) {
        body = { conversations: [conversation], workspaceFeatures: true };
      } else if (url.pathname.includes('/events')) {
        return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
      } else if (url.pathname.endsWith('/runtime/profiles')) {
        body = { profiles: [{ id: 'p1', name: 'Grok Build', model: 'grok-4.7-high', harness: 'grok-build', reasoning: 'high' }] };
      } else if (url.pathname.endsWith('/servers/overview')) {
        body = { cpu: { count: 2 }, memory: { total: 100, used: 20 }, services: [], checkedAt: '2026-10-28' };
      } else if (url.pathname.includes('/remote-assist/sessions')) {
        body = { sessions: [] };
      } else if (url.pathname.endsWith('/customer-devices') || url.pathname.endsWith('/remote-workspaces/options')) {
        body = { devices: [], capabilities: {}, roots: {}, models: [] };
      } else if (url.pathname.endsWith('/admin/devices')) {
        body = { devices: [] };
      } else if (url.pathname.endsWith('/codex/accounts')) {
        body = { accounts: [{ profile: 'default', label: '默认账号', authenticated: true, active: true }] };
      } else if (url.pathname.includes('/quota')) {
        body = { status: 'ok', accounts: [] };
      } else if (url.pathname.includes('/usage')) {
        body = { summary: {}, dailyUsageBuckets: [], rateLimits: {}, account: {} };
      }
      return route.fulfill({ json: body });
    });

    await page.goto('https://chloe.test/vault/index.html');
    await page.waitForTimeout(1000);

    // Initial state screenshot
    await page.screenshot({ path: path.join(output, `before-${width}.png`) });

    const chatBefore = await page.locator('.app-shell').boundingBox();
    if(width<1000)await page.locator('#menuButton').click();
    // Click avatar
    await page.locator('#drawerAvatar').click();
    await page.waitForTimeout(500);

    // Screenshot open state
    await page.screenshot({ path: path.join(output, `after-${width}.png`) });

    // Inspect geometry of drawerAccountMenu and children
    const layout = await page.evaluate(() => {
      const menu = document.querySelector('#drawerAccountMenu');
      const panel = menu?.querySelector('.user-settings-panel');
      const backdrop = menu?.querySelector('#userSettingsBackdrop');
      const custBtn = document.querySelector('#customerDevicesButton');
      const runBtn = document.querySelector('#runtimeSettingsButton');
      const drawer = document.querySelector('#drawer');
      const chat = document.querySelector('.chat-stage');

      const rect = el => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const cs = window.getComputedStyle(el);
        return {
          x: r.x, y: r.y, width: r.width, height: r.height,
          display: cs.display, position: cs.position,
          zIndex: cs.zIndex, flex: cs.flex,
          parent: el.parentElement?.id || el.parentElement?.className, insidePanel:!!el.closest('.user-settings-panel')
        };
      };

      return {
        menuHidden: menu?.hidden,
        menuRect: rect(menu),
        panelRect: rect(panel),
        backdropRect: rect(backdrop),
        custBtnRect: rect(custBtn),
        runBtnRect: rect(runBtn),
        drawerRect: rect(drawer),
        chatRect: rect(chat)
      };
    });

    assert.equal(layout.menuHidden,false);
    assert.ok(layout.panelRect.width>=Math.min(width-24,360) && layout.panelRect.width<=440);
    assert.ok(layout.panelRect.x>=0 && layout.panelRect.x+layout.panelRect.width<=width+1);
    for(const item of [layout.custBtnRect,layout.runBtnRect]){
      assert.equal(item.insidePanel,true);
      assert.ok(item.x>=layout.panelRect.x&&item.x+item.width<=layout.panelRect.x+layout.panelRect.width+1);
    }
    await page.locator('#closeDrawerAccount').click();
    await page.locator('#drawerAccountMenu').waitFor({state:'hidden'});
    if(width<1000)await page.locator('#drawerBackdrop').click({position:{x:width-2,y:20}});
    await page.locator('#messageInput').click();
    const chatAfter=await page.locator('.app-shell').boundingBox();
    assert.equal(chatBefore.width,chatAfter.width);
    await page.evaluate(()=>window.DropVault.onAuthStatus(JSON.stringify({initialized:true,authenticated:true,principal:{admin:false,codexProfiles:['default']}})));
    assert.equal(await page.locator('#customerDevicesButton').isHidden(),true);
    assert.deepEqual(errors,[]);
    results.push({width,panelWidth:layout.panelRect.width,buttonsInside:true,mainWidthStable:true,ordinaryUserRestricted:true,errors});
    await page.close();
    }
    fs.writeFileSync(path.join(output,'sidebar-results.json'),JSON.stringify(results,null,2));
    console.log(JSON.stringify(results));

  } finally {
    await browser.close();
  }
})().catch(e=>{console.error(e);process.exitCode=1;});

