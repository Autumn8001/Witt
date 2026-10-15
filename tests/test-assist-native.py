"""Native Windows acceptance against the isolated assist-test-environment.

Automates visible authorization and diff dialogs ONLY for the dedicated test
directory created here. No headless consent bypass is built into Assist.
"""
import argparse, ctypes, sys, json, os, pathlib, secrets, ssl, subprocess, time, urllib.request, urllib.error
from ctypes import wintypes
from PIL import Image, ImageGrab
import paramiko

parser=argparse.ArgumentParser();parser.add_argument('--expiry-only',action='store_true');parser.add_argument('--ssh-host',required=True);parser.add_argument('--ssh-port',type=int,default=22);parser.add_argument('--ssh-key',required=True);args=parser.parse_args()
repo=pathlib.Path(__file__).resolve().parents[1];out=repo/'artifacts'/'assist-e2e'
context=json.loads((out/'context.json').read_text());base=context['server'];token=pathlib.Path(context['operatorTokenFile']).read_text().strip()
tls=ssl.create_default_context(cafile=context['caFile'])
user=ctypes.WinDLL('user32',use_last_error=True)
user.SendMessageW.restype=ctypes.c_ssize_t;user.SendMessageW.argtypes=[wintypes.HWND,wintypes.UINT,wintypes.WPARAM,wintypes.LPARAM]
user.GetDlgItem.restype=wintypes.HWND;user.GetDlgItem.argtypes=[wintypes.HWND,ctypes.c_int]
user.PostMessageW.argtypes=[wintypes.HWND,wintypes.UINT,wintypes.WPARAM,wintypes.LPARAM]
user.GetWindowThreadProcessId.argtypes=[wintypes.HWND,ctypes.POINTER(wintypes.DWORD)]
user.IsWindowEnabled.argtypes=[wintypes.HWND];user.GetWindowRect.argtypes=[wintypes.HWND,ctypes.POINTER(wintypes.RECT)]
def api(route,body=None):
 data=None if body is None else json.dumps(body).encode()
 req=urllib.request.Request(base+route,data=data,headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
 with urllib.request.urlopen(req,context=tls,timeout=20) as r:return json.load(r)
def wait(fn,seconds=30):
 until=time.monotonic()+seconds
 while time.monotonic()<until:
  result=fn()
  if result:return result
  time.sleep(.2)
 raise AssertionError('timed out waiting for native/API state')
def windows(pid):
 result=[]
 @ctypes.WINFUNCTYPE(wintypes.BOOL,wintypes.HWND,wintypes.LPARAM)
 def callback(hwnd,param):
  owner=wintypes.DWORD();user.GetWindowThreadProcessId(hwnd,ctypes.byref(owner))
  if owner.value==pid:
   title=ctypes.create_unicode_buffer(512);user.GetWindowTextW(hwnd,title,512);result.append((hwnd,title.value))
  return True
 user.EnumWindows(callback,0);return result
def click(hwnd,control):
 child=user.GetDlgItem(hwnd,control);assert child,'native control missing '+str(control)
 assert user.IsWindowEnabled(child),'native control disabled '+str(control)
 user.PostMessageW(hwnd,0x111,control,child)
def screenshot(hwnd,name):
 r=wintypes.RECT();user.GetWindowRect(hwnd,ctypes.byref(r));width,height=r.right-r.left,r.bottom-r.top
 gdi=ctypes.WinDLL('gdi32');gdi.CreateCompatibleDC.restype=wintypes.HDC;gdi.CreateCompatibleDC.argtypes=[wintypes.HDC]
 gdi.CreateCompatibleBitmap.restype=wintypes.HBITMAP;gdi.CreateCompatibleBitmap.argtypes=[wintypes.HDC,ctypes.c_int,ctypes.c_int]
 gdi.SelectObject.restype=wintypes.HGDIOBJ;gdi.SelectObject.argtypes=[wintypes.HDC,wintypes.HGDIOBJ]
 user.GetDC.restype=wintypes.HDC;user.GetDC.argtypes=[wintypes.HWND]
 user.PrintWindow.argtypes=[wintypes.HWND,wintypes.HDC,wintypes.UINT]
 gdi.GetDIBits.argtypes=[wintypes.HDC,wintypes.HBITMAP,wintypes.UINT,wintypes.UINT,ctypes.c_void_p,ctypes.c_void_p,wintypes.UINT]
 gdi.DeleteObject.argtypes=[wintypes.HGDIOBJ];gdi.DeleteDC.argtypes=[wintypes.HDC];user.ReleaseDC.argtypes=[wintypes.HWND,wintypes.HDC]
 screen=user.GetDC(None);dc=gdi.CreateCompatibleDC(screen);bitmap=gdi.CreateCompatibleBitmap(screen,width,height);old=gdi.SelectObject(dc,bitmap)
 try:
  assert user.PrintWindow(hwnd,dc,2),'PrintWindow failed'
  import struct
  header=ctypes.create_string_buffer(struct.pack('<IiiHHIIiiII',40,width,-height,1,32,0,width*height*4,0,0,0,0)+bytes(16))
  data=ctypes.create_string_buffer(width*height*4)
  gdi.GetDIBits(dc,bitmap,0,height,data,header,0)
  Image.frombuffer('RGB',(width,height),data.raw,'raw','BGRX',0,1).save(out/name)
 finally:gdi.SelectObject(dc,old);gdi.DeleteObject(bitmap);gdi.DeleteDC(dc);user.ReleaseDC(None,screen)
def session(sid):return next(s for s in api('/remote-assist/sessions')['sessions'] if s['assist_session_id']==sid)
ssh=paramiko.SSHClient();ssh.load_system_host_keys();ssh.connect(args.ssh_host,port=args.ssh_port,username='root',key_filename=args.ssh_key)
def remote_mcp(sid,operation,arguments):
 # The ephemeral fixture credential stays on its server; never print or return it.
 script="""const fs=require('node:fs');(async()=>{const secret=fs.readFileSync(FILE,'utf8').trim();const r=await fetch('http://127.0.0.1:PORT/internal/remote-workspaces/mcp',{method:'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:JSON.stringify(INPUT)});const b=await r.json();console.log(JSON.stringify({http:r.status,error:b.error,result:b.result}));})().catch(e=>{console.error(e.message);process.exitCode=1});"""
 file=context['stage']+'/state/remote-workspaces/runtime/'+sid+'/mcp-session-token'
 script=script.replace('FILE',json.dumps(file)).replace('PORT',str(context['backendPort'])).replace('INPUT',json.dumps({'operation':operation,'args':arguments}))
 i,o,e=ssh.exec_command('node -');i.write(script);i.channel.shutdown_write();data=o.read().decode();error=e.read().decode();assert o.channel.recv_exit_status()==0,error
 return json.loads(data)
def send(cid,text):
 r=api('/chat/conversations/'+cid+'/messages',{'text':text,'attachmentIds':[],'clientRequestId':secrets.token_hex(16)})
 return r['messageId']
def reply(cid,mid):
 r=api('/chat/conversations/'+cid);conv=r.get('conversation',r)
 return next((m for m in conv.get('messages',[]) if m.get('role')=='assistant' and m.get('replyTo')==mid and m.get('status') not in ['queued','running']),None)

result={};proc=None;sid=None
try:
 root=out/'workspace';root.mkdir(exist_ok=True);sample=root/'verification.txt'
 marker='assist-test-'+secrets.token_hex(8);sample.write_text(marker+'\n',encoding='utf8')
 outside=out/'outside-sentinel.txt';outside.write_text('outside must remain unchanged',encoding='utf8')
 invite=api('/remote-assist/sessions',{'customer_label':'Windows 原生验收','ttl_minutes':1 if args.expiry_only else 15,'allow_edits':True});sid=invite['assist_session_id']
 (out/'test-session.json').write_text(json.dumps({'sessionId':sid,'marker':marker,'root':str(root)}),encoding='utf8')
 assert session(sid)['state']=='pending' and not session(sid)['connected'];result['before_authorization']='PASS: no device or workspace bound'
 proc=subprocess.Popen([str(repo/'artifacts/chloe-assist.exe'),'join',invite['pairing_code'],'--native','--server',base,'--root',str(root),'--ca-file',context['caFile']])
 hwnd=wait(lambda:next((h for h,t in windows(proc.pid) if t=='Chloe Assist · 临时远程协助'),None))
 click(hwnd,101);wait(lambda:user.IsWindowEnabled(user.GetDlgItem(hwnd,102)))
 assert session(sid)['state']=='pending';screenshot(hwnd,'native-consent.png')
 user.SendMessageW(user.GetDlgItem(hwnd,14),0xf1,1,0) # customer opts into per-edit confirmation
 click(hwnd,102);wait(lambda:session(sid)['connected'])
 result['native_authorization']='PASS: visible native consent, scoped WSS connection'
 screenshot(hwnd,'native-connected.png')
 bound=api('/remote-assist/sessions/'+sid+'/workspace',{'model':'grok-4.7-high'});cid=bound['conversation']['id']
 if args.expiry_only:
  print('Waiting for the one-minute grant to expire on both Windows and Gateway',flush=True)
  wait(lambda:proc.poll() is not None,80)
  assert session(sid)['state']=='expired' and not session(sid)['connected']
  result['automatic_expiry']='PASS: Windows exited and Gateway expired the grant without operator intervention'
  print(json.dumps(result,ensure_ascii=False),flush=True);sys.exit(0)
 print('Native authorized; starting real Grok read',flush=True)
 mid=send(cid,'请通过 witt_remote_workspace MCP 的 workspace_read 读取 verification.txt，原样报告其中的唯一校验字符串。必须真正调用远程 MCP，禁止使用服务器本地文件工具；本轮只读。')
 answer=wait(lambda:reply(cid,mid),180)
 (out/'grok-read-result.json').write_text(json.dumps(answer,ensure_ascii=False,indent=2),encoding='utf8')
 audit=api('/remote-assist/sessions/'+sid+'/audit')['audit']
 assert answer['status']=='completed' and marker in answer['text'],answer.get('text')
 assert any(a['operation']=='workspace.read' and a['status']=='completed' for a in audit),'Grok did not really call remote read'
 result['grok_mcp_read']='PASS: real Grok -> MCP -> Gateway -> Windows -> unique file marker'
 print('Grok read passed; checking scope and native diff approval',flush=True)
 assert remote_mcp(sid,'workspace.read',{'path':'../outside-sentinel.txt'})['http']!=200
 assert remote_mcp(sid,'workspace.read',{'path':str(outside)})['http']!=200
 assert remote_mcp(sid,'workspace.exec',{'program':'powershell','argv':['-Command','echo forbidden']})['http']!=200
 after=marker+'-edited'
 mid=send(cid,f'请通过远程 MCP 读取 verification.txt 的 SHA-256，然后将其中的 {marker} 替换为 {after}。仅修改这个文件，使用 workspace_patch，等待客户窗口确认差异。禁止使用服务器本地文件工具。')
 dialog=wait(lambda:next((h for h,t in windows(proc.pid) if '确认文件修改' in t),None),180)
 assert sample.read_text(encoding='utf8')==marker+'\n','modified before customer approval'
 screenshot(dialog,'native-diff-approval.png');click(dialog,201)
 answer=wait(lambda:reply(cid,mid),180)
 (out/'grok-edit-result.json').write_text(json.dumps(answer,ensure_ascii=False,indent=2),encoding='utf8')
 assert answer['status']=='completed',answer.get('text')
 assert sample.read_text(encoding='utf8')==after+'\n'
 audit=api('/remote-assist/sessions/'+sid+'/audit')['audit']
 assert any(a['operation']=='workspace.patch' and a.get('change',{}).get('diff') and a['status']=='completed' for a in audit)
 assert outside.read_text(encoding='utf8')=='outside must remain unchanged'
 (out/'audit.json').write_text(json.dumps(audit,ensure_ascii=False,indent=2),encoding='utf8')
 result['grok_edit_and_diff']='PASS: Grok patch, unchanged before client confirmation, actual diff recorded'
 click(hwnd,103);wait(lambda:session(sid)['state']=='paused')
 assert remote_mcp(sid,'workspace.read',{'path':'verification.txt'})['http']!=200
 result['pause']='PASS: new MCP reads refused after client pause'
 time.sleep(.5);wait(lambda:user.IsWindowEnabled(user.GetDlgItem(hwnd,103)));click(hwnd,103);wait(lambda:session(sid)['connected'] and session(sid)['state']=='active')
 assert remote_mcp(sid,'workspace.read',{'path':'verification.txt'})['http']==200
 result['explicit_resume']='PASS'
 click(hwnd,105);proc.wait(timeout=15);wait(lambda:session(sid)['state']=='revoked')
 assert remote_mcp(sid,'workspace.read',{'path':'verification.txt'})['http']!=200
 result['revoke_and_exit']='PASS: native exe exited; previous MCP credential refused'
 result['scope']='PASS: traversal, outside absolute paths, Shell denied; outside sentinel unchanged'
 print(json.dumps(result,ensure_ascii=False),flush=True)
except Exception as e:
 result['failure']=str(e);raise
finally:
 if proc and proc.poll() is None:
  for h,t in windows(proc.pid):
   if t=='Chloe Assist · 临时远程协助':user.PostMessageW(h,0x10,0,0)
  try:proc.wait(timeout=15)
  except subprocess.TimeoutExpired:proc.terminate()
 if sid:
  try:
   if session(sid)['state'] not in ['revoked','expired']:api('/remote-assist/sessions/'+sid+'/revoke',{})
  except Exception:pass
 ssh.close();(out/('expiry-results.json' if args.expiry_only else 'native-results.json')).write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8')
