import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {startWorkspaceFixture} from './support/workspace-fixture.mjs';
const {chromium}=createRequire(new URL('../backend/package.json',import.meta.url))('playwright');
const fixture=await startWorkspaceFixture(),browser=await chromium.launch({headless:true});
const out=new URL('./artifacts/chloe-focus/',import.meta.url);await fs.mkdir(out,{recursive:true});
const id='00000000-0000-4000-8000-000000000012',cid='00000000-0000-4000-8000-000000000001';
try{
 for(const [name,viewport] of [['desktop',{width:1440,height:900}],['mobile',{width:390,height:844}]]){
  const page=await browser.newPage({viewport}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  let removed=false,sessions=[],createBody,failCreate=true;
  await page.route('**/vault-api/remote-workspaces**',async route=>{
   const req=route.request(),path=new URL(req.url()).pathname;
   if(req.method()==='DELETE'){removed=true;return route.fulfill({json:{deleted:true}})}
   return route.fulfill({json:path.endsWith('/options')?{devices:[]}:{workspaces:removed?[]:[{workspace_id:id,conversation_id:cid,title:'一次性开发记录',device_id:'assist-test',state:'closed',display_path:'D:/Project',model_id:'grok-4.7-high'}]}});
  });
  await page.route('**/vault-api/remote-assist/**',async route=>{
   const req=route.request(),path=new URL(req.url()).pathname;
   if(path.endsWith('/workspace'))return route.fulfill({json:{conversation:{id:cid}}});
   if(req.method()==='POST'){
    createBody=req.postDataJSON();
    if(failCreate)return route.fulfill({status:503,json:{error:'连接服务暂不可用，请重试'}});
    sessions=[{assist_session_id:id,customer_label:'临时开发',state:'pending',expires_at:Date.now()+1800000,connected:false,access_mode:createBody.access_mode}];
    return route.fulfill({json:{...sessions[0],pairing_code:'ABCDE-12345'}});
   }
   return route.fulfill({json:{sessions}});
  });
  await page.goto(fixture.url);await page.waitForFunction(()=>window.DropVault&&document.body.classList.contains('native'));
  await page.locator('#modelButton').click();await page.locator('#quickModelOptions').waitFor({state:'visible'});
  assert.equal(await page.locator('#quickReasoningOptions').isVisible(),false);
  assert.doesNotMatch(await page.locator('#quickModelMenu').innerText(),/Plus|Free|Runtime|自动分配/);
  await page.screenshot({path:new URL(`models-${name}.png`,out).pathname.replace(/^\/(\w:)/,'$1')});
  await page.locator('[data-quick-model="gpt-6.1-sol"]').click();
  await page.locator('#focusReasoningButton').click();await page.locator('#quickReasoningOptions').waitFor({state:'visible'});
  assert.equal(await page.locator('#quickModelOptions').isVisible(),false);
  const first=page.locator('[data-quick-reasoning]').first();const effort=await first.getAttribute('data-quick-reasoning');await first.click();
  await page.locator('#focusReasoningButton').click();assert.equal(await page.locator(`[data-quick-reasoning="${effort}"]`).getAttribute('aria-checked'),'true');await page.keyboard.press('Escape');
  if(name==='mobile')await page.locator('#menuButton').click();await page.locator('#customerDevicesButton').click();
  await page.locator('[data-delete-workspace]').waitFor();
  page.once('dialog',d=>d.dismiss());await page.locator('[data-delete-workspace]').click();assert.equal(removed,false);
  page.once('dialog',d=>d.accept());await page.locator('[data-delete-workspace]').click();await page.locator('[data-delete-workspace]').waitFor({state:'detached'});assert.equal(removed,true);
  const create=page.locator('[data-assist-create] button');await create.click();await page.locator('[data-assist-status]').filter({hasText:'连接服务暂不可用'}).waitFor();assert.equal(await create.isEnabled(),true);
  failCreate=false;await create.click();await page.locator('[data-assist-code]').waitFor({state:'visible'});assert.match(await page.locator('[data-assist-code]').textContent(),/ABCDE-12345/);assert.equal(createBody.access_mode,'workspace');assert.equal(createBody.allow_commands,true);assert.equal(await page.locator('[data-assist-open]').isDisabled(),true);
  await page.locator('#customerDevices').evaluate(e=>e.scrollTop=0);await page.screenshot({path:new URL(`remote-code-${name}.png`,out).pathname.replace(/^\/(\w:)/,'$1')});
  sessions[0]={...sessions[0],state:'active',connected:true,workspace_root:'D:/Project'};await page.locator('[data-assist-refresh]').click();await page.waitForFunction(()=>!document.querySelector('[data-assist-open]').disabled);
  await fetch(new URL('/__test/seed',fixture.url),{method:'POST',body:JSON.stringify([{id:cid,title:'远程配对工作区',model:'grok-4.7-high',reasoning:'high',accessMode:'workspace-write',messages:[],updatedAt:new Date().toISOString()}])});
  await page.locator('[data-assist-open]').click();await page.locator('#customerDevicesSheet').waitFor({state:'hidden'});await page.waitForFunction(()=>document.querySelector('#chatTitle').textContent==='远程配对工作区');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);await page.close();console.log(name+': independent model/effort, deletion cancel/confirm, connection-code failure/retry and authorized workspace opening passed');
 }
}finally{await browser.close();await fixture.close()}
