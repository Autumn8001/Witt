"""Opt-in real Windows + remote Linux Grok Build proof; never deploys.

Requires CHLOE_TEST_SSH_HOST, CHLOE_TEST_SSH_PORT, CHLOE_TEST_SSH_KEY,
known_hosts, existing server Docker/python image/Grok/Node and Windows fixture
binary. Uses a new /tmp directory, an SSH stdio relay and a disposable
container. Existing production processes and customer sessions are untouched.
"""
import json
import os
from pathlib import Path
import ssl
import urllib.request
import urllib.error
import subprocess
import time

import paramiko

repo = Path(__file__).resolve().parents[1]
out = repo / "artifacts/assist-cli-spike"
out.mkdir(parents=True, exist_ok=True)
context_file = out / "context.json"
context_file.unlink(missing_ok=True)
client = paramiko.SSHClient()
client.load_system_host_keys()
client.set_missing_host_key_policy(paramiko.RejectPolicy())
client.connect(os.environ["CHLOE_TEST_SSH_HOST"], port=int(os.environ["CHLOE_TEST_SSH_PORT"]),
               username=os.environ.get("CHLOE_TEST_SSH_USER", "root"),
               key_filename=os.environ["CHLOE_TEST_SSH_KEY"], timeout=15)
log = open(out / "windows.log", "w", encoding="utf-8")
fixture = subprocess.Popen(["node", str(repo / "tests/assist-cli-windows.cjs")], cwd=repo,
                           env=os.environ.copy(), stdout=log, stderr=log)
stage = None
try:
    deadline = time.monotonic() + 40
    while not context_file.exists():
        if fixture.poll() is not None or time.monotonic() > deadline:
            raise RuntimeError("Windows fixture failed; see private windows.log")
        time.sleep(.1)
    context = json.loads(context_file.read_text(encoding="utf-8"))
    _, stdout, _ = client.exec_command("mktemp -d /tmp/chloe-cli-spike-XXXXXXXX")
    stage = stdout.read().decode().strip()
    if not stage.startswith("/tmp/chloe-cli-spike-") or "/" in stage[len("/tmp/"):]:
        raise RuntimeError("Unexpected staging path")
    sftp = client.open_sftp()
    sftp.chmod(stage, 0o711)
    files = [repo / "tests/assist-cli-linux.cjs", repo / "backend/remote-assist/cli-bridge.js",
             repo / "backend/remote-workspace/validation.js", repo / "backend/cli/chloe-remote.js"]
    files += list((repo / "backend/runtime").glob("*.js"))
    for file in files:
        remote = stage + "/" + file.relative_to(repo).as_posix()
        parent = str(Path(remote).parent).replace("\\", "/")
        parts = parent.split("/")
        for at in range(3, len(parts) + 1):
            try:
                sftp.mkdir("/".join(parts[:at]), 0o755)
            except OSError:
                pass
        sftp.put(str(file), remote)
    sftp.put(context["caFile"], stage + "/cert.pem")
    remote_context = {"marker": context["marker"], "root": context["root"]}
    with sftp.file(stage + "/context.json", "w") as file:
        file.write(json.dumps(remote_context))
    sftp.chmod(stage + "/context.json", 0o600)
    stdin, stdout, stderr = client.exec_command("node " + stage + "/tests/assist-cli-linux.cjs", timeout=300)
    # The remote runner logs stable codes and status summaries only.
    for line in stdout:
        value = json.loads(line)
        if not value.get("rpc"):
            print(json.dumps(value))
            continue
        token = context["control"] if value.get("control") is True else context["secret"]
        if value.get("control") == "invalid":
            token = "not-authorized"
        request = urllib.request.Request("https://127.0.0.1:"+str(context["port"])+value["route"],
                    data=json.dumps(value.get("body") or {}).encode(),
                    headers={"Authorization":"Bearer "+token,"Content-Type":"application/json"})
        try:
            with urllib.request.urlopen(request, context=ssl.create_default_context(cafile=context["caFile"]),timeout=95) as response:
                result=json.load(response)
            answer={"id":value["id"],"result":result}
        except urllib.error.HTTPError as error:
            answer={"id":value["id"],"error":json.load(error).get("error","REMOTE_FAILED")}
        stdin.write(json.dumps(answer)+"\n");stdin.flush()
    errors = stderr.read().decode()
    code = stdout.channel.recv_exit_status()
    if errors:
        print(errors[:1500])
    for name in ["results.json", "model-events.json"]:
        try:
            sftp.get(stage + "/" + name, str(out / name))
        except OSError:
            pass
    if code:
        raise RuntimeError("Remote development probe failed: " + str(code))
    (out / "finish.json").write_text("{}", encoding="utf-8")
    fixture.wait(timeout=25)
    if fixture.returncode:
        raise RuntimeError("Windows assertions failed; see windows.log")
    print((out / "windows-results.json").read_text(encoding="utf-8"))
finally:
    if fixture.poll() is None:
        fixture.terminate()
        fixture.wait(timeout=10)
    if stage:
        # Remove only temporary credentials; retain dev evidence for inspection.
        for name in ["context.json", "model.env"]:
            try:
                client.open_sftp().remove(stage + "/" + name)
            except OSError:
                pass
    client.close()
    log.close()
