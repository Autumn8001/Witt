const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../web');
const output = process.env.CHLOE_UI_OUTPUT || path.resolve(__dirname,'artifacts/home-layout');
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

    await page.goto('https://chloe.test/vault/index.html');await page.waitForTimeout(800);
    const layout=await page.evaluate(()=>{
      const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,width:r.width,center:r.x+r.width/2,right:r.right}};
      return {app:rect('.app-shell'),welcome:rect('.welcome'),composer:rect('.composer-wrap'),messages:rect('.messages'),messagesVisible:!!document.querySelector('.messages').getClientRects().length,overflow:document.documentElement.scrollWidth>innerWidth+1};
    });
    assert.equal(layout.overflow,false);
    if(width>=900){
      const target=260+(width-260)/2;
      assert.ok(Math.abs(layout.app.width-(width-260))<2);
      for(const key of ['welcome','composer',...(layout.messagesVisible?['messages']:[])])assert.ok(Math.abs(layout[key].center-target)<2,`${key} must center in remaining workspace`);
      assert.ok(layout.composer.width<=960&&layout.messages.width<=960);
    }
    await page.screenshot({path:path.join(output,`home-${width}.png`)});
    await page.evaluate(()=>document.documentElement.dataset.theme='dark');
    const dark=await page.locator('.app-shell').boundingBox();assert.ok(Math.abs(dark.width-layout.app.width)<1);
    assert.deepEqual(errors,[]);results.push({viewport:width,...layout,errors});await page.close();
    }

    fs.writeFileSync(path.join(output,'home-results.json'),JSON.stringify(results,null,2));
    console.log(JSON.stringify(results));

  } finally {
    await browser.close();
  }
})().catch(e=>{console.error(e);process.exitCode=1;});

