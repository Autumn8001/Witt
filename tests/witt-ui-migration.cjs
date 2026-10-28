const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../web');
const output = process.env.CHLOE_UI_OUTPUT || path.resolve(__dirname, '../tests/artifacts/witt-ui-migration');
fs.mkdirSync(output, { recursive: true });
const models = [{ id: 'grok-4.7-high', displayName: 'Grok 4.7 High', isDefault: true, reasoningEfforts: [{id:'medium'},{id:'high'}] },
  { id: 'gemini-3.8-flash-high', displayName:'Gemini 3.8 Flash', reasoningEfforts:[{id:'high'}] }];
(async () => {
 const browser = await chromium.launch({ headless: true });
 const results=[];
 try {
  for (const width of [390,1440]) {
   const page = await browser.newPage({viewport:{width,height:width===390?844:900}});
   const errors=[], missing=[], calls=[], writes=[];
   const id='10000000-0000-4000-8000-000000000001';
   const conversation={id,title:'Migration test',model:models[0].id,reasoning:'high',accessMode:'workspace-write',harnessId:'grok-build',codexProfile:'default',workDir:'',busy:false,messages:[],updatedAt:new Date().toISOString()};
   let created=false;
   page.on('pageerror', e=>errors.push(e.stack));
   page.on('console', m=>{if(m.type()==='error')errors.push(m.text());});
   await page.route('https://chloe.test/**', async route=>{
    const url=new URL(route.request().url());
    if(url.pathname.startsWith('/vault/')){
     const file=path.join(root,decodeURIComponent(url.pathname.slice(7)));
     if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){
      if(url.pathname.endsWith('version.json'))return route.fulfill({json:{frontendSha:'4f7b580'}});
      missing.push(url.pathname);return route.fulfill({status:404,body:'Missing asset'});
     }
     return route.fulfill({path:file});
    }
    calls.push(url.pathname);
    if(route.request().method()!=='GET')writes.push({path:url.pathname,body:route.request().postDataJSON()});
    let body={};
    if(url.pathname.endsWith('/auth/status'))body={initialized:true,authenticated:true,principal:{admin:true,label:'Test admin',codexProfiles:['default'],allowedCodexProfiles:['default']}};
    else if(url.pathname.endsWith('/chat/capabilities'))body={models,defaultModel:models[0].id,defaultAccessMode:'workspace-write',accessModes:['read-only','workspace-write','danger-full-access'],runtime:{codex:{available:false},'grok-build':{available:true},'google-antigravity':{available:true}},support:{fork:true,compact:true,review:true},skills:[],mcpServers:[],features:[],codexProfile:'default'};
    else if(url.pathname.endsWith('/chat/conversations')){
     if(route.request().method()==='POST'){created=true;body={conversation};}
     else body={conversations:created?[conversation]:[],workspaceFeatures:true};
    }
    else if(url.pathname.includes('/events'))return route.fulfill({contentType:'text/event-stream',body:': connected\n\n'});
    else if(url.pathname.endsWith('/messages')&&route.request().method()==='POST'){
     const text=route.request().postDataJSON().text;
     conversation.messages=[{id:'20000000-0000-4000-8000-000000000001',role:'user',text,status:'completed',attachments:[],createdAt:new Date().toISOString()},
       {id:'30000000-0000-4000-8000-000000000001',role:'assistant',text:'这是迁移验收的模拟回复。',status:'completed',attachments:[],stream:[],createdAt:new Date().toISOString()}];
     body={conversation};
    }
    else if(url.pathname.endsWith('/'+id)){
     if(route.request().method()==='PATCH')Object.assign(conversation,route.request().postDataJSON());
     body={conversation};
    }
    else if(url.pathname.endsWith('/runtime/profiles'))body={profiles:models.map((m,i)=>({id:'test-'+i,name:m.displayName,model:m.id,harness:i?'google-antigravity':'grok-build',reasoning:'high'}))};
    else if(url.pathname.endsWith('/servers/overview'))body={cpu:{count:2},memory:{total:100,used:20},services:[],checkedAt:'2026-10-28'};
    else if(url.pathname.includes('/remote-assist/sessions'))body=route.request().method()==='POST'?{pairing_code:'TEST-1234',assist_session_id:'test'}:{sessions:[]};
    else if(url.pathname.endsWith('/devices'))body={devices:[]};
    else if(url.pathname.includes('/quota'))body={status:'no_accounts',accounts:[]};
    else if(url.pathname.includes('/usage'))body={summary:{},dailyUsageBuckets:[],rateLimits:{},account:{},unavailable:true};
    return route.fulfill({json:body});
   });
   await page.goto('https://chloe.test/vault/index.html');
   await page.waitForTimeout(1600);
   await page.screenshot({path:path.join(output,`home-${width}.png`),fullPage:true});
   const diagnostics=await page.evaluate(()=>({ready:!!window.WittUI,boot:document.querySelector('#bootScreen')?.className,overflow:document.documentElement.scrollWidth>innerWidth+1,dup:[...document.querySelectorAll('[id]')].map(n=>n.id).filter((id,i,all)=>all.indexOf(id)!==i)}));
   results.push({width,errors,missing,diagnostics,calls});
   console.log(JSON.stringify(results.at(-1)));
   if(!errors.length){
    await page.locator('#modelButton').click();await page.waitForTimeout(200);
    await page.screenshot({path:path.join(output,`models-${width}.png`)});
    const labels=await page.locator('#quickModelOptions').innerText();assert.match(labels,/Grok/);assert.match(labels,/Gemini/);
    await page.locator('#messageInput').click();
    await page.locator('#messageInput').fill('你好，验证新版输入框');
    await page.locator('#sendButton').click();
    await page.waitForTimeout(1000);
    if(errors.length)throw Error(errors.join('\n'));
    assert.ok(writes.some(w=>w.path.endsWith('/messages')&&w.body.text==='你好，验证新版输入框'),'send must use Chloe API');
    assert.match(await page.locator('.messages').innerText(),/迁移验收的模拟回复/);
    await page.screenshot({path:path.join(output,`chat-${width}.png`)});
    // Exercise settings, quota and remote assistance through their real UI paths.
    if(width<1000)await page.locator('#menuButton').click();
    await page.locator('#drawerAvatar').click();
    await page.locator('#runtimeSettingsButton').click();
    await page.waitForTimeout(150);
    assert.equal(await page.locator('#harnessOptions [data-harness]').count(),4);
    await page.screenshot({path:path.join(output,`settings-${width}.png`)});
    await page.locator('.model-options [data-model="gemini-3.8-flash-high"]').click();
    await page.locator('#saveSettings').click();
    await page.waitForTimeout(200);
    assert.ok(writes.some(w=>w.path.endsWith('/'+id)&&w.body.model==='gemini-3.8-flash-high'),'model selection must reach Chloe settings API');
    if(width<1000)await page.locator('#menuButton').click();
    await page.locator('#drawerAvatar').click();
    await page.locator('#profileButton').click();
    await page.waitForTimeout(200);
    assert.ok(await page.locator('#modelQuotaOverview').isVisible());
    await page.screenshot({path:path.join(output,`quota-${width}.png`)});
    await page.locator('#closeProfile').click();
    if(width<1000)await page.locator('#menuButton').click();
    await page.locator('#drawerAvatar').click();
    await page.locator('#customerDevicesButton').click();
    await page.waitForTimeout(200);
    await page.locator('[data-assist-create] button[type="submit"]').click();
    await page.waitForTimeout(150);
    assert.match(await page.locator('[data-assist-code]').innerText(),/TEST-1234/);
    await page.screenshot({path:path.join(output,`remote-${width}.png`)});
    await page.locator('#closeCustomerDevices').click();
    await page.waitForTimeout(500);
    await page.evaluate(()=>{document.documentElement.dataset.theme='dark';document.documentElement.dataset.themeMode='dark';});
    await page.screenshot({path:path.join(output,`dark-${width}.png`)});
    if(width<1000)await page.locator('#menuButton').click();
    await page.locator('#drawerAvatar').click();
    await page.locator('#customerDevicesButton').click();
    await page.waitForTimeout(300);
    await page.screenshot({path:path.join(output,`remote-dark-${width}.png`)});
    await page.locator('#closeCustomerDevices').click();
    await page.waitForTimeout(350);
    // Ensure an ordinary user does not inherit the administrator-only entry.
    await page.evaluate(()=>window.DropVault.onAuthStatus(JSON.stringify({authenticated:true,initialized:true,principal:{admin:false,codexProfiles:['default']}})));
    assert.ok(await page.locator('#customerDevicesButton').isHidden());
    assert.ok(!await page.locator('#authGate').isVisible());
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    results.at(-1).writes=writes;
   }
   await page.close();
  }
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2));
  assert.ok(results.every(r=>!r.errors.length&&!r.missing.length&&r.diagnostics.ready&&!r.diagnostics.overflow&&!r.diagnostics.dup.length),'Browser migration checks failed');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
