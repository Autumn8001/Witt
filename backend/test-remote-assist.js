"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { DeviceGateway } = require("./remote-device/device-gateway");
const { DeviceRegistry } = require("./remote-device/device-registry");
const { WorkspaceStore } = require("./remote-workspace");
const { AssistSessions, READ, EDIT } = require("./remote-assist/session-service");
const { createRemoteAssist } = require("./remote-assist");
const { GrokBuildAdapter } = require("./runtime/grok-build-adapter");
const operator = {userId:"operator-one",label:"测试服务方",admin:true};
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"chloe-assist-test-"));let now=Date.now();
  const gateway=new DeviceGateway({registry:new DeviceRegistry(),now:()=>now});
  const workspaceStore=new WorkspaceStore(root);
  const sessions=new AssistSessions({gateway,workspaceStore,auditDirectory:root,now:()=>now});
  gateway.dispatcher.authorizeCommand=(id,args)=>sessions.guardDevice(id,args);
  t.after(()=>{sessions.close();gateway.close();workspaceStore.close();fs.rmSync(root,{recursive:true,force:true});});
  return {sessions,gateway,workspaceStore,advance:n=>{now+=n;}};
}
function grant(sessions,allowEdits=true){
  const invite=sessions.create(operator,{allow_edits:allowEdits});
  const preview=sessions.preview(invite.pairing_code);
  const grant=sessions.authorize({pair_ticket:preview.pair_ticket,workspace_root:"D:/assist-test",allowed_capabilities:preview.allowed_capabilities});
  return {invite,preview,grant,session:sessions.sessions.get(invite.assist_session_id)};
}
test("pairing needs explicit authorization, is single-use and never grants full access or exec",t=>{
  const {sessions,gateway}=fixture(t);const invite=sessions.create(operator,{allow_edits:true});
  assert.equal(gateway.registry.list().length,0);
  const preview=sessions.preview(invite.pairing_code);
  assert.equal(preview.device_token,undefined);assert.equal(gateway.registry.list().length,0);
  const result=sessions.authorize({pair_ticket:preview.pair_ticket,workspace_root:"D:/assist-test",allowed_capabilities:[...READ]});
  assert.deepEqual(result.allowed_capabilities,READ);
  assert.ok(!JSON.stringify(sessions.public(sessions.customer(result.device_token))).includes(result.device_token));
  assert.throws(()=>sessions.authorize({pair_ticket:preview.pair_ticket}),/PAIR_NOT_AVAILABLE/);
  assert.throws(()=>sessions.preview(invite.pairing_code),/PAIR_NOT_AVAILABLE/);
  assert.ok(!gateway.registry.definition(result.device_id).capabilities.includes("workspace.full_access"));
});
test("authorization rejects escalated capabilities and invalid roots",t=>{
  const {sessions}=fixture(t);
  for(const extra of ["workspace.full_access","workspace.exec","screen.capture"]){
    const invite=sessions.create(operator,{}),p=sessions.preview(invite.pairing_code);
    assert.throws(()=>sessions.authorize({pair_ticket:p.pair_ticket,workspace_root:"D:/test",allowed_capabilities:[...READ,extra]}),/INVALID_CAPABILITIES/);
  }
});
test("scope is bound to one session and owner, pause/revoke/expiry refuse new operations",t=>{
  const {sessions,gateway,advance}=fixture(t);const {grant:g,session:s}=grant(sessions);
  const allowed={tool:"workspace",capability:"workspace.read",args:{root:"project"},context:{workspaceSessionId:g.assist_session_id}};
  assert.throws(()=>sessions.guardDevice(g.device_id,allowed),/SCOPE_DENIED/); // no workspace bound yet
  s.workspace_id=s.assist_session_id;
  sessions.guardDevice(g.device_id,allowed);
  assert.throws(()=>sessions.owned(s.assist_session_id,{userId:"different"}),/NOT_FOUND/);
  assert.throws(()=>sessions.guardDevice(g.device_id,{...allowed,context:{workspaceSessionId:"other"}}),/SCOPE_DENIED/);
  assert.throws(()=>sessions.guardDevice(g.device_id,{...allowed,capability:"workspace.exec"}),/SCOPE_DENIED/);
  sessions.transition(s,"paused");assert.throws(()=>sessions.guardDevice(g.device_id,allowed),/NOT_ACTIVE/);
  sessions.transition(s,"active");sessions.guardDevice(g.device_id,allowed);
  advance(61*60_000);sessions.sweep();assert.equal(s.state,"expired");
  assert.throws(()=>sessions.customer(g.device_token),/NOT_AUTHORIZED/);
  assert.equal(gateway.registry.authenticate(g.device_id,g.device_token),false);
  assert.throws(()=>sessions.guardDevice(g.device_id,allowed),/NOT_ACTIVE/);
});
test("disconnect revokes active credentials; paused sessions can explicitly resume",t=>{
  const {sessions,gateway}=fixture(t);const {grant:g,session:s}=grant(sessions);
  sessions.disconnected(g.device_id);assert.equal(s.state,"revoked");
  assert.equal(gateway.registry.authenticate(g.device_id,g.device_token),false);
  const second=grant(sessions);sessions.transition(second.session,"paused");sessions.disconnected(second.grant.device_id);
  assert.equal(second.session.state,"paused");sessions.transition(second.session,"active");assert.equal(second.session.state,"active");
});
test("pair codes expire and rate limits apply before filesystem access",t=>{
  const {sessions,advance}=fixture(t);const invite=sessions.create(operator,{});advance(5*60_000);
  assert.throws(()=>sessions.preview(invite.pairing_code),/NOT_AVAILABLE/);
  for(let i=0;i<9;i++)assert.throws(()=>sessions.preview("BAD"),/NOT_AVAILABLE/);
  assert.throws(()=>sessions.preview("BAD"),/RATE_LIMIT/);
});
test("plugin factory preserves legacy devices while rejecting unknown assist devices",t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"chloe-assist-factory-"));
  const gateway=new DeviceGateway({registry:new DeviceRegistry()}),workspaceStore=new WorkspaceStore(root);
  const plugin=createRemoteAssist({gateway,workspaceStore,auditDirectory:root,chatFor:()=>{},readJsonBody:()=>{},sendJson:()=>{}});
  t.after(()=>{plugin.close();gateway.close();workspaceStore.close();fs.rmSync(root,{recursive:true,force:true});});
  assert.equal(gateway.canConnect("legacy-device"),true);
  assert.equal(gateway.canConnect("assist-unknown"),false);
  assert.throws(()=>gateway.dispatcher.dispatch("assist-unknown","workspace",{operation:"workspace.read",root:"project",path:"file"}),/SESSION_NOT_AUTHORIZED/);
  const created=plugin.sessions.create(operator,{}),p=plugin.sessions.preview(created.pairing_code);
  const g=plugin.sessions.authorize({pair_ticket:p.pair_ticket,workspace_root:"D:/test",allowed_capabilities:READ});
  assert.equal(gateway.canConnect(g.device_id),true);plugin.sessions.transition(plugin.sessions.sessions.get(created.assist_session_id),"paused");
  assert.equal(gateway.canConnect(g.device_id),false);
});
test("Grok Assist uses reviewed runtime MCP and excludes server filesystem and shell tools",()=>{
  const adapter=new GrokBuildAdapter({bin:"unused",remoteWorkspace:{assistSession:true}});
  const args=adapter.buildArgs({prompt:"test",cwd:"/generated/assist-runtime"});
  assert.ok(args.includes("--trust"));assert.ok(args.includes("MCPTool(witt_remote_workspace__*)"));
  assert.equal(args[args.indexOf("--tools")+1],"search_tool,use_tool");
  const normal=new GrokBuildAdapter({bin:"unused"}).buildArgs({prompt:"test"});assert.ok(!normal.includes("--trust"));assert.ok(!normal.includes("--tools"));
});
test("audit survives a restart but device credentials and active authorization do not",t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"chloe-assist-restart-"));
  const gateway=new DeviceGateway({registry:new DeviceRegistry()}),workspaceStore=new WorkspaceStore(root);
  let sessions=new AssistSessions({gateway,workspaceStore,auditDirectory:root});
  t.after(()=>{sessions.close();gateway.close();workspaceStore.close();fs.rmSync(root,{recursive:true,force:true});});
  const {grant:g,session:s}=grant(sessions);
  sessions.record(s,"workspace.patch","sample.txt","completed",{diff:"- before\n+ after"});
  sessions.close();sessions=new AssistSessions({gateway,workspaceStore,auditDirectory:root});
  assert.equal(sessions.owned(s.assist_session_id,operator).state,"revoked");
  assert.throws(()=>sessions.customer(g.device_token),/NOT_AUTHORIZED/);
  assert.equal(gateway.registry.authenticate(g.device_id,g.device_token),false);
  assert.ok(sessions.audit(s).some(a=>a.change?.diff==="- before\n+ after"));
  assert.equal(fs.readFileSync(path.join(root,"assist-audit.sqlite")).includes(Buffer.from(g.device_token)),false);
});

