"use strict";
// Real existing Chloe browser UI + official Antigravity + actual Windows WSS.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),{chromium}=require('playwright');
const fullMode=process.env.ASSIST_TEST_FULL==='1';
const repo=path.resolve(__dirname,'..'),out=path.join(repo,fullMode?'artifacts/assist-antigravity-full':'artifacts/assist-antigravity-web');
const config=JSON.parse(fs.readFileSync(path.join(out,'context.json')));
const wait=async(fn,ms=20000)=>{const deadline=Date.now()+ms;while(Date.now()<deadline){const r=await fn();if(r)return r;await new Promise(r=>setTimeout(r,150));}throw Error('Timed out waiting for fixture');};
(async()=>{
 const browser=await chromium.launch({headless:true}),ctx=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:1000}});
 let proc;const report={};
 try{
  const api=async(route,body)=>{const response=await ctx.request.fetch(config.url+'/vault-api/'+route,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+config.token},...(body===undefined?{}:{data:body}),timeout:30000});const data=await response.json();if(!response.ok())throw Error(route+': '+JSON.stringify(data));return data;};
  const invite=await api('remote-assist/sessions',{ttl_minutes:20,allow_edits:true,allow_environment:true,allow_commands:true,...(fullMode?{access_mode:'full'}:{}),customer_label:'Antigravity Windows E2E'});
  const root=path.join(out,'project'),marker='antigravity-windows-'+crypto.randomUUID();fs.mkdirSync(root,{recursive:true});
  fs.writeFileSync(path.join(root,'README.md'),'# Windows Antigravity fixture\n'+marker+'\nProject files: verification.txt and check.ps1\n');
  fs.writeFileSync(path.join(root,'verification.txt'),marker+'\n');
  fs.writeFileSync(path.join(root,'check.ps1'),`$ErrorActionPreference='Stop'\nif ((Get-Content -Raw .\\verification.txt).Trim() -ne '${marker}-edited') { throw 'incorrect edit' }\nWrite-Output 'TEST_PASS ${marker}'; Write-Output ('OS='+[Environment]::OSVersion.Platform); Write-Output ('CWD='+(Get-Location).Path)\n`);
  const outside=path.join(out,'outside');fs.mkdirSync(outside,{recursive:true});fs.writeFileSync(path.join(outside,'secret.txt'),'OUTSIDE_AUTHORIZED_ROOT');
  const junction=path.join(root,'escape');if(!fs.existsSync(junction))fs.symlinkSync(outside,junction,'junction');
  const fixture=path.join(out,'fixture.json');fs.writeFileSync(fixture,JSON.stringify({Server:config.url+'/vault-api',Code:invite.pairing_code,Root:root,CAFile:config.caFile}));fs.rmSync(fixture+'.url',{force:true});
  proc=spawn(path.join(repo,'artifacts/assist-browser-test.exe'),['-test.run=^TestAssistBrowserFixture$','-test.timeout=20m'],{env:{...process.env,ASSIST_BROWSER_FIXTURE:fixture},stdio:['ignore',fs.openSync(path.join(out,'connector.log'),'w'),fs.openSync(path.join(out,'connector-error.log'),'w')]});
  await wait(()=>fs.existsSync(fixture+'.url'));const customer=await ctx.newPage();await customer.goto(fs.readFileSync(fixture+'.url','utf8'));
  await customer.locator('#preview').click();await customer.locator('#consent').waitFor({state:'visible'});
  const pending=(await api('remote-assist/sessions')).sessions.find(s=>s.assist_session_id===invite.assist_session_id);assert.equal(pending.state,'pending');assert.equal(pending.device_id,null);report.before_consent='PASS';
  if(!fullMode)for(const id of ['edits','environment','commands'])await customer.locator('#'+id).check();
  await customer.locator('#allow').click();report.initial_consent_count=1;
  await wait(async()=>((await api('remote-assist/sessions')).sessions.find(s=>s.assist_session_id===invite.assist_session_id)?.connected));
  const bound=await api('remote-assist/sessions/'+invite.assist_session_id+'/workspace',{model:'gemini-3.8-flash-high'});
  assert.equal(bound.workspace.harness_id,'google-antigravity');const id=bound.conversation.id;
  await ctx.addCookies([{name:'witt_session',value:config.token,url:config.url+'/vault-api/',httpOnly:true,secure:true,sameSite:'Strict'}]);
  await ctx.addInitScript(id=>{localStorage.setItem('wit_active_conversation',id);localStorage.setItem('wit_model_preference','gemini-3.8-flash-high');},id);
  const page=await ctx.newPage();const diagnostics=[];
  page.on('pageerror',e=>diagnostics.push({error:e.message}));
  page.on('requestfailed',r=>diagnostics.push({failed:new URL(r.url()).pathname,error:r.failure()?.errorText}));
  page.on('response',r=>{if(r.status()>=400)diagnostics.push({path:new URL(r.url()).pathname,status:r.status()});});
  await page.goto(config.url+'/vault/index.html');await page.locator('#messageInput').waitFor({state:'visible'});
  await page.waitForFunction(()=>typeof window.DropVault?.openConversation==='function',null,{timeout:20000});
  await page.evaluate(id=>window.DropVault.openConversation(id),id);
  console.log('Existing Chloe UI initialized');
  const get=async()=> (await api('chat/conversations/'+id)).conversation;
  let approvals=0;
  const approve=async()=>{
   if(await customer.locator('#change').isVisible()){
    assert.equal(fullMode,false,'Full-session unexpectedly requested another approval');
    const diff=await customer.locator('#diff').textContent();
    assert.ok(diff.includes('verification.txt')||diff.includes('check.ps1'),'Unexpected requested operation');
    if(diff.includes(marker+'-edited')&&!diff.includes('check.ps1')){assert.equal(fs.readFileSync(path.join(root,'verification.txt'),'utf8'),marker+'\n');fs.writeFileSync(path.join(out,'approved-diff.txt'),diff);}
    await customer.locator('#accept').click();approvals++;await new Promise(r=>setTimeout(r,500));
   }
  };
  const turn=async(text,label)=>{
   const before=(await get()).messages.length;
   await page.locator('#messageInput').fill(text);await page.locator('#sendButton').click();
   await page.screenshot({path:path.join(out,label+'-sent.png')});
   try{await wait(async()=> (await get()).messages.length>before,20000);}catch(e){fs.writeFileSync(path.join(out,'browser-diagnostics.json'),JSON.stringify({diagnostics,text:await page.locator('body').innerText()},null,2));throw e;}
   const conversation=await wait(async()=>{await approve();const c=await get();const a=c.messages.slice(before).find(m=>m.role==='assistant');return a&&['completed','failed','interrupted'].includes(a.status)?c:null;},300000);
   const last=conversation.messages.at(-1);
   for(const entry of last.stream||[])if(entry.kind==='command'&&entry.hasDetails){
    const data=await api('chat/conversations/'+id+'/messages/'+last.id+'/stream/'+encodeURIComponent(entry.id));
    Object.assign(entry,data.entry);
   }
   fs.writeFileSync(path.join(out,label+'.json'),JSON.stringify(conversation,null,2));
   const a=conversation.messages.at(-1);console.log(label,JSON.stringify({status:a.status,harness:conversation.harnessId,session:conversation.harnessSessionId,tools:a.stream?.filter(e=>e.kind==='command').map(e=>({label:e.label,status:e.status}))}));
   assert.equal(a.status,'completed',label+' failed; see private turn evidence');return {conversation,assistant:a};
  };
  const read=await turn('请实际调用原生 run_command 运行 chloe-remote --help、chloe-remote list 和 chloe-remote read README.md，报告README中的唯一标记和项目结构。只做读取。'+(fullMode?' 本次会话已明确获得完整访问授权，还请通过 chloe-remote read 读取这个测试绝对路径：'+path.join(outside,'secret.txt')+'。不需要再次请求客户授权。':''),'read');
  const serialized=JSON.stringify(read.assistant);assert.ok(serialized.includes(marker),'No actual Windows README result');assert.ok(serialized.includes('chloe-remote'),'No native CLI event');report.read='PASS';
  if(fullMode)assert.ok(JSON.stringify(read.assistant).includes('OUTSIDE_AUTHORIZED_ROOT'),'Full-consent absolute Windows path failed');
  const edit=await turn('请先通过 chloe-remote read verification.txt 取得真实内容和sha256，再用 chloe-remote patch 将唯一标记后追加 -edited，保留末尾换行。'+(fullMode?'完整会话已经授权，直接执行，不重复确认。':'等待客户批准差异，')+'只修改这一个文本文件，不提交Git。报告实际Diff。','edit');
  assert.equal(fs.readFileSync(path.join(root,'verification.txt'),'utf8'),marker+'-edited\n');
  if(!fullMode)assert.ok(fs.existsSync(path.join(out,'approved-diff.txt')));
  else assert.match(JSON.stringify(edit.assistant),/before_sha256|verification.txt \(before\)/);
  report.edit_diff='PASS';
  const run=await turn('请实际运行 chloe-remote exec powershell.exe \'["-NoProfile","-NonInteractive","-File","check.ps1"]\' . '+(fullMode?'完整会话已经授权，直接执行，不重复确认。':'等待客户批准，')+'然后解释测试输出、Windows系统标识和实际工作目录。不要运行其他命令。','run');
  assert.ok(JSON.stringify(run.assistant).includes('TEST_PASS '+marker));assert.ok(JSON.stringify(run.assistant).includes('Win32NT'));report.exec='PASS';
  assert.equal(read.conversation.harnessSessionId,run.conversation.harnessSessionId);report.resume='PASS';
  if(!fullMode){
   const escaped=await turn('只运行 chloe-remote read escape/secret.txt 验证目录junction越界会被拒绝，不使用其他方式读取。','junction');
   assert.match(JSON.stringify(escaped.assistant),/PATH_NOT_FOUND|PATH_OUTSIDE_ROOT/);assert.ok(!JSON.stringify(escaped.assistant).includes('OUTSIDE_AUTHORIZED_ROOT'));report.junction='PASS';
  }else{assert.equal(approvals,0);report.per_operation_prompts=0;report.full_session='PASS';}
  await page.screenshot({path:path.join(out,'web-result.png'),fullPage:true});
  await customer.locator('#end').click();await wait(async()=>((await api('remote-assist/sessions')).sessions.find(s=>s.assist_session_id===invite.assist_session_id)?.state==='revoked'));
  await wait(()=>proc.exitCode!==null);assert.equal(proc.exitCode,0);report.connector_exit='PASS';
  // Revocation must reject a new request before launching a new model turn.
  const rejected=await ctx.request.post(config.url+'/vault-api/chat/conversations/'+id+'/messages',{headers:{Authorization:'Bearer '+config.token},data:{text:'请通过chloe-remote读取README.md'}});
  const rejection=await rejected.json();
  if(rejected.ok()){
   // Chat accepts a message asynchronously; access must fail before a harness starts.
   const final=await wait(async()=>{const c=await get();return c.messages.at(-1)?.status==='failed'?c:null;});
   assert.ok(!final.messages.at(-1).stream.some(e=>e.kind==='command'),'Revoked workspace launched native terminal');
   rejection.final=final.messages.at(-1);
  }
  fs.writeFileSync(path.join(out,'revocation.json'),JSON.stringify({status:rejected.status(),body:rejection}));report.revocation='PASS';
  report.web_e2e='PASS';report.approvals=approvals;report.marker=marker;report.root=root;
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 }finally{if(proc&&proc.exitCode===null)proc.kill();await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
