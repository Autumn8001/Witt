#!/usr/bin/env python3
"""Upload the current working tree to the server and prepare a live Witt run.

Read-only with respect to existing services: it writes only under /root/witt-*
and starts nothing. Secrets are read on the server and never printed here.
"""

import io
import os
import posixpath
import sys
import tarfile

import paramiko

HOST = os.environ.get("WITT_SSH_HOST", "186.244.203.27")
PORT = int(os.environ.get("WITT_SSH_PORT", "28987"))
USER = os.environ.get("WITT_SSH_USER", "root")
KEY = os.environ.get("WITT_SSH_KEY", os.path.expanduser("~/.ssh/id_ed25519"))
LOCAL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REMOTE_DIR = "/root/witt-app"
ARCHIVE = "/root/witt-app.tar.gz"

EXCLUDE_DIRS = {".git", "node_modules", "__pycache__", ".gradle", "build"}
EXCLUDE_SUFFIX = (".apk", ".aab", ".jks", ".keystore")

SETUP_ENV = r"""
set -e
mkdir -p /root/.witt /root/witt-data/{chat,images,files,tasks,users,auth}
chmod 700 /root/.witt
# Gateway key for the harness child process. Read from the running CPA config.
python3 - <<'PY'
import os, re
text = open('/opt/cliproxyapi/config.yaml', encoding='utf-8', errors='replace').read()
block = text.split('api-keys:', 1)[1].split('\n\n', 1)[0]
keys = re.findall(r'(?m)^\s*-\s*"([^"]+)"', block)
key = keys[0] if keys else ''
if not key:
    raise SystemExit('no CPA api key found')
path = '/root/.witt/app.env'
with open(path, 'w', encoding='utf-8') as handle:
    handle.write('\n'.join([
        'WITT_CPA_API_KEY=%s' % key,
        'DROP_VAULT_PORT=3003',
        'DROP_VAULT_DATA_DIR=/root/witt-data/files',
        'DROP_VAULT_TASK_DIR=/root/witt-data/tasks',
        'DROP_VAULT_CHAT_DIR=/root/witt-data/chat',
        'DROP_VAULT_IMAGE_DIR=/root/witt-data/images',
        'DROP_VAULT_USERS_DIR=/root/witt-data/users',
        'DROP_VAULT_AUTH_DIR=/root/witt-data/auth',
        'DROP_VAULT_TOKEN_FILE=/root/.witt/legacy-token',
        'DROP_VAULT_CODEX_BIN=/usr/local/bin/codex',
        'DROP_VAULT_CODEX_WORKDIR=/root/witt-grok-work',
        'WITT_GROK_BIN=/root/.local/bin/grok',
        'WITT_CPA_URL=http://127.0.0.1:8317/v1',
        'WITT_SUB2API_URL=http://127.0.0.1:8080/v1',
        'OPEN_WEBUI_URL=http://186.244.203.27:3000/',
        'WITT_RUNTIME_LOG=1',
        '',
    ]))
os.chmod(path, 0o600)
print('env written')
PY
test -f /root/.witt/legacy-token || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > /root/.witt/legacy-token
chmod 600 /root/.witt/legacy-token
echo "env and token ready"
"""


def build_archive():
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        for root, dirs, files in os.walk(LOCAL_ROOT):
            dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
            for name in files:
                if name.endswith(EXCLUDE_SUFFIX):
                    continue
                full = os.path.join(root, name)
                relative = os.path.relpath(full, LOCAL_ROOT)
                tar.add(full, arcname=relative)
    buffer.seek(0)
    return buffer


def main():
    archive = build_archive()
    size = len(archive.getvalue())
    print(f"archive built: {size} bytes")

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, port=PORT, username=USER, key_filename=KEY,
                   timeout=25, allow_agent=False, look_for_keys=False)

    sftp = client.open_sftp()
    with sftp.open(ARCHIVE, "wb") as remote:
        remote.write(archive.getvalue())
    sftp.close()
    print(f"uploaded to {ARCHIVE}")

    commands = [
        f"rm -rf {REMOTE_DIR} && mkdir -p {REMOTE_DIR}",
        f"tar -xzf {ARCHIVE} -C {REMOTE_DIR}",
        f"rm -f {ARCHIVE}",
        f"ls {REMOTE_DIR} | head -20",
        SETUP_ENV,
        f"cd {REMOTE_DIR} && node --check backend/server.js && echo 'syntax ok'",
    ]
    for command in commands:
        _stdin, stdout, stderr = client.exec_command(command, timeout=180)
        out = stdout.read().decode("utf-8", "replace").strip()
        err = stderr.read().decode("utf-8", "replace").strip()
        print(f"--- {command[:60]}")
        if out:
            print(out)
        if err:
            print("[stderr]", err)
    client.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
