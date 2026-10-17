"""Opt-in real Antigravity/Chloe Web probe. Only private /tmp development state."""
import json, os, select, shlex, socket, subprocess, threading, time
from pathlib import Path
import paramiko

repo = Path(__file__).resolve().parents[1]
out = repo / ('artifacts/assist-antigravity-full' if os.environ.get('ASSIST_TEST_FULL') == '1' else 'artifacts/assist-antigravity-web')
out.mkdir(parents=True, exist_ok=True)
ssh = paramiko.SSHClient(); ssh.load_system_host_keys(); ssh.set_missing_host_key_policy(paramiko.RejectPolicy())
ssh.connect(os.environ['CHLOE_TEST_SSH_HOST'], port=int(os.environ['CHLOE_TEST_SSH_PORT']), username='root', key_filename=os.environ['CHLOE_TEST_SSH_KEY'], timeout=20)
relay_clients=[]
for _ in range(4):
    peer=paramiko.SSHClient();peer.load_system_host_keys();peer.set_missing_host_key_policy(paramiko.RejectPolicy())
    peer.connect(os.environ['CHLOE_TEST_SSH_HOST'],port=int(os.environ['CHLOE_TEST_SSH_PORT']),username='root',key_filename=os.environ['CHLOE_TEST_SSH_KEY'],timeout=20)
    relay_clients.append((peer,threading.BoundedSemaphore(8)))
def command(cmd):
    _, o, e = ssh.exec_command(cmd); result=o.read().decode(); error=e.read().decode()
    if o.channel.recv_exit_status(): raise RuntimeError(error[:1000])
    return result.strip()

stage=command('mktemp -d /tmp/chloe-agy-web-XXXXXXXX')
assert stage.startswith('/tmp/chloe-agy-web-') and '/' not in stage[5:]
sftp=ssh.open_sftp();sftp.chmod(stage,0o711)
archive=out/'source.tar';subprocess.run(['git','archive','--format=tar','-o',str(archive),'HEAD'],cwd=repo,check=True)
sftp.put(str(archive),stage+'/source.tar');command('tar -xf '+stage+'/source.tar -C '+stage)
files=subprocess.check_output(['git','ls-files','--modified','--others','--exclude-standard'],cwd=repo,text=True).splitlines()
parents=sorted({str(Path(stage+'/'+name).parent).replace('\\','/') for name in files})
command('mkdir -p -- '+' '.join(shlex.quote(p) for p in parents))
for name in files:
    target=stage+'/'+name
    sftp.put(str(repo/name),target)
