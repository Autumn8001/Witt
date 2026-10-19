import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {startWorkspaceFixture} from './support/workspace-fixture.mjs';
import {focusHistory,focusTask} from './support/focus-fixtures.mjs';
const {chromium}=createRequire(new URL('../backend/package.json',import.meta.url))('playwright');
const out=fileURLToPath(new URL('./artifacts/chloe-focus/',import.meta.url));await fs.mkdir(out,{recursive:true});
const fixture=await startWorkspaceFixture();
await fetch(new URL('/__test/seed',fixture.url),{method:'POST',body:JSON.stringify(focusHistory)});
const browser=await chromium.launch({headless:true});const report=[];
const viewports=[['desktop',{width:1440,height:900}],['narrow',{width:1024,height:768}],['mobile',{width:390,height:844}]];
try{
 for(const [name,viewport] of viewports){
  await fetch(new URL('/__test/seed',fixture.url),{method:'POST',body:JSON.stringify(focusHistory)});
  const context=await browser.newContext({viewport,reducedMotion:'reduce'}),page=await context.newPage();
  const errors=[],checks=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
  await page.addInitScript(()=>{if(window.top===window)localStorage.setItem('wit_theme','light')});
  await page.goto(fixture.url);await page.locator('.message.assistant').waitFor();await page.evaluate(()=>document.fonts.ready);
  async function geometry(){
   const v=await page.evaluate(()=>{const c=document.getElementById('composer').getBoundingClientRect();return {overflow:document.documentElement.scrollWidth>innerWidth,composer:{x:c.x,y:c.y,right:c.right,bottom:c.bottom},height:innerHeight,width:innerWidth}});
   assert.equal(v.overflow,false);assert(v.composer.x>=0&&v.composer.right<=v.width+1);assert(v.composer.y>=0&&v.composer.bottom<=v.height);return v;
  }
  await geometry();
  assert.equal(await page.locator('#focusContextProject').textContent(),'witt-personal');
  assert.equal(await page.locator('#focusContextPath').textContent(),focusTask.workDir);
  assert.equal(await page.locator('#focusContextHarness').textContent(),'Grok Build');checks.push('context-from-conversation');
  await page.screenshot({path:path.join(out,`task-${name}.png`)});
  if(viewport.width<1200){
   await page.locator('#focusContextToggle').click();assert.equal(await page.locator('.focus-context').isVisible(),true);
   await page.keyboard.press('Escape');assert.equal(await page.locator('.focus-context').isVisible(),false);checks.push('compact-context-access');
  }
  if(viewport.width<1000){await page.locator('#menuButton').click();await page.locator('#drawerNewChat').click()}else await page.locator('#drawerNewChat').click();
  await page.locator('#welcome').waitFor({state:'visible'});await page.waitForFunction(()=>!document.querySelector('#attachButton').disabled);
  await geometry();await page.screenshot({path:path.join(out,`home-${name}.png`)});
  if(viewport.width<1000){await page.locator('#menuButton').click();await page.locator('#drawer').waitFor({state:'visible'});await page.keyboard.press('Escape');assert.equal(await page.locator('#drawer').getAttribute('aria-hidden'),'true');checks.push('drawer-keyboard-close')}
  await page.locator('#modelButton').click();
  let menu=await page.locator('#quickModelMenu').boundingBox();assert(menu.y>=0&&menu.y+menu.height<=viewport.height+1);
  await page.locator('[data-quick-model="gpt-6.1-sol"]').click();assert.match(await page.locator('#focusContextModel').textContent(),/GPT-6.1 Sol/);checks.push('picker-placement-and-model-sync');
  await page.locator('#focusWelcomeRuntime').click();await page.locator('#settingsSheet.open').waitFor();assert.equal(await page.locator('.app-shell').evaluate(e=>e.inert),true);
  await page.screenshot({path:path.join(out,`settings-${name}.png`)});await page.locator('#closeSettings').click();checks.push('settings-and-background-focus');
  await page.locator('#attachButton').click();
  const chooserPromise=page.waitForEvent('filechooser');await page.locator('#attachPhotoButton').click();const chooser=await chooserPromise;
  assert.equal(await chooser.element().getAttribute('accept'),'image/*');
  await chooser.setFiles({name:'context.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO4cAAAAASUVORK5CYII=','base64')});
  await page.locator('.attachment-chip').waitFor();await page.locator('#messageInput').fill('检查这张截图中的界面问题');
  const upload=page.waitForResponse(r=>r.url().endsWith('/vault-api/files')&&r.request().method()==='POST');
  const message=page.waitForRequest(r=>/\/messages$/.test(new URL(r.url()).pathname)&&r.method()==='POST');
  await page.locator('#sendButton').click();await upload;const request=await message;assert.equal(request.postDataJSON().attachmentIds.length,1);
  await page.getByText('Mock assistant 已收到并完成这条消息。',{exact:true}).waitFor();checks.push('real-browser-image-upload-transport');
  // A backend error must keep the draft usable and restore sending controls.
  await page.route('**/vault-api/chat/conversations/*/messages',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'测试服务暂时不可用，请稍后重试'})}));
  await page.locator('#messageInput').fill('保留这条未送达的草稿');await page.locator('#sendButton').click();
  await page.locator('#toast.show').filter({hasText:'测试服务暂时不可用'}).waitFor();assert.equal(await page.locator('#messageInput').inputValue(),'保留这条未送达的草稿');assert.equal(await page.locator('#sendButton').isEnabled(),true);checks.push('failed-send-draft-recovery');
  // No production/API endpoint is contacted: all requests remain on the fixture origin.
  const unexpected=errors.filter(e=>!e.includes('503'));assert.deepEqual(unexpected,[]);
  await page.evaluate(()=>document.documentElement.dataset.theme='dark');await page.screenshot({path:path.join(out,`dark-${name}.png`)});
  await geometry();checks.push('layout-light-dark-and-no-overflow');
  report.push({viewport,checks,errors:unexpected});await context.close();
 }
 const readonly=await startWorkspaceFixture({admin:false});const page=await browser.newPage({viewport:{width:1440,height:900}});
 await page.goto(readonly.url);await page.waitForFunction(()=>window.DropVault&&document.body.classList.contains('native'));
 await page.waitForTimeout(150);assert.equal(await page.locator('#customerDevicesButton').isHidden(),true);assert.equal(await page.locator('#adminSettingsButton').isHidden(),true);
 await page.locator('#focusWelcomeEnvironment').click();await page.locator('#workspaceOverview.open').waitFor();
 // The app may refresh device metadata during bootstrap; the user-facing
 // non-admin path must still fall back to the read-only workspace overview.
 assert.equal(await page.locator('#workspaceOverview.open').isVisible(),true);
 report.push({checks:['non-admin-entry-gating-and-environment-fallback'],errors:[]});await page.close();await readonly.close();
 await fs.writeFile(path.join(out,'focus-verification.json'),JSON.stringify({scope:'Actual frontend and browser bridge against local HTTP fixtures; no live model/device claims.',report},null,2));
 console.log(JSON.stringify(report,null,2));
}finally{await browser.close();await fixture.close()}
