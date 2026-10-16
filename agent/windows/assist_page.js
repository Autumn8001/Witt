"use strict";
// The browser fragment is never sent in HTTP requests or to the gateway.
const token=location.hash.slice(1);history.replaceState(null,"",location.pathname);
const $=id=>document.getElementById(id);let approvalID="",busy=false,ended=false,editingPair=false,lastRoot=null;
async function api(route,body={}){
 const r=await fetch('/api/'+route,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(body),cache:'no-store'});
 const data=await r.json();if(!r.ok)throw Error(data.error||'请求失败');return data;
}
async function action(fn){if(busy)return;busy=true;$('error').textContent='';document.querySelectorAll('button').forEach(b=>b.disabled=true);try{await fn();await refresh()}catch(e){$('error').textContent=e.message}finally{busy=false;document.querySelectorAll('button').forEach(b=>b.disabled=false);refresh().catch(()=>{})}}
async function refresh(){
 if(ended)return;const s=await api('status');
 const labels={unpaired:'尚未授权 · 本机文件不可访问',preview:'等待你的授权 · 本机文件不可访问',connecting:'正在建立加密连接',connected:'Connected · 已连接',paused:'Paused · 已暂停',disconnected:'Disconnected · 已断开'};
 $('status').textContent=labels[s.state]||s.state;
 const before=['unpaired','preview'].includes(s.state);$('pair').hidden=s.state!=='unpaired'&&!editingPair;$('consent').hidden=s.state!=='preview'||editingPair;$('session').hidden=before;
 if(!$('server').value)$('server').value=s.server;if(!$('code').value)$('code').value=s.code;
 if(s.root!==lastRoot){if(s.root)$('root').value=s.root;lastRoot=s.root}
 $('folder').disabled=busy||s.folder_pending;$('folder-cancel').hidden=!s.folder_pending;
 $('folder-status').textContent=s.folder_pending?'Windows 目录选择窗口已打开，请查看任务栏或按 Alt＋Tab 切换。也可取消后直接粘贴目录路径。':s.folder_error||'';
 $('service').textContent=s.server;$('operator').textContent=s.operator;$('expires').textContent=s.expires?new Date(s.expires).toLocaleString():'';
 $('edits').disabled=!s.capabilities?.includes('workspace.write');
 $('scope').textContent=`授权目录：${s.root} · 服务方：${s.operator} · 到期：${s.expires?new Date(s.expires).toLocaleString():''}`;
 $('pause').textContent=s.state==='paused'?'恢复协助':'暂停协助';$('logs').textContent=s.logs.join('\n')||'暂无操作。';
 const oldApproval=approvalID;approvalID=s.approval?.id||'';$('change').hidden=!approvalID;
 if(s.approval){$('file').textContent=s.approval.file;$('diff').textContent=s.approval.diff;if(approvalID!==oldApproval){$('change').scrollIntoView({block:'start'});$('diff').focus({preventScroll:true})}}
}
$('pair-form').onsubmit=e=>{e.preventDefault();action(async()=>{await api('preview',{server:$('server').value,code:$('code').value.trim()});editingPair=false})};
$('re-pair').onclick=()=>{editingPair=true;refresh()};
$('folder').onclick=()=>action(()=>api('folder'));
$('folder-cancel').onclick=()=>action(()=>api('folder-cancel'));
$('allow').onclick=()=>action(()=>api('authorize',{root:$('root').value,edits:$('edits').checked}));
$('pause').onclick=()=>action(()=>api('pause'));
for(const [id,allow]of [['accept',true],['reject',false]])$(id).onclick=()=>action(()=>api('decision',{id:approvalID,allow}));
$('end').onclick=()=>action(async()=>{await api('end');ended=true;$('status').textContent='已结束协助，连接器正在退出。';$('pair').hidden=$('consent').hidden=$('session').hidden=$('change').hidden=true});
refresh().catch(()=>{$('error').textContent='连接器不可用，请重新打开轻量连接器。'});
setInterval(()=>{if(!ended)refresh().catch(()=>{$('status').textContent='Disconnected · 本机连接器已退出';$('change').hidden=true})},1500);
window.addEventListener('pagehide',()=>{if(!ended)fetch('/api/end',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:'{}',keepalive:true}).catch(()=>{})});
