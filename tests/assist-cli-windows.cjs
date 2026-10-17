"use strict";
// Explicitly authorized Windows fixture for the Linux native-shell CLI spike.
// No production session or customer files. Run via the opt-in Python orchestrator.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),https=require('node:https'),crypto=require('node:crypto');
const {spawn,execFileSync}=require('node:child_process'),{chromium}=require('playwright');
const {DeviceGateway}=require('../backend/remote-device/device-gateway'),{DeviceRegistry}=require('../backend/remote-device/device-registry');
const {createRemoteAssist}=require('../backend/remote-assist');
const {WorkspaceStore,WorkspaceAuditStore,ApprovalGate,WorkspaceDispatcher}=require('../backend/remote-workspace');
const {RemoteWorkspaceService}=require('../backend/remote-workspace-service');
const {createRemoteWorkspaceRoutes}=require('../backend/routes/remote-workspaces');
const repo=path.resolve(__dirname,'..'),out=path.join(repo,'artifacts/assist-cli-spike');fs.mkdirSync(out,{recursive:true});fs.rmSync(path.join(out,'context.json'),{force:true});fs.rmSync(path.join(out,'finish.json'),{force:true});
const wait=async(fn,ms=15000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,50))}throw Error('Timed out')};
(async()=>{
 const cert=path.join(out,'cert.pem'),key=path.join(out,'key.pem');
 execFileSync('D:/Anaconda/Library/bin/openssl.exe',['req','-config','D:/Anaconda/Library/ssl/openssl.cnf','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
 const root=path.join(out,'project');fs.mkdirSync(root,{recursive:true});
 const file=path.join(root,'verification.txt'),marker='cli-windows-'+crypto.randomUUID();fs.writeFileSync(file,marker+'\n');
 const outside=path.join(out,'outside');fs.mkdirSync(outside,{recursive:true});fs.writeFileSync(path.join(outside,'secret.txt'),'outside authorized root');
 const junction=path.join(root,'escape');if(!fs.existsSync(junction))fs.symlinkSync(outside,junction,'junction');
 assert.equal(fs.readFileSync(path.join(junction,'secret.txt'),'utf8'),'outside authorized root');
 fs.writeFileSync(path.join(root,'README.md'),'# Authorized Windows CLI fixture\n'+marker+'\nFiles: verification.txt, check.ps1\n');
 fs.writeFileSync(path.join(root,'check.ps1'),`$ErrorActionPreference='Stop'
if ((Get-Content -Raw .\\verification.txt).Trim() -ne '${marker}-edited') { throw 'incorrect edit' }
Write-Output 'TEST_PASS ${marker}'; Write-Output ('OS='+[Environment]::OSVersion.Platform); Write-Output ('CWD='+(Get-Location).Path)
`);
 const control=crypto.randomBytes(32).toString('hex');let s,page;
 const gateway=new DeviceGateway({registry:new DeviceRegistry()}),store=new WorkspaceStore(path.join(out,'db')),audit=new WorkspaceAuditStore(path.join(out,'audit')),approvals=new ApprovalGate();
 const sendJson=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body))};
 const readJsonBody=(req,_limit,cb)=>{let raw='';req.on('data',v=>raw+=v);req.on('end',()=>{try{cb(null,JSON.parse(raw||'{}'))}catch(e){cb(e)}})};
 const plugin=createRemoteAssist({gateway,workspaceStore:store,auditDirectory:path.join(out,'assist'),sendJson,readJsonBody,chatFor:()=>{}});
 const dispatcher=new WorkspaceDispatcher({workspaceStore:store,audit,approvals,transport:plugin.transport,assistCommandsFor:id=>plugin.sessions.commandsAllowed(id),fullAccessFor:id=>plugin.sessions.fullAccessAllowed(id)});
 const service=new RemoteWorkspaceService({workspaceStore:store,audit,approvals,dispatcher,runtimeDir:path.join(out,'runtime'),capabilitiesFor:id=>gateway.registry.describe(id)?.capabilities||[]});
 const routes=createRemoteWorkspaceRoutes({gateway,service,sendJson,readJsonBody,chatFor:()=>{}});
 const server=https.createServer({key:fs.readFileSync(key),cert:fs.readFileSync(cert)},(req,res)=>{
  const url=new URL(req.url,'https://localhost');
  if(url.pathname.startsWith('/fixture/') && req.headers.authorization==='Bearer '+control){
   (async()=>{
    if(url.pathname==='/fixture/pause'){
     await page.locator('#pause').click();await wait(()=>s.state==='paused');await new Promise(r=>setTimeout(r,500));
    }else if(url.pathname==='/fixture/resume'){
     await page.locator('#pause').click();await wait(()=>s.state==='active'&&gateway.registry.describe(s.device_id)?.status==='online');
    }else if(url.pathname==='/fixture/revoke'){
     await page.locator('#end').click();await wait(()=>s.state==='revoked');
    }else throw Error('UNKNOWN_CONTROL');
    sendJson(res,200,{ok:true});
   })().catch(e=>sendJson(res,400,{error:e.code||'FIXTURE_CONTROL_FAILED'}));return;
  }
  if(plugin.routes.handleCustomer(req,res,url)||routes.handleInternal(req,res,url))return;
  sendJson(res,404,{error:'NOT_FOUND'});
 });gateway.attach(server);await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='https://127.0.0.1:'+server.address().port;service.apiBase=base;
 const browser=await chromium.launch({headless:true});let proc;const report={};
 try{
  const invite=plugin.sessions.create({userId:'isolated-test',admin:true},{ttl_minutes:15,allow_edits:true,allow_environment:true,allow_commands:true});
  assert.equal(gateway.registry.list().length,0);report.before_consent='PASS: no authorized device';
  const fixture=path.join(out,'fixture.json');fs.writeFileSync(fixture,JSON.stringify({Server:base,Code:invite.pairing_code,Root:root,CAFile:cert}));fs.rmSync(fixture+'.url',{force:true});
  proc=spawn(path.join(repo,'artifacts/assist-browser-test.exe'),['-test.run=^TestAssistBrowserFixture$','-test.timeout=15m'],{env:{...process.env,ASSIST_BROWSER_FIXTURE:fixture},stdio:'ignore'});
  await wait(()=>fs.existsSync(fixture+'.url'));page=await browser.newPage({viewport:{width:1280,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(fs.readFileSync(fixture+'.url','utf8'));await page.locator('#preview').click();await page.locator('#consent').waitFor({state:'visible'});
  assert.equal(gateway.registry.list().length,0);await page.locator('#edits').check();await page.locator('#environment').check();await page.locator('#commands').check();
  await page.locator('#allow').click();s=plugin.sessions.sessions.get(invite.assist_session_id);await wait(()=>gateway.registry.describe(s.device_id)?.status==='online');
  assert.equal(plugin.sessions.fullAccessAllowed(s.device_id),false);
  const bound=plugin.sessions.bindWorkspace(s,{createRemoteWorkspaceConversation:()=>({id:crypto.randomUUID(),harnessId:'grok-build',model:'grok-4.7-high'}),publicConversation:c=>c,readConversation:()=>({})});
  const runtime=service.runtimeFor(bound.workspace);
  fs.writeFileSync(path.join(out,'context.json'),JSON.stringify({port:server.address().port,secret:runtime.secret,control,marker,root,caFile:cert}));
  let approvalsCount=0;
  const deadline=Date.now()+10*60_000;
  while(!fs.existsSync(path.join(out,'finish.json')) && Date.now()<deadline){
   if(await page.locator('#change').isVisible()){
    const diff=await page.locator('#diff').textContent();
    if(diff.includes(marker+'-edited') && !diff.includes('check.ps1')){
     assert.equal(fs.readFileSync(file,'utf8'),marker+'\n');
     fs.writeFileSync(path.join(out,'approved-diff.txt'),diff);
    }
    assert.ok(diff.includes('verification.txt') || diff.includes('check.ps1'), 'Unexpected operation requiring approval');
    await page.locator('#accept').click();approvalsCount++;
   }
   await new Promise(r=>setTimeout(r,100));
  }
  assert.ok(fs.existsSync(path.join(out,'finish.json')),'Orchestrator did not finish');
  assert.equal(fs.readFileSync(file,'utf8'),marker+'-edited\n');
  await wait(()=>proc.exitCode!==null);assert.equal(s.state,'revoked');
  report.windows='PASS: actual restricted WSS connector, browser consent and edit/command approval';
  report.approvals=approvalsCount;report.exited=proc.exitCode===0;assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(out,'windows-results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 }finally{
  fs.unlinkSync(junction);
  if(proc&&proc.exitCode===null)proc.kill();await browser.close();service.close();plugin.close();gateway.close();store.close();audit.close();await new Promise(r=>server.close(r));
 }
})().catch(e=>{console.error(e);process.exitCode=1});
