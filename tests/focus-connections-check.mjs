import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {startWorkspaceFixture} from './support/workspace-fixture.mjs';
const {chromium}=createRequire(new URL('../backend/package.json',import.meta.url))('playwright');
const fixture=await startWorkspaceFixture();
const browser=await chromium.launch({headless:true});
const out=new URL('./artifacts/chloe-focus/',import.meta.url);await fs.mkdir(out,{recursive:true});
const wid='00000000-0000-4000-8000-000000000123';
try{
for(const [name,viewport] of [['desktop',{width:1440,height:900}],['mobile',{width:390,height:844}]]){
 const page=await browser.newPage({viewport});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 let state='active',posted,canCreate=false;
 const devices=[{device_id:'DEV-PC',device_label:'我的开发电脑',status:'online',ready:true,roots:[{root_alias:'first',display_path:'D:/Projects'},{root_alias:'second',display_path:'D:/Coding'}],models:[{id:'grok-4.7-high',name:'Grok',reasoning:'high'},{id:'gemini-3.8-flash-high',name:'Gemini',reasoning:'medium'}]}];
 await page.route('**/vault-api/servers/overview',route=>route.fulfill({json:{host:'design-fixture',platform:'Linux',checkedAt:new Date().toISOString(),http:[{name:'Chloe',status:'healthy',detail:{latencyMs:8}},{name:'Open WebUI',status:'down'}],containers:[{name:'sub2api',status:'degraded'}],units:[{name:'nginx',status:'unknown'}],openWebuiUrl:'https://example.com/webui'}}));
 await page.route('**/vault-api/remote-workspaces**',async route=>{
  const req=route.request(),url=new URL(req.url());
  if(url.pathname.endsWith('/options'))return route.fulfill({json:{devices}});
  if(req.method()==='POST'&&/\/(pause|resume|close)$/.test(url.pathname)){state=url.pathname.endsWith('/pause')?'paused':url.pathname.endsWith('/resume')?'active':'closed';return route.fulfill({json:{workspace:{state}}})}
  if(req.method()==='POST'){posted=req.postDataJSON();if(canCreate)return route.fulfill({json:{conversation:{id:'00000000-0000-4000-8000-000000000001'}}});return route.fulfill({status:503,json:{error:'测试设备暂不可用'}})}
  return route.fulfill({json:{workspaces:[{workspace_id:wid,conversation_id:'00000000-0000-4000-8000-000000000001',title:'附件上传开发任务',device_id:'DEV-PC',display_path:'D:/Coding',model_id:'Gemini',state}]}});
 });
 await page.goto(fixture.url);await page.waitForFunction(()=>window.DropVault&&document.body.classList.contains('native'));
 if(name==='mobile')await page.locator('#menuButton').click();
 await page.locator('#codexAccountsButton').waitFor({state:'hidden'});
 await page.waitForTimeout(300);await page.screenshot({path:new URL(`brand-${name}.png`,out).pathname.replace(/^\/(\w:)/,'$1')});
 await page.locator('#workspaceOverviewButton').click();await page.locator('.workspace-webui').waitFor();assert.equal(await page.locator('.workspace-webui').getAttribute('href'),'https://example.com/webui');assert.equal(await page.locator('.service-state[data-status=healthy]').count(),1);assert.equal(await page.locator('.service-state[data-status=down]').count(),1);
 await page.screenshot({path:new URL(`services-${name}.png`,out).pathname.replace(/^\/(\w:)/,'$1')});
 await page.locator('#closeWorkspace').click();
 if(name==='mobile')await page.locator('#menuButton').click();
 await page.locator('#customerDevicesButton').click();await page.locator('[data-workspace-state=pause]').click();await page.locator('[data-workspace-state=resume]').waitFor();await page.locator('[data-workspace-state=resume]').click();await page.locator('[data-workspace-state=pause]').waitFor();
 await page.locator('[data-select-customer-device]').click();await page.locator('[data-workspace-root]').selectOption('second');await page.locator('[data-workspace-model]').selectOption('gemini-3.8-flash-high');await page.locator('[data-workspace-title]').fill('远程回归任务');
 await page.locator('[data-start-remote-workspace]').click();await page.waitForFunction(()=>document.querySelector('[data-customer-status]').textContent.includes('测试设备暂不可用'));
 assert.deepEqual(posted,{device_id:'DEV-PC',root_alias:'second',title:'远程回归任务',model:'gemini-3.8-flash-high',reasoning:'medium'});
 assert.equal(await page.locator('[data-workspace-root]').inputValue(),'second');assert.equal(await page.locator('[data-workspace-model]').inputValue(),'gemini-3.8-flash-high');assert.equal(await page.locator('[data-start-remote-workspace]').isEnabled(),true);
 await page.locator('#customerDevices').evaluate(e=>e.scrollTop=0);await page.waitForTimeout(300);
 await page.screenshot({path:new URL(`environments-${name}.png`,out).pathname.replace(/^\/(\w:)/,'$1')});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.evaluate(()=>document.documentElement.dataset.theme='dark');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 canCreate=true;
 const conversation={id:'00000000-0000-4000-8000-000000000001',title:'远程回归任务',model:'grok-4.7-high',reasoning:'high',accessMode:'workspace-write',messages:[],workDir:'',updatedAt:new Date().toISOString()};
 await fetch(new URL('/__test/seed',fixture.url),{method:'POST',body:JSON.stringify([conversation])});
 await page.locator('[data-start-remote-workspace]').click();
 await page.locator('#customerDevicesSheet').waitFor({state:'hidden'});
 await page.waitForFunction(()=>document.querySelector('#chatTitle').textContent==='远程回归任务');
 assert.deepEqual(errors,[]);
 await page.close();console.log(name+': services, WebUI, account hiding, pause/resume, root/model/title submission and failed-create recovery passed');
}
}finally{await browser.close();await fixture.close()}
