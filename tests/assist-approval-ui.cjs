"use strict";
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),{chromium}=require('playwright');
const repo=path.resolve(__dirname,'..'),out=path.join(repo,'artifacts/assist-approval-ui');fs.mkdirSync(out,{recursive:true});
const wait=async(fn,ms=12000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,50))}throw Error('Timed out')};
(async()=>{
 const fixture=path.join(out,'fixture');fs.rmSync(fixture+'.url',{force:true});
 const proc=spawn(path.join(repo,'artifacts/assist-browser-test.exe'),['-test.run=^TestAssistApprovalUIFixture$','-test.timeout=80s'],{env:{...process.env,ASSIST_APPROVAL_FIXTURE:fixture},stdio:'ignore'});
 const browser=await chromium.launch({headless:true});let page;
 try{
  await wait(()=>fs.existsSync(fixture+'.url'));const url=fs.readFileSync(fixture+'.url','utf8'),origin=new URL(url).origin,secret=new URL(url).hash.slice(1);
  const api=async(route,body={})=>{const r=await fetch(origin+route,{method:'POST',headers:{Origin:origin,Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json()}};
  page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(url);
  for(const [width,allow]of [[1280,true],[390,false]]){
   await page.setViewportSize({width,height:844});await page.locator('footer').scrollIntoViewIfNeeded();
   const pending=api('/fixture/approval');await page.locator('#change').waitFor({state:'visible'});
   assert.equal(await page.locator('#change').evaluate(e=>e.matches(':modal')),true);
   assert.match(await page.title(),/待确认操作/);assert.match(await page.locator('#diff').textContent(),/Get-Service/);
   assert.match(await page.locator('#approval-time').textContent(),/剩余/);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   await page.screenshot({path:path.join(out,'approval-'+width+'.png')});
   if(allow)await page.locator('#accept').click();else await page.keyboard.press('Escape');
   assert.equal((await pending).data.allowed,allow);await page.locator('#change').waitFor({state:'hidden'});
  }
  const timeout=api('/fixture/approval');await page.locator('#change').waitFor({state:'visible'});
  const status=await api('/api/status'),id=status.data.approval.id;
  assert.equal((await timeout).data.allowed,false);await page.locator('#change').waitFor({state:'hidden'});
  assert.equal((await api('/api/decision',{id,allow:true})).status,409);
  assert.deepEqual(errors,[]);await page.locator('#end').click();await wait(()=>proc.exitCode!==null);assert.equal(proc.exitCode,0);
  console.log('PASS: actual local approval API, desktop/mobile modal, allow, Escape decline, timeout, stale decision denied, clean exit');
 }finally{if(proc.exitCode===null)proc.kill();await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
