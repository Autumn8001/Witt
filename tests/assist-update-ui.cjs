"use strict";
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),{chromium}=require('playwright');
const repo=path.resolve(__dirname,'..'),out=path.join(repo,'artifacts/assist-update-ui');fs.mkdirSync(out,{recursive:true});
const wait=async(fn,ms=15000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,150))}throw Error('Timed out')};
(async()=>{
 const fixture=path.join(out,'options.json');fs.writeFileSync(fixture,JSON.stringify({Server:'https://cpa.stellarbit.site/vault-api'}));fs.rmSync(fixture+'.url',{force:true});
 const proc=spawn(path.join(repo,'artifacts/assist-browser-test.exe'),['-test.run=^TestAssistBrowserFixture$','-test.timeout=3m'],{env:{...process.env,ASSIST_BROWSER_FIXTURE:fixture},stdio:'ignore'});
 const browser=await chromium.launch({headless:true});let page;
 try{
  await wait(()=>fs.existsSync(fixture+'.url'));const url=fs.readFileSync(fixture+'.url','utf8'),origin=new URL(url).origin,secret=new URL(url).hash.slice(1);
  assert.equal((await fetch(origin+'/api/update/install',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'})).status,403);
  page=await browser.newPage({viewport:{width:1280,height:920}});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(url);
  await wait(async()=>await page.locator('#app-version').textContent()==='2026.10.16.5');
  if(await page.locator('#auto-update').isChecked())await page.locator('#auto-update').uncheck();
  await wait(async()=>{const r=await fetch(origin+'/api/status',{method:'POST',headers:{Origin:origin,Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:'{}'});return (await r.json()).update.auto===false});
  assert.equal(await page.locator('#update-install').isVisible(),false);
  await page.screenshot({path:path.join(out,'operations-1280.png'),fullPage:true});await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:path.join(out,'operations-390.png'),fullPage:true});
  await page.locator('#code').fill('DRAFT-CODE');await page.waitForTimeout(500);
  await page.locator('#update-check').click();await wait(async()=>await page.locator('#update-check').isEnabled());
  assert.equal(await page.locator('#code').inputValue(),'DRAFT-CODE');
  assert.deepEqual(errors,[]);await page.locator('#end').click();await wait(()=>proc.exitCode!==null);assert.equal(proc.exitCode,0);
  console.log(JSON.stringify({local_update_api:'PASS: unauthorized install refused',operation_page:'PASS: real local page and version, desktop/mobile, no overflow or JS errors',preferences:'PASS: automatic update opt-out saved through local API',pairing:'PASS: update check preserves draft',exit:'PASS: connector process exits'}));
 }finally{if(proc.exitCode===null){try{await page.locator('#end').click({timeout:1000});await wait(()=>proc.exitCode!==null,3000)}catch{}if(proc.exitCode===null)proc.kill()}await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
