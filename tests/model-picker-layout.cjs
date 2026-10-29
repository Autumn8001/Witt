const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../web');
const output = process.env.CHLOE_UI_OUTPUT || path.resolve(__dirname,'artifacts/model-picker');
fs.mkdirSync(output, { recursive: true });

const models=['grok-4.7-high','gemini-3.8-flash-high','gpt-6.1-sol','gpt-6-luna','gpt-5.6-terra','gpt-5.6-luna','deepseek-v4-pro','deepseek-v4-flash','gemini-3.8-pro'].map((id,i)=>({id,displayName:['Grok 4.7 High','Gemini 3.8 Flash','GPT-6.1 Sol','GPT-6 Luna','GPT-5.6 Terra','GPT-5.6 Luna','DeepSeek V4 Pro','DeepSeek V4 Flash','Gemini 3.8 Pro'][i],isDefault:i===0,reasoningEfforts:[{id:'low'},{id:'medium'},{id:'high'}]}));

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const results = [];
    for (const width of [360,390,768,1440,1910,480]) {
    const page = await browser.newPage({ viewport: { width, height: width===480?500:width<700?844:980 } });
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
    await page.waitForTimeout(800);
    await page.locator('#modelButton').click();
    await page.waitForTimeout(250);
    const layout=await page.evaluate(()=>{
      const menu=document.querySelector('#quickModelMenu'),list=document.querySelector('#quickModelOptions');
      const r=menu.getBoundingClientRect();
      return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,viewportHeight:innerHeight,
        rowSizes:[...list.querySelectorAll('button')].map(b=>parseFloat(getComputedStyle(b).fontSize)),
        reasoningSizes:[...document.querySelectorAll('#quickReasoningOptions button')].map(b=>parseFloat(getComputedStyle(b).fontSize)),
        scrolls:list.scrollHeight>list.clientHeight,overflow:menu.scrollWidth>menu.clientWidth+1,
        selected:list.querySelectorAll('[aria-checked="true"]').length};
    });
    assert.ok(layout.top>=8&&layout.bottom<=layout.viewportHeight&&layout.left>=0&&layout.right<=width);
    assert.ok(layout.width<=330&&!layout.overflow);
    assert.ok(layout.rowSizes.length===9&&layout.rowSizes.every(n=>n<=14));
    assert.ok(layout.reasoningSizes.length===3&&layout.reasoningSizes.every(n=>n<=14));
    assert.equal(layout.selected,1);
    if(width===360)assert.ok(layout.scrolls,'long list must scroll in narrow viewport');
    await page.locator('#quickModelOptions button').last().scrollIntoViewIfNeeded();
    await page.locator('#quickModelOptions button').last().click({trial:true});
    await page.evaluate(()=>document.querySelector('#quickModelOptions').scrollTop=0);
    await page.screenshot({path:path.join(output,`picker-${width}.png`)});
    await page.evaluate(()=>document.documentElement.dataset.theme='dark');
    await page.screenshot({path:path.join(output,`picker-dark-${width}.png`)});
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#quickModelMenu').getAttribute('aria-hidden'),'true');
    assert.deepEqual(errors,[]);
    results.push({viewportWidth:width,...layout,errors});await page.close();
    }
    fs.writeFileSync(path.join(output,'picker-results.json'),JSON.stringify(results,null,2));
    console.log(JSON.stringify(results));

  } finally {
    await browser.close();
  }
})().catch(e=>{console.error(e);process.exitCode=1;});

