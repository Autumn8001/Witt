"use strict";
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),https=require('node:https'),crypto=require('node:crypto');
const {spawn}=require('node:child_process'),{chromium}=require('playwright');
const repo=path.resolve(__dirname,'..'),out=path.join(repo,'artifacts/assist-e2e'),config=JSON.parse(fs.readFileSync(path.join(out,'context.json')));
const operatorToken=fs.readFileSync(config.operatorTokenFile,'utf8').trim();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(fn,ms=30000){const end=Date.now()+ms;while(Date.now()<end){const v=await fn();if(v)return v;await sleep(300)}throw Error('Condition timed out')}
function api(route,body){return new Promise((resolve,reject)=>{const request=https.request(config.server+route,{method:body===undefined?'GET':'POST',ca:fs.readFileSync(config.caFile),headers:{Authorization:'Bearer '+operatorToken,'Content-Type':'application/json'}},res=>{let data='';res.on('data',c=>data+=c);res.on('end',()=>{try{const value=JSON.parse(data);if(res.statusCode<200||res.statusCode>=300)reject(Error('HTTP '+res.statusCode+': '+(value.error||'API request failed')));else resolve(value)}catch(e){reject(e)}})});request.on('error',reject);request.end(body===undefined?undefined:JSON.stringify(body))})}
async function session(id){return (await api('/remote-assist/sessions')).sessions.find(s=>s.assist_session_id===id)}
async function send(cid,text){return (await api('/chat/conversations/'+cid+'/messages',{text,attachmentIds:[],clientRequestId:crypto.randomUUID()})).messageId}
async function reply(cid,mid){const r=await api('/chat/conversations/'+cid);return (r.conversation||r).messages.find(m=>m.role==='assistant'&&m.replyTo===mid&&!['queued','running'].includes(m.status))}
(async()=>{
 const report={},browser=await chromium.launch({headless:true});let proc,sid,page;
 try{
  const root=path.join(out,'browser-workspace');fs.mkdirSync(root,{recursive:true});const file=path.join(root,'verification.txt'),marker='browser-assist-'+crypto.randomBytes(8).toString('hex');fs.writeFileSync(file,marker+'\n');
  const fixture=path.join(out,'browser-fixture.json');
  if(!process.argv.includes('--lifecycle-only')){
  const invite=await api('/remote-assist/sessions',{customer_label:'浏览器授权验收',ttl_minutes:15,allow_edits:true});sid=invite.assist_session_id;
  fs.writeFileSync(fixture,JSON.stringify({Server:config.server,Code:invite.pairing_code,Root:root,CAFile:config.caFile}));fs.rmSync(fixture+'.url',{force:true});
  proc=spawn(path.join(repo,'artifacts/assist-browser-test.exe'),['-test.run=^TestAssistBrowserFixture$','-test.timeout=10m'],{env:{...process.env,ASSIST_BROWSER_FIXTURE:fixture},stdio:['ignore','pipe','pipe']});let processLog='';proc.stdout.on('data',c=>processLog+=c);proc.stderr.on('data',c=>processLog+=c);
  await wait(()=>fs.existsSync(fixture+'.url'));const url=fs.readFileSync(fixture+'.url','utf8'),origin=new URL(url).origin,secret=new URL(url).hash.slice(1);
  assert.equal((await fetch(origin+'/api/status',{method:'POST',body:'{}',headers:{Origin:origin}})).status,403);
  assert.equal((await fetch(origin+'/api/status',{method:'POST',body:'{}',headers:{Origin:'https://foreign.invalid',Authorization:'Bearer '+secret}})).status,403);report.local_api='PASS: missing token and foreign origin denied';
  page=await browser.newPage({viewport:{width:1280,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(url);
  await page.locator('#server').inputValue().then(v=>assert.equal(v,config.server));
  await page.locator('#preview').click();await page.locator('#consent').waitFor({state:'visible'});assert.equal((await session(sid)).state,'pending');
  await page.screenshot({path:path.join(out,'browser-consent-1280.png')});await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(out,'browser-consent-390.png')});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.setViewportSize({width:1280,height:900});
  report.unauthorized='PASS: preview page does not authorize file access';
  await page.locator('#edits').check();await page.locator('#allow').click();await wait(async()=>Boolean((await session(sid)).connected));report.web_authorization='PASS: browser Allow established actual Windows WSS';
  const bound=await api('/remote-assist/sessions/'+sid+'/workspace',{model:'grok-4.7-high'}),cid=bound.conversation.id;
  let mid=await send(cid,'请通过 witt_remote_workspace MCP 的 workspace_read 读取 verification.txt，原样报告唯一校验字符串。必须真正调用远程 MCP，不使用服务器本地文件工具。');
  let answer=await wait(()=>reply(cid,mid),180000);assert.equal(answer.status,'completed');assert.ok(answer.text.includes(marker),answer.text);report.grok_read='PASS: actual Grok Build Harness / Gemini upstream -> MCP -> Windows marker';
  mid=await send(cid,`请通过远程 MCP 读取 verification.txt 的 SHA-256，使用 workspace_patch 将 ${marker} 替换为 ${marker}-edited。仅修改这个文件，等待客户确认差异。禁止服务器本地文件工具。`);
  await page.locator('#change').waitFor({state:'visible',timeout:180000});assert.equal(fs.readFileSync(file,'utf8'),marker+'\n');assert.ok((await page.locator('#diff').textContent()).includes(marker+'-edited'));await page.screenshot({path:path.join(out,'browser-diff.png')});
  await page.locator('#accept').click();answer=await wait(()=>reply(cid,mid),180000);assert.equal(answer.status,'completed');assert.equal(fs.readFileSync(file,'utf8'),marker+'-edited\n');
  const audit=(await api('/remote-assist/sessions/'+sid+'/audit')).audit;assert.ok(audit.some(a=>a.operation==='workspace.patch'&&a.change?.diff&&a.status==='completed'));report.web_diff='PASS: unchanged before browser approval; real patch and audit diff';
  await page.locator('#pause').click();await wait(async()=>((await session(sid)).state==='paused'));report.pause='PASS: Gateway paused';await page.waitForTimeout(800);await page.locator('#pause').click();await wait(async()=>((await session(sid)).state==='active'&&(await session(sid)).connected));report.resume='PASS: explicit browser resume';
  await page.locator('#end').click();await wait(()=>proc.exitCode!==null);assert.equal(proc.exitCode,0,processLog);assert.equal((await session(sid)).state,'revoked');report.end='PASS: server revoked; browser connector process exited';
  assert.deepEqual(errors,[]);report.ui='PASS: desktop/mobile, no overflow or page errors';
  }
  for(const mode of ['navigate','close']){
   const next=await api('/remote-assist/sessions',{customer_label:'浏览器退出验收 '+mode,ttl_minutes:15,allow_edits:false});sid=next.assist_session_id;
   fs.writeFileSync(fixture,JSON.stringify({Server:config.server,Code:next.pairing_code,Root:root,CAFile:config.caFile}));fs.rmSync(fixture+'.url',{force:true});
   proc=spawn(path.join(repo,'artifacts/assist-browser-test.exe'),['-test.run=^TestAssistBrowserFixture$','-test.timeout=10m'],{env:{...process.env,ASSIST_BROWSER_FIXTURE:fixture},stdio:'ignore'});
   await wait(()=>fs.existsSync(fixture+'.url'));page=await browser.newPage();await page.goto(fs.readFileSync(fixture+'.url','utf8'));await page.locator('#preview').click();await page.locator('#allow').waitFor({state:'visible'});await page.locator('#allow').click();await wait(async()=>Boolean((await session(sid)).connected));
   if(mode==='navigate'){await page.goto('about:blank')}else{await page.close();console.log('Checking 120-second browser-loss lease',new Date().toISOString())}
   await wait(()=>proc.exitCode!==null,mode==='close'?140000:15000);assert.equal(proc.exitCode,0);assert.equal((await session(sid)).state,'revoked');report[mode==='navigate'?'page_unload':'page_close_lease']='PASS: grant revoked and connector host exited';
  }
  console.log(JSON.stringify(report));
 }catch(e){report.failure=e.stack;throw e}finally{
  if(sid){try{await api('/remote-assist/sessions/'+sid+'/revoke',{})}catch{}}
  if(proc&&proc.exitCode===null){if(page){try{await page.locator('#end').click({timeout:1500});await wait(()=>proc.exitCode!==null,5000)}catch{}}if(proc.exitCode===null)proc.kill()}
  await browser.close();fs.writeFileSync(path.join(out,process.argv.includes('--lifecycle-only')?'browser-lifecycle-results.json':'browser-results.json'),JSON.stringify(report,null,2));
 }
})().catch(e=>{console.error(e);process.exitCode=1});
