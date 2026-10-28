const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../web');
const output = process.env.CHLOE_UI_OUTPUT || path.resolve(__dirname, 'artifacts/account-ui-pages');
fs.mkdirSync(output, { recursive: true });

const models = [
  { id: 'grok-4.7-high', displayName: 'Grok 4.7 High', isDefault: true, reasoningEfforts: [{id:'medium'},{id:'high'}] },
  { id: 'gemini-3.8-flash-high', displayName:'Gemini 3.8 Flash', reasoningEfforts:[{id:'high'}] }
];

async function inspect() {
  const browser = await chromium.launch({ headless: true });
  const viewports = [
    {name:'360',width:360,height:780},
    {name:'390',width:390,height:844},
    {name:'768',width:768,height:1024},
    { name: '1440', width: 1440, height: 900 }
  ];

  const results = [];

  for (const vp of viewports) {
    const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); if(m.text().startsWith('OVERFLOW'))console.log(m.text()); });

    const conversation = {
      id: '10000000-0000-4000-8000-000000000001',
      title: '排版测试超长会话标题用来检测标题在窄屏和侧栏是否正常折行或截断',
      model: models[0].id,
      reasoning: 'high',
      accessMode: 'workspace-write',
      harnessId: 'grok-build',
      codexProfile: 'default',
      workDir: '/workspace/project/very/long/path/for/testing/overflow',
      busy: false,
      messages: [
        {
          id: '20000000-0000-4000-8000-000000000001',
          role: 'user',
          text: '请帮我检查页面排版并展示一段超长代码和表格测试',
          status: 'completed',
          attachments: [],
          createdAt: new Date().toISOString()
        },
        {
          id: '30000000-0000-4000-8000-000000000001',
          role: 'assistant',
          text: '好的，这是排版测试消息：\n\n```javascript\nfunction veryLongFunctionNameWithManyParameters(firstParameterName, secondParameterName, thirdParameterName) {\n  return firstParameterName + secondParameterName + thirdParameterName;\n}\n```\n\n| 列 A | 列 B | 列 C | 列 D |\n|---|---|---|---|\n| 单元格内容 1 | 单元格内容 2 | 单元格内容 3 | 单元格内容 4 |\n',
          status: 'completed',
          stream: [
            { id: 'entry-1', kind: 'action', title: '执行系统命令检查', status: 'completed', detail: 'stdout output of system check command\nline 2: all clean' }
          ],
          attachments: [],
          createdAt: new Date().toISOString()
        }
      ],
      updatedAt: new Date().toISOString()
    };

    let authState = { initialized: true, authenticated: true, principal: { admin: true, label: '管理员账户', codexProfiles: ['default', 'xuanyu'] } };

    await page.route('https://chloe.test/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/vault/')) {
        const file = path.join(root, decodeURIComponent(url.pathname.slice(7)));
        if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
          if (url.pathname.endsWith('version.json')) return route.fulfill({ json: { frontendSha: '4f7b580' } });
          return route.fulfill({ status: 404, body: 'Not found' });
        }
        return route.fulfill({ path: file });
      }

      if (url.pathname.endsWith('/auth/status')) return route.fulfill({ json: authState });
      if (url.pathname.endsWith('/chat/capabilities')) {
        return route.fulfill({
          json: {
            models,
            defaultModel: models[0].id,
            defaultAccessMode: 'workspace-write',
            accessModes: ['read-only', 'workspace-write', 'danger-full-access'],
            runtime: { codex: { available: true }, 'grok-build': { available: true }, 'google-antigravity': { available: true } },
            support: { fork: true, compact: true, review: true },
            skills: [],
            mcpServers: [],
            features: [],
            codexProfile: 'default'
          }
        });
      }
      if (url.pathname.endsWith('/chat/conversations')) return route.fulfill({ json: { conversations: [conversation], workspaceFeatures: true } });
      if (url.pathname.includes('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
      if (url.pathname.endsWith('/runtime/profiles')) return route.fulfill({ json: { profiles: [{ id: 'p1', name: 'Grok Build', model: 'grok-4.7-high', harness: 'grok-build', reasoning: 'high' }] } });
      if (url.pathname.endsWith('/servers/overview')) return route.fulfill({ json: { cpu: { count: 4 }, memory: { total: 16000, used: 8000 }, services: [], checkedAt: '2026-10-28' } });
      if (url.pathname.includes('/remote-assist/sessions')) return route.fulfill({ json: { sessions: [{ assist_session_id: 's1', customer_label: '远程协助测试客户', state: 'active', connected: true, expires_at: new Date(Date.now() + 1800000).toISOString(), access_mode: 'full' }] } });
      if (url.pathname.endsWith('/customer-devices') || url.pathname.endsWith('/remote-workspaces/options')) {
        return route.fulfill({
          json: {
            devices: [{ device_id: 'dev-1', device_label: 'MacBook Pro', customer_name: '客户 A', status: 'online', ready: true, allowed_roots: [{ id: 'r1', label: 'D:/Coding/Chloe' }] }],
            capabilities: { 'dev-1': true },
            roots: { 'dev-1': [{ id: 'r1', label: 'D:/Coding/Chloe' }] },
            models: [{ id: 'grok-4.7-high', name: 'Grok Build', harness: 'grok-build', reasoning: 'high' }]
          }
        });
      }
      if (url.pathname.endsWith('/admin/devices')) {
        return route.fulfill({
          json: {
            devices: [
              { id: '11111111-1111-4111-8111-111111111111', label: '我的电脑 (Chrome)', admin: true, disabled: false, createdAt: '2026-10-28T12:00:00Z', lastSeenAt: '2026-10-28T14:00:00Z' },
              { id: '22222222-2222-4222-8222-222222222222', label: '管理员手机 (iPhone Safari)', admin: true, disabled: false, createdAt: '2026-10-28T13:00:00Z', lastSeenAt: '2026-10-28T14:10:00Z' }
            ]
          }
        });
      }
      if (url.pathname.endsWith('/admin/invites')) {
        return route.fulfill({
          json: {
            invites: [
              { id: 'inv-1', label: '手机配对码', admin: true, maxDevices: 1, usedDevices: 0, expiresAt: new Date(Date.now() + 900000).toISOString() }
            ]
          }
        });
      }
      if (url.pathname.endsWith('/codex/accounts')) {
        return route.fulfill({
          json: {
            accounts: [
              { profile: 'default', label: '默认账号', authenticated: true, active: true },
              { profile: 'xuanyu', label: '玄予账号', authenticated: false, active: false }
            ]
          }
        });
      }
      if (url.pathname.includes('/quota')) return route.fulfill({ json: { status: 'ok', accounts: [{ label: 'Codex-Pro', used: 45, limit: 100, resetTime: '明天 12:00' }] } });
      if (url.pathname.includes('/usage')) return route.fulfill({ json: { summary: { todayTokens: 12500 }, dailyUsageBuckets: [], rateLimits: {}, account: { label: 'Pro' } } });

      return route.fulfill({ json: {} });
    });

    // 1. Auth Gate view
    authState = { initialized: true, authenticated: false, principal: null, bootstrapEligible: false };
    await page.goto('https://chloe.test/vault/index.html');
    await page.waitForTimeout(600);
    const authOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    await page.screenshot({ path: path.join(output, `view-auth-${vp.name}.png`) });

    // Dark Mode Auth Gate
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark';
      document.documentElement.dataset.themeMode = 'dark';
    });
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(output, `view-auth-dark-${vp.name}.png`) });

    // 2. Switch to Authenticated
    authState = { initialized: true, authenticated: true, principal: { admin: true, label: '管理员账户', codexProfiles: ['default', 'xuanyu'] } };
    await page.goto('https://chloe.test/vault/index.html');
    await page.waitForTimeout(800);

    // Chat / Home
    const homeOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    await page.screenshot({ path: path.join(output, `view-chat-${vp.name}.png`) });

    // 3. Model selector
    await page.locator('#modelButton').click();
    await page.waitForTimeout(200);
    const modelPickerOverflow = await page.evaluate(() => {
      const p = document.querySelector('#quickModelOptions');
      return p ? p.scrollWidth > p.clientWidth : false;
    });
    await page.screenshot({ path: path.join(output, `view-models-${vp.name}.png`) });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    // 4. Sidebar Drawer
    if (vp.width < 1000) {
      await page.locator('#menuButton').click();
      await page.waitForTimeout(300);
    }
    await page.screenshot({ path: path.join(output, `view-sidebar-${vp.name}.png`) });

    // 5. Admin Settings (Device Management)
    await page.locator('#drawerAvatar').click();
    await page.waitForTimeout(200);
    await page.locator('#adminSettingsButton').click();
    await page.waitForTimeout(300);
    const adminPanelOverflow = await page.evaluate(() => {
      const p = document.querySelector('#adminSettingsSheet .sheet-panel');
      return p ? { scrollWidth: p.scrollWidth, clientWidth: p.clientWidth, hasHScroll: p.scrollWidth > p.clientWidth + 1 } : null;
    });
    await page.screenshot({ path: path.join(output, `view-admin-devices-${vp.name}.png`) });
    await page.locator('#closeAdminSettings').click();
    await page.waitForTimeout(300);

    // 6. Codex Accounts
    if (vp.width < 1000) {
      await page.locator('#menuButton').click();
      await page.waitForTimeout(200);
    }
    await page.locator('#drawerAvatar').click();
    await page.waitForTimeout(200);
    const codexBtn = page.locator('#codexAccountsButton');
    if (await codexBtn.isVisible()) {
      await codexBtn.click();
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(output, `view-codex-accounts-${vp.name}.png`) });
      await page.locator('#closeCodexAccounts').click();
      await page.waitForTimeout(300);
    }

    // 7. Runtime Settings (Harness / Full Settings)
    if (vp.width < 1000) {
      await page.locator('#menuButton').click();
      await page.waitForTimeout(200);
    }
    await page.locator('#drawerAvatar').click();
    await page.waitForTimeout(200);
    await page.locator('#runtimeSettingsButton').click();
    await page.waitForTimeout(300);
    const settingsOverflow = await page.evaluate(() => {
      const p = document.querySelector('#settingsSheet .sheet-panel');
      if (p && p.scrollWidth > p.clientWidth + 1) console.log('OVERFLOW', p.parentElement.id, p.clientWidth, p.scrollWidth, JSON.stringify([...p.querySelectorAll('*')].filter(n=>n.getBoundingClientRect().right>p.getBoundingClientRect().right+1).map(n=>({tag:n.tagName,id:n.id,cls:n.className,width:n.getBoundingClientRect().width,right:n.getBoundingClientRect().right})).slice(0,12)));
      return p ? p.scrollWidth > p.clientWidth + 1 : false;
    });
    await page.screenshot({ path: path.join(output, `view-settings-${vp.name}.png`) });
    await page.locator('#closeSettings').click();
    await page.waitForTimeout(300);

    // 8. Profile / Quota
    if (vp.width < 1000) {
      await page.locator('#menuButton').click();
      await page.waitForTimeout(200);
    }
    await page.locator('#drawerAvatar').click();
    await page.waitForTimeout(200);
    await page.locator('#profileButton').click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(output, `view-quota-${vp.name}.png`) });
    await page.locator('#closeProfile').click();
    await page.waitForTimeout(300);

    // 9. Customer Devices / Remote Assist
    if (vp.width < 1000) {
      await page.locator('#menuButton').click();
      await page.waitForTimeout(200);
    }
    await page.locator('#drawerAvatar').click();
    await page.waitForTimeout(200);
    await page.locator('#customerDevicesButton').click();
    await page.waitForTimeout(400);
    const remoteLayout = await page.evaluate(() => {
      const panel=document.querySelector('#customerDevicesSheet .sheet-panel');
      const content=document.querySelector('#customerDevices');const r=panel.getBoundingClientRect();
      return {fits:r.left>=-1&&r.right<=innerWidth+1&&r.top>=-1&&r.bottom<=innerHeight+1,scrollable:content.clientHeight>0&&getComputedStyle(content).overflowY==='auto'};
    });
    await page.screenshot({ path: path.join(output, `view-remote-${vp.name}.png`) });

    // 10. Dark Mode Remote Assist & Chat
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark';
      document.documentElement.dataset.themeMode = 'dark';
    });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(output, `view-remote-dark-${vp.name}.png`) });
    await page.locator('#closeCustomerDevices').click();
    await page.waitForTimeout(300);

    await page.screenshot({ path: path.join(output, `view-chat-dark-${vp.name}.png`) });

    // 11. Execution detail modal / sheet
    await page.evaluate(() => {
      const detailSheet = document.getElementById('actionDetailSheet');
      const content = document.getElementById('actionDetailContent');
      if (detailSheet && content) {
        content.innerHTML = '<div class="detail-block"><h3>命令执行详情</h3><pre>git status\nOn branch codex/witt-frontend-refresh\nnothing to commit, working tree clean</pre></div>';
        detailSheet.classList.add('open');
        detailSheet.setAttribute('aria-hidden', 'false');
      }
    });
    await page.waitForTimeout(300);
    const actionDetailOverflow = await page.evaluate(() => {
      const p = document.querySelector('#actionDetailSheet .sheet-panel');
      if (p && p.scrollWidth > p.clientWidth + 1) console.log('OVERFLOW', p.parentElement.id, p.clientWidth, p.scrollWidth, JSON.stringify([...p.querySelectorAll('*')].filter(n=>n.getBoundingClientRect().right>p.getBoundingClientRect().right+1).map(n=>({tag:n.tagName,id:n.id,cls:n.className,width:n.getBoundingClientRect().width,right:n.getBoundingClientRect().right})).slice(0,12)));
      return p ? p.scrollWidth > p.clientWidth + 1 : false;
    });
    await page.screenshot({ path: path.join(output, `view-action-detail-${vp.name}.png`) });

    results.push({
      viewport: vp.name,
      width: vp.width,
      authOverflow,
      homeOverflow,
      adminPanelOverflow,
      modelPickerOverflow,
      settingsOverflow,
      actionDetailOverflow,
      remoteLayout,
      errors
    });

    await page.close();
  }

  await browser.close();
  fs.writeFileSync(path.join(output,'page-results.json'),JSON.stringify(results,null,2));
  console.log(JSON.stringify(results, null, 2));
  assert.ok(results.every(r=>!r.authOverflow&&!r.homeOverflow&&!r.adminPanelOverflow?.hasHScroll&&!r.modelPickerOverflow&&!r.settingsOverflow&&!r.actionDetailOverflow&&!r.errors.length&&r.remoteLayout.fits&&r.remoteLayout.scrollable),'Page layout regression');
}

inspect().catch(e => { console.error(e); process.exit(1); });
