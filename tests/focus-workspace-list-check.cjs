const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {randomUUID}=require('node:crypto');
const {WorkspaceStore}=require('../backend/remote-workspace/workspace-store');
const {createRemoteWorkspaceRoutes}=require('../backend/routes/remote-workspaces');
test('workspace listing exposes only owned conversations and public binding fields',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chloe-workspaces-'));const store=new WorkspaceStore(dir);
 try{
  const binding=()=>({workspace_id:randomUUID(),conversation_id:randomUUID(),customer_id:'personal',device_id:'DEV-PC',root_alias:'project',display_path:'D:/Coding',harness_id:'codex',model_id:'gpt-6.1-sol',harness_session_id:randomUUID()});
  const own=store.create(binding()),other=store.create(binding());let response;
  const route=createRemoteWorkspaceRoutes({gateway:{},service:{workspaceStore:store},chatFor:()=>({readConversation:id=>id===own.conversation_id?{title:'Private task'}:null}),sendJson:(_res,status,body)=>{response={status,body}}});
  route.handlePublic({method:'GET'},{},new URL('http://test/remote-workspaces'),{admin:false});assert.equal(response.status,403);
  route.handlePublic({method:'GET'},{},new URL('http://test/remote-workspaces'),{admin:true});assert.equal(response.status,200);assert.equal(response.body.workspaces.length,1);assert.equal(response.body.workspaces[0].title,'Private task');assert.equal(response.body.workspaces[0].harness_session_id,undefined);assert.equal(response.body.workspaces[0].customer_id,undefined);
  route.handlePublic({method:'POST'},{},new URL('http://test/remote-workspaces/'+own.workspace_id+'/pause'),{admin:true});assert.equal(store.get(own.workspace_id).state,'paused');
  route.handlePublic({method:'POST'},{},new URL('http://test/remote-workspaces/'+own.workspace_id+'/resume'),{admin:true});assert.equal(store.get(own.workspace_id).state,'active');assert.equal(store.get(other.workspace_id).state,'active');
  const remove=id=>route.handlePublic({method:'DELETE'},{},new URL('http://test/remote-workspaces/'+id),{admin:true});
  remove(other.workspace_id);assert.equal(response.status,404);
  remove(own.workspace_id);assert.equal(response.status,409);
  store.setState(own.workspace_id,'closed');remove(own.workspace_id);assert.equal(response.status,200);
  assert.equal(store.list().some(w=>w.workspace_id===own.workspace_id),false);
  assert.equal(store.getByConversation(own.conversation_id).state,'closed');
 }finally{store.close();fs.rmSync(dir,{recursive:true,force:true})}
});
