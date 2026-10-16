"use strict";
// Isolated HTTPS/WSS + actual Windows connector + standard stdio MCP. No
// production credentials, model requests or customer files are involved.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),https=require('node:https'),crypto=require('node:crypto'),readline=require('node:readline');
const {spawn,execFileSync}=require('node:child_process'),{chromium}=require('playwright');
const {DeviceGateway}=require('../backend/remote-device/device-gateway'),{DeviceRegistry}=require('../backend/remote-device/device-registry');
const {createRemoteAssist}=require('../backend/remote-assist');
const {WorkspaceStore,WorkspaceAuditStore,ApprovalGate,WorkspaceDispatcher}=require('../backend/remote-workspace');
const {RemoteWorkspaceService}=require('../backend/remote-workspace-service');
const {createRemoteWorkspaceRoutes}=require('../backend/routes/remote-workspaces');
const repo=path.resolve(__dirname,'..'),out=path.join(repo,'artifacts/assist-full-session');fs.mkdirSync(out,{recursive:true});
const wait=async(fn,ms=15000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,50))}throw Error('Timed out')};
(async()=>{
 const cert=path.join(out,'cert.pem'),key=path.join(out,'key.pem');
 execFileSync('D:/Anaconda/Library/bin/openssl.exe',['req','-config','D:/Anaconda/Library/ssl/openssl.cnf','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
 const root=path.join(out,'project'),outside=path.join(out,'outside-project');fs.mkdirSync(root,{recursive:true});fs.mkdirSync(outside,{recursive:true});
 const file=path.join(outside,'verification.txt'),marker=crypto.randomUUID();fs.writeFileSync(file,marker);
 const gateway=new DeviceGateway({registry:new DeviceRegistry()}),store=new WorkspaceStore(path.join(out,'db')),audit=new WorkspaceAuditStore(path.join(out,'audit')),approvals=new ApprovalGate();
 const sendJson=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body))};
 const readJsonBody=(req,_limit,cb)=>{let raw='';req.on('data',v=>raw+=v);req.on('end',()=>{try{cb(null,JSON.parse(raw||'{}'))}catch(e){cb(e)}})};
 const plugin=createRemoteAssist({gateway,workspaceStore:store,auditDirectory:path.join(out,'assist'),sendJson,readJsonBody,chatFor:()=>{}});
 const dispatcher=new WorkspaceDispatcher({workspaceStore:store,audit,approvals,transport:plugin.transport,assistCommandsFor:id=>plugin.sessions.commandsAllowed(id),fullAccessFor:id=>plugin.sessions.fullAccessAllowed(id)});
 const service=new RemoteWorkspaceService({workspaceStore:store,audit,approvals,dispatcher,runtimeDir:path.join(out,'runtime'),capabilitiesFor:id=>gateway.registry.describe(id)?.capabilities||[]});
 const routes=createRemoteWorkspaceRoutes({gateway,service,sendJson,readJsonBody,chatFor:()=>{}});
 const server=https.createServer({key:fs.readFileSync(key),cert:fs.readFileSync(cert)},(req,res)=>{
  const url=new URL(req.url,'https://localhost');
  if(plugin.routes.handleCustomer(req,res,url)||routes.handleInternal(req,res,url))return;
  sendJson(res,404,{error:'NOT_FOUND'});
 });gateway.attach(server);await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='https://127.0.0.1:'+server.address().port;service.apiBase=base;
 const browser=await chromium.launch({headless:true});let proc,mcp;const report={};
 try{
  const invite=plugin.sessions.create({userId:'isolated-test',admin:true},{access_mode:'full',ttl_minutes:15});
  assert.equal(gateway.registry.list().length,0);report.before_consent='PASS: no authorized device';
  const fixture=path.join(out,'fixture.json');fs.writeFileSync(fixture,JSON.stringify({Server:base,Code:invite.pairing_code,CAFile:cert}));fs.rmSync(fixture+'.url',{force:true});
  proc=spawn(path.join(repo,'artifacts/assist-browser-test.exe'),['-test.run=^TestAssistBrowserFixture$','-test.timeout=2m'],{env:{...process.env,ASSIST_BROWSER_FIXTURE:fixture},stdio:'ignore'});
  await wait(()=>fs.existsSync(fixture+'.url'));const page=await browser.newPage({viewport:{width:1280,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(fs.readFileSync(fixture+'.url','utf8'));await page.locator('#preview').click();await page.locator('#full-consent').waitFor({state:'visible'});
  assert.equal(await page.locator('#edits').isVisible(),false);assert.match(await page.locator('#allow').textContent(),/完整访问/);assert.ok(await page.locator('#root').inputValue());assert.equal(gateway.registry.list().length,0);
  await page.screenshot({path:path.join(out,'consent-1280.png')});await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:path.join(out,'consent-390.png')});
  await page.locator('#allow').click();const s=plugin.sessions.sessions.get(invite.assist_session_id);await wait(()=>gateway.registry.describe(s.device_id)?.status==='online');
  assert.equal(plugin.sessions.fullAccessAllowed(s.device_id),true);assert.equal(gateway.registry.describe(s.device_id).capabilities.includes('workspace.full_access'),true);
  const bound=plugin.sessions.bindWorkspace(s,{createRemoteWorkspaceConversation:()=>({id:crypto.randomUUID(),harnessId:'grok-build',model:'grok-4.7-high'}),publicConversation:c=>c,readConversation:()=>({})});
  const runtime=service.runtimeFor(bound.workspace);mcp=spawn(process.execPath,[path.join(repo,'backend/mcp/remote-workspace.js')],{env:{...process.env,NODE_EXTRA_CA_CERTS:cert,WITT_REMOTE_WORKSPACE_MCP_ENABLED:'1',WITT_REMOTE_WORKSPACE_MCP_API:base,WITT_REMOTE_WORKSPACE_CREDENTIAL_FILE:runtime.credentialFile,WITT_REMOTE_WORKSPACE_CAPABILITIES:JSON.stringify(s.allowed_capabilities)},stdio:['pipe','pipe','pipe']});
  let next=0;const pending=new Map();readline.createInterface({input:mcp.stdout}).on('line',line=>{const data=JSON.parse(line);pending.get(data.id)?.(data.result);pending.delete(data.id)});
  const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++next,t=setTimeout(()=>{pending.delete(id);reject(Error('MCP timeout'))},15000);pending.set(id,v=>{clearTimeout(t);resolve(v)});mcp.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n')});
  await rpc('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'isolated-test',version:'1'}});
  const discovered=await rpc('tools/list',{});assert.match(discovered.tools.find(t=>t.name==='workspace_exec').description,/No per-command approval/);
  const call=(name,args)=>rpc('tools/call',{name,arguments:args});
  let result=await call('workspace_read',{path:file});assert.equal(result.isError,undefined);const read=JSON.parse(result.content[0].text);assert.ok(JSON.stringify(read).includes(marker));
  result=await call('workspace_patch',{path:file,expected_sha256:crypto.createHash('sha256').update(marker).digest('hex'),before:marker,after:marker+'-edited'});assert.equal(result.isError,undefined);assert.equal(fs.readFileSync(file,'utf8'),marker+'-edited');
  result=await call('workspace_exec',{program:'powershell.exe',argv:['-NoProfile','-NonInteractive','-Command','Get-Service | Select-Object -First 1 Name,Status | ConvertTo-Json -Compress; Write-Output '+marker],cwd:outside,timeout_ms:30000});
  assert.equal(result.isError,undefined,JSON.stringify(result));assert.ok(JSON.stringify(result).includes(marker));assert.equal(await page.locator('#change').isVisible(),false);
  assert.ok(plugin.sessions.audit(s).some(a=>a.operation==='workspace.exec.request'&&a.status==='session_authorized'));report.mcp='PASS: discovery -> actual WSS Windows connector -> absolute outside-root read/patch and Get-Service, no per-operation approval';
  await page.locator('#pause').click();await wait(()=>s.state==='paused');result=await call('workspace_read',{path:file});assert.equal(result.isError,true);report.pause='PASS: new MCP operation refused';
  await page.locator('#pause').click();await wait(()=>s.state==='active'&&gateway.registry.describe(s.device_id)?.status==='online');
  await page.locator('#end').click();await wait(()=>proc.exitCode!==null);assert.equal(s.state,'revoked');result=await call('workspace_read',{path:file});assert.equal(result.isError,true);report.revoke='PASS: access refused and temporary process exited';assert.deepEqual(errors,[]);
  report.model='NOT TESTED: no Grok/Gemini upstream request in this fixture';fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 }finally{
  if(proc&&proc.exitCode===null)proc.kill();if(mcp)mcp.kill();await browser.close();service.close();plugin.close();gateway.close();store.close();audit.close();await new Promise(r=>server.close(r));
 }
})().catch(e=>{console.error(e);process.exitCode=1});
