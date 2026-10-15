"use strict";
const fs=require("node:fs"),path=require("node:path"),assert=require("node:assert/strict");
const {chromium}=require("playwright");
const dir=path.resolve(__dirname,"../artifacts/assist-e2e"),config=JSON.parse(fs.readFileSync(path.join(dir,"context.json")));
const token=fs.readFileSync(config.operatorTokenFile,"utf8").trim();
(async()=>{
 const browser=await chromium.launch({headless:true});const report=[];
 try {
  for(const viewport of [{width:1440,height:900},{width:390,height:844}]){
   // This fixture uses a short-lived localhost test CA. The Windows executable
   // independently validates that exact CA; this flag is browser-test-only.
   const label=`界面验收 ${viewport.width} ${Date.now()}`;
   const context=await browser.newContext({viewport,ignoreHTTPSErrors:true,extraHTTPHeaders:{Authorization:`Bearer ${token}`}});
   const page=await context.newPage(),errors=[];
   page.on("pageerror",e=>errors.push(e.message));
   await page.goto(config.server.replace(/\/vault-api$/, "/"),{waitUntil:"networkidle"});
   await page.waitForFunction(()=>Boolean(window.WittCustomerDevices));
   await page.evaluate(()=>window.WittCustomerDevices.open());
   const panel=page.locator(".assist-panel");await panel.waitFor({state:"visible"});
   await page.locator('#customerDevicesSheet').evaluate(async sheet=>{
    await Promise.all(sheet.getAnimations({subtree:true}).filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));
    sheet.scrollTop=0;
   });
   await page.screenshot({path:path.join(dir,`assist-ui-form-${viewport.width}.png`),fullPage:false});
   await panel.locator('[name="customer_label"]').fill(label);
   await panel.locator('[name="allow_edits"]').check();
   await panel.locator('[data-assist-create] button').click();
   await panel.locator('[data-assist-code]').waitFor({state:"visible"});
   assert.match(await panel.locator('[data-assist-code]').innerText(),/chloe-assist\.exe join [A-F0-9]{5}-[A-F0-9]{5}/);
   await panel.locator('[data-assist-refresh]').click();
   await panel.locator('[data-session]').first().waitFor();
   const pending=panel.locator('[data-session]').filter({hasText:label});
   assert.equal(await pending.locator('[data-assist-open]').isDisabled(),true);
   await pending.locator('[data-assist-revoke]').click();
   await page.waitForFunction(label=>Array.from(document.querySelectorAll('.assist-session')).some(n=>n.textContent.includes(label)&&n.textContent.includes('已撤销')),label);
   await page.locator('#customerDevicesSheet').evaluate(sheet=>{sheet.scrollTop=0;});
   await page.screenshot({path:path.join(dir,`assist-ui-${viewport.width}.png`),fullPage:false});
   const geometry=await page.evaluate(()=>({page:document.documentElement.scrollWidth,viewport:innerWidth,panel:document.querySelector('.assist-panel').getBoundingClientRect().toJSON()}));
   assert.ok(geometry.page<=viewport.width+1,JSON.stringify(geometry));assert.deepEqual(errors,[]);
   report.push({viewport,create:"PASS",pendingCannotOpen:"PASS",revoke:"PASS",geometry,pageErrors:errors});
   await context.close();
  }
 } finally {await browser.close();}
 fs.writeFileSync(path.join(dir,"ui-results.json"),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
})().catch(e=>{console.error(e);process.exitCode=1});