command('mkdir -m 700 '+stage+'/state')
openssl='D:/Anaconda/Library/bin/openssl.exe'
subprocess.run([openssl,'req','-config','D:/Anaconda/Library/ssl/openssl.cnf','-x509','-newkey','rsa:2048','-nodes','-keyout',str(out/'key.pem'),'-out',str(out/'cert.pem'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
for local,remote in [('key.pem','tls-key.pem'),('cert.pem','tls-cert.pem')]:
    sftp.put(str(out/local),stage+'/state/'+remote);sftp.chmod(stage+'/state/'+remote,0o600)
launcher='''import os,subprocess,json
from pathlib import Path
base=Path(__file__).parent
values={}
for line in Path('/root/.witt/app.env').read_text().splitlines():
 if '=' in line and not line.startswith('#'):
  k,v=line.split('=',1);values[k]=v.strip().strip('"').strip("'")
env={k:v for k,v in os.environ.items() if k in ('PATH','LANG','LC_ALL','TMPDIR')}
env.update(HOME=str(base/'state/home'),NODE_ENV='test',NODE_PATH='/opt/witt/backend/node_modules',ASSIST_TEST_DIR=str(base/'state'),WITT_ASSIST_TEST_CLI_FACTORY=str(base/'tests/assist-antigravity-runtime.cjs'),GEMINI_API_KEY=values['GEMINI_API_KEY'],GOOGLE_GEMINI_BASE_URL='https://cpa.stellarbit.site')
(base/'state/home').mkdir(exist_ok=True)
with (base/'state/launcher.log').open('w') as log:
 p=subprocess.Popen(['node',str(base/'scripts/assist-dev-server.js')],cwd=base,env=env,stdout=log,stderr=log)
(base/'state/launcher.pid').write_text(str(p.pid))
'''
with sftp.file(stage+'/launch.py','w') as f:f.write(launcher)
command('python3 '+stage+'/launch.py')
context=None
for _ in range(200):
    try:
        with sftp.file(stage+'/state/dev-server.json') as f:context=json.load(f)
        break
    except OSError:time.sleep(.2)
if not context:raise RuntimeError(command('tail -c 2000 '+stage+'/state/launcher.log'))
with sftp.file(stage+'/state/api-token') as f:token=f.read().decode()
listener=socket.socket();listener.bind(('127.0.0.1',0));listener.listen(32);listener.settimeout(1)
stopped=threading.Event()
relay_code="import socket,os,select; s=socket.create_connection(('127.0.0.1',"+str(context['tlsPort'])+"));\nwhile True:\n r,_,_=select.select([0,s],[],[]);\n for x in r:\n  d=os.read(0,65536) if x==0 else s.recv(65536)\n  if not d: raise SystemExit()\n  if x==0:s.sendall(d)\n  else:os.write(1,d)"
def relay(conn):
    channel=None;slot=None
    try:
        for peer,available in relay_clients:
            if available.acquire(blocking=False):slot=available;break
        if slot is None:return
        channel=peer.get_transport().open_session();channel.exec_command('python3 -u -c '+shlex.quote(relay_code))
        while not stopped.is_set():
            ready,_,_=select.select([conn,channel],[],[],1)
            for source in ready:
                data=source.recv(65536)
                if not data:return
                (channel if source is conn else conn).sendall(data)
    except (OSError,EOFError,paramiko.SSHException):pass
    finally:
        conn.close()
        if channel:channel.close()
        if slot:slot.release()
def accept():
    while not stopped.is_set():
        try:conn,_=listener.accept();threading.Thread(target=relay,args=(conn,),daemon=True).start()
        except socket.timeout:pass
        except OSError:break
threading.Thread(target=accept,daemon=True).start()
private={'url':'https://127.0.0.1:'+str(listener.getsockname()[1]),'token':token,'stage':stage,'caFile':str(out/'cert.pem')}
(out/'context.json').write_text(json.dumps(private),encoding='utf8')
print('Isolated real Chloe backend ready; local TLS relay active.',flush=True)
try:
    result=subprocess.run(['node',str(repo/'tests/assist-antigravity-web.cjs')],cwd=repo,env=os.environ.copy(),timeout=1200)
    print('Windows/Web runner exit:',result.returncode,flush=True)
    # Probe the real confinement and revoked CLI socket without involving a model.
    probe=r'''const fs=require('node:fs'),p=require('node:path'),{spawnSync}=require('node:child_process');
const base=process.argv[1],d=fs.readdirSync(base).find(v=>v.startsWith('agy-cli-'));
const dir=p.join(base,d),args=JSON.parse(fs.readFileSync(p.join(dir,'container-args.json')));
const script=`const fs=require('node:fs'),{spawnSync}=require('node:child_process');
const check={host_secret_visible:fs.existsSync('/root/.witt/app.env'),other_session_visible:fs.existsSync('/opt/witt'),uid:process.getuid()};
for(const [name,argv] of Object.entries({revoked:['read','README.md'],traversal:['read','../outside/secret.txt'],selector:['read','README.md','--device','other']})){
 const r=spawnSync('/tools/chloe-remote',argv,{encoding:'utf8'});check[name]={code:r.status,stdout:r.stdout,stderr:r.stderr};}
console.log(JSON.stringify(check));`;
const r=spawnSync('docker',[...args,'/tools/node','-e',script],{encoding:'utf8'});
fs.writeFileSync(p.join(base,'isolation-results.json'),r.stdout||JSON.stringify({error:r.stderr}));
if(r.status)process.exit(r.status);'''
    command('node -e '+shlex.quote(probe)+' '+shlex.quote(stage+'/state'))
    for name in ['isolation-results.json']:
        sftp.get(stage+'/state/'+name,str(out/name))
    isolation=json.loads((out/'isolation-results.json').read_text())
    assert isolation['uid']==10001 and not isolation['host_secret_visible'] and not isolation['other_session_visible']
    assert 'WORKSPACE_NOT_ACTIVE' in isolation['revoked']['stderr'] and isolation['revoked']['code']==1
    assert 'INVALID_PATH' in isolation['traversal']['stderr'] and 'INVALID_CLI_ARGUMENTS' in isolation['selector']['stderr']
    for runtime in sftp.listdir(stage+'/state'):
        if runtime.startswith('agy-cli-'):
            for name in ['process-evidence.jsonl','native-events.jsonl']:
                try:sftp.get(stage+'/state/'+runtime+'/'+name,str(out/name))
                except OSError:pass
finally:
    for file in ['backend.log','launcher.log']:
        try:sftp.get(stage+'/state/'+file,str(out/file))
        except OSError:pass
    command('kill -TERM '+command('cat '+stage+'/state/launcher.pid'))
    # Remove only this run\'s temporary model credentials, retain evidence.
    command("find "+stage+"/state -name model.env -type f -delete")
    stopped.set();listener.close()
    for peer,_ in relay_clients:peer.close()
    ssh.close()
raise SystemExit(result.returncode)
