#!/usr/bin/python3
"""Real Linux policy probes, independent of model-generated claims."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import uuid

spec = importlib.util.spec_from_file_location('launcher', '/usr/local/lib/chloe-antigravity/launcher.py')
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)
a, b = uuid.uuid4().hex, uuid.uuid4().hex
results = {}

def run(scope, code, writable=True):
    root = launcher.root_for(scope)
    workspace = root / 'workspace'
    workspace.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.NamedTemporaryFile(mode='w', prefix='chloe-isolation-test-', dir='/run') as env:
        command = launcher.sandbox_command(scope, 'chloe-policy-test-' + uuid.uuid4().hex,
            str(workspace.resolve()), env.name, writable,
            ['/usr/bin/python3', '-c', code])
        result = subprocess.run(command, capture_output=True, text=True, timeout=35)
        if result.returncode:
            raise RuntimeError(result.stderr[-2000:])
        return json.loads(result.stdout)

workspace_a = str(launcher.root_for(a) / 'workspace')
workspace_b = str(launcher.root_for(b) / 'workspace')
results['customer_b_write'] = run(b, f"from pathlib import Path; import json; p=Path({workspace_b!r})/'private.txt';p.write_text('test-only'); print(json.dumps(p.read_text()=='test-only'))")
probe = r'''
from pathlib import Path
import os,json,subprocess
workspace=Path(WORKSPACE)
results={}
(workspace/'normal.txt').write_text('test-only')
results['own_workspace_write']=(workspace/'normal.txt').read_text()=='test-only'
results['non_root']=os.geteuid()!=0
for label,target in TARGETS.items():
    try:
        fd=os.open(target,os.O_WRONLY);os.close(fd)
        results[label]=False
    except OSError:results[label]=True
try:
    Path(OTHER).read_text();results['other_customer_read_denied']=False
except OSError:results['other_customer_read_denied']=True
link=workspace/'escape'
link.symlink_to('/home/agytest/.gemini/antigravity-cli/scratch/GEMINI.md')
try:
    fd=os.open(link,os.O_WRONLY);os.close(fd);results['symlink_escape_denied']=False
except OSError:results['symlink_escape_denied']=True
status=Path('/proc/self/status').read_text()
results['no_new_privileges']='NoNewPrivs:\t1' in status
results['capabilities_empty']='CapEff:\t0000000000000000' in status
attempt=subprocess.run(['/usr/bin/python3','/usr/local/lib/chloe-antigravity/launcher.py','--version'],
    env={**os.environ,'CHLOE_AGY_ADMIN_EXECUTION':'1'},capture_output=True,timeout=10)
results['forged_admin_marker_denied']=attempt.returncode==126
print(json.dumps(results))
'''
targets = {
    'shared_identity_write_denied':'/home/agytest/.gemini/antigravity-cli/scratch/GEMINI.md',
    'launcher_write_denied':'/usr/local/lib/chloe-antigravity/launcher.py',
    'server_code_write_denied':'/opt/witt/backend/server.js',
}
code = probe.replace('WORKSPACE', repr(workspace_a)).replace('TARGETS', repr(targets)).replace('OTHER', repr(workspace_b + '/private.txt'))
results.update(run(a, code))
readonly = f"import os,json; p={workspace_a!r}+'/normal.txt'\ntry:\n f=os.open(p,os.O_WRONLY);os.close(f);ok=False\nexcept OSError:ok=True\nprint(json.dumps(ok))"
results['read_only_workspace_enforced'] = run(a, readonly, False)
try:
    launcher.sandbox_command(a,'invalid','/opt/witt','/dev/null')
    results['arbitrary_workspace_denied']=False
except ValueError:
    results['arbitrary_workspace_denied']=True
results['admin_still_root']=os.geteuid()==0
results['admin_shared_identity_writable']=os.access(targets['shared_identity_write_denied'],os.W_OK)
print(json.dumps({'results':results,'all_pass':all(results.values()),'test_scopes':[a,b]},indent=2))
raise SystemExit(0 if all(results.values()) else 1)