test("environment and command grants are explicit, reduced by customer and revoked with session",t=>{
  const {sessions}=fixture(t);
  const invite=sessions.create(operator,{allow_environment:true,allow_commands:true});
  const preview=sessions.preview(invite.pairing_code);
  assert.ok(preview.allowed_capabilities.includes("workspace.system_info"));
  assert.ok(preview.allowed_capabilities.includes("workspace.exec"));
  const g=sessions.authorize({pair_ticket:preview.pair_ticket,workspace_root:"D:/test",allowed_capabilities:[...READ,"workspace.system_info"]});
  const s=sessions.sessions.get(g.assist_session_id);s.workspace_id=s.assist_session_id;
  assert.equal(sessions.commandsAllowed(g.device_id),false);
  const context={workspaceSessionId:g.assist_session_id};
  sessions.guardDevice(g.device_id,{tool:"workspace",capability:"workspace.system_info",args:{},context});
  assert.throws(()=>sessions.guardDevice(g.device_id,{tool:"workspace",capability:"workspace.exec",args:{root:"project"},context}),/SCOPE_DENIED/);
  const next=sessions.create(operator,{allow_commands:true}),p=sessions.preview(next.pairing_code);
  const command=sessions.authorize({pair_ticket:p.pair_ticket,workspace_root:"D:/test",allowed_capabilities:p.allowed_capabilities});
  const cs=sessions.sessions.get(command.assist_session_id);cs.workspace_id=cs.assist_session_id;
  assert.equal(sessions.commandsAllowed(command.device_id),true);
  assert.ok(!command.allowed_capabilities.includes("workspace.full_access"));
  sessions.guardDevice(command.device_id,{tool:"workspace",capability:"workspace.exec",args:{root:"project"},context:{workspaceSessionId:cs.assist_session_id}});
  sessions.transition(cs,"paused");assert.equal(sessions.commandsAllowed(command.device_id),false);
  sessions.transition(cs,"active");assert.equal(sessions.commandsAllowed(command.device_id),true);
  sessions.transition(cs,"revoked");assert.equal(sessions.commandsAllowed(command.device_id),false);
});
