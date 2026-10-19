"use strict";
// The browser fragment is never sent in HTTP requests or to the gateway.
const token=location.hash.slice(1);history.replaceState(null,"",location.pathname);
const $=id=>document.getElementById(id);let approvalID="",busy=false,ended=false,editingPair=false,lastRoot=null,accessMode="workspace";
const defaultTitle=document.title;
function closeApproval(){if($('change').open)$('change').close();document.title=defaultTitle;approvalID=''}
async function api(route,body={}){
 const r=await fetch('/api/'+route,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(body),cache:'no-store'});
 const data=await r.json();if(!r.ok)throw Error(data.error||'请求失败');return data;
}
async function action(fn){if(busy)return;busy=true;$('error').textContent='';document.querySelectorAll('button').forEach(b=>b.disabled=true);try{await fn();await refresh()}catch(e){$('error').textContent=e.message}finally{busy=false;document.querySelectorAll('button').forEach(b=>b.disabled=false);refresh().catch(()=>{})}}
async function refresh(){
 if(ended)return;const s=await api('status');
 const labels={unpaired:'尚未授权 · 本机文件不可访问',preview:'等待你的授权 · 本机文件不可访问',updating:'正在更新，连接器将重新打开',connecting:'正在建立加密连接',connected:'Connected · 已连接',paused:'Paused · 已暂停',disconnected:'Disconnected · 已断开'};
 $('status').textContent=labels[s.state]||s.state;
 accessMode=s.access_mode||'workspace';const full=accessMode==='full';$('limited-options').hidden=full;$('full-consent').hidden=!full;$('allow').textContent=full?'允许本次完整访问并连接':'允许并连接';$('root-label').textContent=full?'默认工作目录（可访问其他本地目录）':'允许访问的目录';
 const u=s.update||{};$('app-version').textContent=u.version||'';$('update-status').textContent=u.message||'更新不可用';$('auto-update').checked=!!u.auto;$('auto-update').disabled=!u.enabled||busy;$('update-check').disabled=!u.enabled||u.checking||busy;$('update-install').hidden=!u.ready;$('update-install').disabled=busy||s.state!=='unpaired'||s.folder_pending||u.checking;
 if(u.ready&&s.state!=='unpaired')$('update-status').textContent+=' · 请结束协助后重新打开连接器安装';
 const before=['unpaired','preview'].includes(s.state);$('pair').hidden=s.state!=='unpaired'&&!editingPair;$('consent').hidden=s.state!=='preview'||editingPair;$('session').hidden=before;
 if(!$('server').value)$('server').value=s.server;if(!$('code').value)$('code').value=s.code;
 if(s.root!==lastRoot){if(s.root)$('root').value=s.root;lastRoot=s.root}
 $('folder').disabled=busy||s.folder_pending;$('folder-cancel').hidden=!s.folder_pending;
 $('folder-status').textContent=s.folder_pending?'Windows 目录选择窗口已打开，请查看任务栏或按 Alt＋Tab 切换。也可取消后直接粘贴目录路径。':s.folder_error||'';
 $('service').textContent=s.server;$('operator').textContent=s.operator;$('expires').textContent=s.expires?new Date(s.expires).toLocaleString():'';
 $('edits').disabled=!s.capabilities?.includes('workspace.write');
 $('environment').disabled=!s.capabilities?.includes('workspace.system_info');
 $('commands').disabled=!s.capabilities?.includes('workspace.exec');
 $('scope').textContent=full?`本次完整访问 · 所有本地目录及命令，无逐条审批 · 默认工作目录：${s.root} · 到期：${s.expires?new Date(s.expires).toLocaleString():''}`:`授权目录：${s.root} · 服务方：${s.operator} · 到期：${s.expires?new Date(s.expires).toLocaleString():''} · 设备信息：${s.capabilities?.includes('workspace.system_info')?'已授权':'未授权'} · 命令执行：${s.capabilities?.includes('workspace.exec')?'已授权，逐条确认':'未授权'}`;
 $('pause').textContent=s.state==='paused'?'恢复协助':'暂停协助';$('logs').textContent=s.logs.join('\n')||'暂无操作。';
 const oldApproval=approvalID;approvalID=s.approval?.id||'';
 if(s.approval){$('file').textContent=s.approval.file;$('diff').textContent=s.approval.diff;
  const seconds=Math.max(0,Math.ceil((s.approval.expires_at-Date.now())/1000));
  $('approval-time').textContent=`等待你的确认 · 剩余 ${seconds} 秒。未确认不会执行；拒绝、暂停或超时均取消。`;
  document.title='待确认操作 · Chloe Assist';
  if(!$('change').open)$('change').showModal();
  if(approvalID!==oldApproval)$('diff').focus({preventScroll:true});
 }else{closeApproval()}
}
$('pair-form').onsubmit=e=>{e.preventDefault();action(async()=>{await api('preview',{server:$('server').value,code:$('code').value.trim()});editingPair=false})};
$('re-pair').onclick=()=>{editingPair=true;refresh()};
$('folder').onclick=()=>action(()=>api('folder'));
$('folder-cancel').onclick=()=>action(()=>api('folder-cancel'));
$('allow').onclick=()=>action(()=>api('authorize',{access_mode:accessMode,root:$('root').value,edits:$('edits').checked,environment:$('environment').checked,commands:$('commands').checked}));
$('pause').onclick=()=>action(()=>api('pause'));
for(const [id,allow]of [['accept',true],['reject',false]])$(id).onclick=()=>action(()=>api('decision',{id:approvalID,allow}));
$('change').addEventListener('cancel',e=>{e.preventDefault();$('reject').click()});
$('end').onclick=()=>action(async()=>{await api('end');ended=true;closeApproval();$('status').textContent='已结束协助，连接器正在退出。';$('pair').hidden=$('consent').hidden=$('session').hidden=true});
refresh().catch(()=>{$('error').textContent='连接器不可用，请重新打开轻量连接器。'});
setInterval(()=>{if(!ended)refresh().catch(()=>{$('status').textContent='Disconnected · 本机连接器已退出';closeApproval()})},1500);
window.addEventListener('pagehide',()=>{if(!ended)fetch('/api/end',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:'{}',keepalive:true}).catch(()=>{})});

$('update-check').onclick=()=>action(()=>api('update/check'));
$('auto-update').onchange=()=>action(()=>api('update/settings',{auto:$('auto-update').checked}));
$('update-install').onclick=()=>action(async()=>{await api('update/install');ended=true;$('status').textContent='更新已开始，新版本将自动打开。此页面可以关闭。';document.querySelectorAll('section').forEach(s=>s.hidden=true)});

let activityTimer;
for(const id of ['code','server','root'])$(id).addEventListener('input',()=>{clearTimeout(activityTimer);activityTimer=setTimeout(()=>api('activity',{editing_pair:!!$('code').value.trim()}).catch(()=>{}),250)});
