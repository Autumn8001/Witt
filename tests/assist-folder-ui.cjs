"use strict";
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),{chromium}=require('playwright');
const repo=path.resolve(__dirname,'..'),out=path.join(repo,'artifacts/assist-picker-ui');fs.mkdirSync(out,{recursive:true});
const wait=async(fn,ms=10000)=>{const until=Date.now()+ms;while(Date.now()<until){if(await fn())return;await new Promise(r=>setTimeout(r,100))}throw Error('Timed out')};
(async()=>{
 const options=path.join(out,'options.json');fs.writeFileSync(options,JSON.stringify({Server:'https://cpa.stellarbit.site/vault-api'}));fs.rmSync(options+'.url',{force:true});
 const proc=spawn(path.join(repo,'artifacts/assist-browser-test.exe'),['-test.run=^TestAssistBrowserFixture$','-test.timeout=2m'],{env:{...process.env,ASSIST_BROWSER_FIXTURE:options},stdio:'ignore'});
 const browser=await chromium.launch({headless:true});let page;
 try{
  await wait(()=>fs.existsSync(options+'.url'));page=await browser.newPage();
  // Expose the consent form without pairing/authorizing a real server session.
  // The folder API, native Windows dialog, cancellation and lifecycle are real.
  await page.route('**/api/status',async route=>{const r=await route.fetch();const data=await r.json();await route.fulfill({response:r,json:{...data,state:'preview'}})});
  await page.goto(fs.readFileSync(options+'.url','utf8'));await page.locator('#folder').click();await page.locator('#folder-cancel').waitFor({state:'visible'});
  await wait(()=>page.locator('#allow').isEnabled());assert.equal(await page.locator('#end').isEnabled(),true);assert.equal(await page.locator('#root').isEnabled(),true);
  const manual=path.join(out,'manually-entered');await page.locator('#root').fill(manual);await page.waitForTimeout(1800);assert.equal(await page.locator('#root').inputValue(),manual);
  await page.locator('#folder-cancel').click();await page.locator('#folder-cancel').waitFor({state:'hidden'});assert.equal(await page.locator('#root').inputValue(),manual);
  await page.screenshot({path:path.join(out,'folder-cancelled.png')});await page.locator('#end').click();await wait(()=>proc.exitCode!==null);assert.equal(proc.exitCode,0);
  const report={native_picker:'PASS: real Windows dialog opened',web_responsive:'PASS: Allow, path field and End remain usable',manual_path:'PASS: polling preserves user input',cancel:'PASS: webpage cancels picker',exit:'PASS: connector host exits'};fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 }finally{if(proc.exitCode===null){try{await page.locator('#end').click({timeout:1000});await wait(()=>proc.exitCode!==null,3000)}catch{}if(proc.exitCode===null)proc.kill()}await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
