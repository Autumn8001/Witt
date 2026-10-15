"""Run an isolated server fixture and an SSH tunnel; never touch production config.

Requires developer Python/Paramiko only. The shipped Assist exe has no such dependency.
Create artifacts/assist-e2e/stop to tear down this fixture and its own backend.
"""
import argparse, json, os, pathlib, shlex, socket, subprocess, tarfile, threading, time
import paramiko

p = argparse.ArgumentParser()
p.add_argument('--host', required=True); p.add_argument('--port', type=int, default=22)
p.add_argument('--key', required=True); p.add_argument('--grok-upstream', default=''); args = p.parse_args()
repo = pathlib.Path(__file__).resolve().parents[1]
out = repo / 'artifacts' / 'assist-e2e'; out.mkdir(parents=True, exist_ok=True)
(out / 'stop').unlink(missing_ok=True)
c = paramiko.SSHClient(); c.load_system_host_keys()
# The caller must already trust this host in known_hosts; do not silently trust it.
c.set_missing_host_key_policy(paramiko.RejectPolicy())
c.connect(args.host, port=args.port, username='root', key_filename=args.key)
def remote(command, stdin=None):
    i, o, e = c.exec_command(command)
    if stdin is not None: i.write(stdin); i.channel.shutdown_write()
    result = o.read().decode(); error = e.read().decode()
    if o.channel.recv_exit_status() != 0: raise RuntimeError(error or result)
    return result
stage = remote('mktemp -d /tmp/chloe-assist-dev-XXXXXXXX').strip()
sftp = c.open_sftp()
files = subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard','-z'],cwd=repo).decode().split('\0')
archive = out / 'source.tar.gz'
with tarfile.open(archive,'w:gz') as tar:
    for name in files:
        if name and (name.startswith(('backend/','web/','scripts/'))): tar.add(repo/name,arcname=name)
sftp.put(str(archive),stage+'/source.tar.gz')
boot = r'''
import os,json,tomllib,subprocess,pathlib
stage=pathlib.Path(STAGE)
subprocess.run(['tar','xzf',str(stage/'source.tar.gz'),'-C',str(stage)],check=True)
state=stage/'state';state.mkdir(mode=0o700)
subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(state/'tls-key.pem'),'-out',str(state/'tls-cert.pem'),'-days','2','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True)
pid=os.popen('systemctl show witt.service -p MainPID --value').read().strip()
production=dict(x.split('=',1) for x in open('/proc/'+pid+'/environ').read().split('\0') if '=' in x)
env={k:v for k,v in os.environ.items() if k in ['PATH','LANG','SYSTEMROOT','SHELL']}
env.update({k:v for k,v in production.items() if k in ['WITT_CPA_API_KEY','WITT_GROK_BIN','WITT_CPA_URL']})
home=state/'home';(home/'.grok').mkdir(parents=True,mode=0o700)
original=tomllib.load(open('/root/.grok/config.toml','rb'));lines=[]
upstream=UPSTREAM
if upstream:
 original['model']['grok-4.7-high']['model']=upstream
 original['model']['grok-4.7-high']['name']='Assist test upstream '+upstream
def emit(parts,obj):
 scalars={k:v for k,v in obj.items() if not isinstance(v,dict)}
 if parts:lines.append('['+'.'.join(json.dumps(p) for p in parts)+']')
 for k,v in scalars.items():lines.append(json.dumps(k)+' = '+json.dumps(v,ensure_ascii=False))
 lines.append('')
 for k,v in obj.items():
  if isinstance(v,dict):emit(parts+[k],v)
for key in ['model_providers','model']:
 if key in original:emit([key],original[key])
(home/'.grok'/'config.toml').write_text('\n'.join(lines))
env.update({'HOME':str(home),'USER':'root','ASSIST_TEST_DIR':str(state),'NODE_PATH':'/opt/witt/backend/node_modules','PATH':'/root/.local/bin:/usr/local/bin:/usr/bin:/bin'})
log=open(state/'fixture.log','ab')
proc=subprocess.Popen(['node',str(stage/'scripts/assist-dev-server.js')],cwd=stage,env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
print(proc.pid)
'''.replace('STAGE', repr(stage)).replace('UPSTREAM', repr(args.grok_upstream))
remote('python3 -', boot)
metadata = None
for _ in range(100):
    try:
        with sftp.open(stage+'/state/dev-server.json') as f: metadata=json.load(f)
        break
    except OSError: time.sleep(.2)
if metadata is None: raise RuntimeError('isolated fixture failed; inspect '+stage+'/state/fixture.log')
sftp.get(stage+'/state/tls-cert.pem',str(out/'tls-cert.pem'))
sftp.get(stage+'/state/api-token',str(out/'operator-token'))
listener=socket.socket();listener.bind(('127.0.0.1',0));listener.listen(10);listener.settimeout(1)
port=listener.getsockname()[1]
def forward(sock):
    channel=None
    try:
        channel=c.get_transport().open_channel('direct-tcpip',('127.0.0.1',metadata['tlsPort']),sock.getpeername())
        def pump(source,target):
            try:
                while True:
                    data=source.recv(65536)
                    if not data:break
                    target.sendall(data)
            except OSError:pass
            finally:source.close();target.close()
        threading.Thread(target=pump,args=(channel,sock),daemon=True).start();pump(sock,channel)
    finally:
        sock.close()
        if channel:channel.close()
context={**metadata,'server':f'https://localhost:{port}/vault-api','stage':stage,'caFile':str(out/'tls-cert.pem'),'operatorTokenFile':str(out/'operator-token'),'grokTestUpstream':args.grok_upstream or 'grok-4.7-high'}
(out/'context.json').write_text(json.dumps(context),encoding='utf8')
print(json.dumps({'server':context['server'],'stage':stage,'pid':metadata['pid']}),flush=True)
try:
    while not (out/'stop').exists():
        try: sock,_=listener.accept()
        except socket.timeout:continue
        threading.Thread(target=forward,args=(sock,),daemon=True).start()
finally:
    listener.close()
    # Verify exact fixture identity before terminating only our process group.
    cleanup=f"import os,signal; p={metadata['pid']}; cmd=open('/proc/'+str(p)+'/cmdline').read(); assert {stage!r} in cmd and 'assist-dev-server.js' in cmd; os.kill(p,signal.SIGTERM)"
    remote('python3 -',cleanup)
    c.close()
