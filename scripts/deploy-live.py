#!/usr/bin/env python3
"""Upload the working tree to the server and switch the deployment over safely.

Safety properties:
  * Only an explicit whitelist of remote paths may be created, moved or removed.
  * The live deployment directory is never deleted in place.
  * Moving the old release aside and publishing the new one are SEPARATE steps,
    each with its own exit-code check, so a partial swap is always distinguishable
    and always recoverable.
  * Recovery decisions are made by reading the real state of the target, rollback
    and staging directories - never from a local boolean.
  * A restore is only reported as done after the restore itself was verified.
  * Nothing is auto-pruned: rollback directories accumulate for the operator.

The deployment logic lives in `Deployer` and talks to a remote through a small
interface, so the failure paths can be exercised with a fake remote in tests.

Secrets are read on the server and never printed here.
"""

import io
import os
import re
import sys
import tarfile
import uuid
from datetime import datetime, timezone

TARGET = "/root/witt-app"
ALLOWED_TARGETS = (TARGET,)
# Derived directories: exact shape only. The random component means two runs in the
# same second can never collide.
DERIVED = re.compile(r"^/root/witt-app\.(new|prev|failed)-\d{8}T\d{6}Z-[0-9a-f]{8}$")
# The generated archive name and the validator MUST agree exactly.
ARCHIVE_TOKEN_LEN = 32
ARCHIVE_RE = re.compile(r"^/root/witt-upload-[0-9a-f]{%d}\.tar\.gz$" % ARCHIVE_TOKEN_LEN)
SAFE_CHARS = re.compile(r"^/[A-Za-z0-9._/-]+$")

EXCLUDE_DIRS = {".git", "node_modules", "__pycache__", ".gradle", "build"}
EXCLUDE_SUFFIX = (".apk", ".aab", ".jks", ".keystore")

EXIT_OK = 0
EXIT_STAGING_FAILED = 1
EXIT_SWAP_FAILED = 2
EXIT_TRANSPORT_FAILED = 3

SETUP_ENV = r"""
set -e
mkdir -p /root/.witt /root/witt-data/{chat,images,files,tasks,users,auth}
chmod 700 /root/.witt
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


class StepFailed(Exception):
    def __init__(self, label, code=1, stderr=""):
        super().__init__(f"step '{label}' exited {code}")
        self.label = label
        self.code = code
        self.stderr = stderr


def utc_stamp():
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def make_archive_path(token=None):
    """The single source of truth for the upload archive path."""
    token = uuid.uuid4().hex if token is None else str(token)
    return f"/root/witt-upload-{token}.tar.gz"


def make_release_suffix(stamp=None, token=None):
    stamp = utc_stamp() if stamp is None else str(stamp)
    token = uuid.uuid4().hex[:8] if token is None else str(token)[:8]
    return f"{stamp}-{token}"


def require_safe(path, allow_derived=False):
    if not isinstance(path, str) or not SAFE_CHARS.match(path) or ".." in path.split("/"):
        raise SystemExit(f"refusing unsafe path: {path!r}")
    if path in ALLOWED_TARGETS:
        return path
    if allow_derived and DERIVED.match(path):
        return path
    raise SystemExit(f"refusing path outside the whitelist: {path!r}")


def require_safe_archive(path):
    if not isinstance(path, str) or not ARCHIVE_RE.match(path):
        raise SystemExit(f"refusing unsafe archive path: {path!r}")
    return path


def build_archive(root):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        for base, dirs, files in os.walk(root):
            dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
            for name in files:
                if name.endswith(EXCLUDE_SUFFIX):
                    continue
                full = os.path.join(base, name)
                tar.add(full, arcname=os.path.relpath(full, root))
    buffer.seek(0)
    return buffer.getvalue()


class SshRemote:
    """Thin, mockable wrapper over the operations a deployment needs."""

    def __init__(self, client):
        self.client = client

    def run(self, command, timeout=300):
        _stdin, stdout, stderr = self.client.exec_command(command, timeout=timeout)
        out = stdout.read().decode("utf-8", "replace")
        err = stderr.read().decode("utf-8", "replace")
        code = stdout.channel.recv_exit_status()
        return code, out.strip(), err.strip()

    def exists(self, flag, path):
        code, _out, _err = self.run(f"test {flag} {path}", timeout=60)
        return code == 0

    def upload(self, data, archive):
        sftp = self.client.open_sftp()
        try:
            with sftp.open(archive, "wb") as handle:
                handle.write(data)
        finally:
            sftp.close()

    def make_dir(self, path):
        code, _out, err = self.run(f"mkdir -p {path}")
        return code, err

    def extract(self, archive, dest):
        code, _out, err = self.run(f"tar -xzf {archive} -C {dest}")
        return code, err

    def move(self, src, dst):
        code, _out, err = self.run(f"mv {src} {dst}", timeout=120)
        return code, err

    def remove_tree(self, path):
        code, _out, err = self.run(f"rm -rf {path}", timeout=120)
        return code, err

    def remove_file(self, path):
        code, _out, err = self.run(f"rm -f {path}", timeout=60)
        return code, err

    def syntax_check(self, app_dir):
        code, _out, _err = self.run(
            f"cd {app_dir} && test -f backend/server.js && node --check backend/server.js")
        return code == 0

    def provision_env(self):
        code, out, err = self.run(SETUP_ENV, timeout=180)
        return code, (err or out)


class Deployer:
    """Orchestrates one deployment. All remote state is read, never assumed."""

    def __init__(self, remote, payload, target=TARGET, archive=None,
                 stamp=None, token=None, log=print):
        self.remote = remote
        self.payload = payload
        self.log = log
        self.target = target
        self.suffix = make_release_suffix(stamp, token)
        self.staging = f"{target}.new-{self.suffix}"
        self.rollback = f"{target}.prev-{self.suffix}"
        self.failed = f"{target}.failed-{self.suffix}"
        self.archive = archive or make_archive_path()
        self.report = []
        self.status = "not-started"

        require_safe(self.target)
        require_safe(self.staging, allow_derived=True)
        require_safe(self.rollback, allow_derived=True)
        require_safe(self.failed, allow_derived=True)
        require_safe_archive(self.archive)

    def note(self, message):
        self.report.append(message)
        self.log(message)

    def state(self):
        return {
            "target": self.remote.exists("-d", self.target),
            "rollback": self.remote.exists("-d", self.rollback),
            "staging": self.remote.exists("-d", self.staging),
            "failed": self.remote.exists("-d", self.failed),
        }

    def require(self, label, code, err=""):
        if code != 0:
            raise StepFailed(label, code, err)

    def recover(self):
        """Restore the previous release. The decision is made from real state.

        Returns (status, state_before_recovery, state_after_recovery).
        """
        before = self.state()
        self.note(f"post-failure state: {before}")
        # No previous release was moved aside.
        if not before["rollback"]:
            if before["target"]:
                return "live-untouched", before, before
            return "nothing-to-restore", before, before
        # The old release was moved aside, so it must be put back.
        if before["target"]:
            code, err = self.remote.move(self.target, self.failed)
            if code != 0:
                self.note(f"could not set the failed release aside: {err}")
                return "restore-failed", before, self.state()
        code, err = self.remote.move(self.rollback, self.target)
        if code != 0:
            self.note(f"could not move the previous release back: {err}")
            return "restore-failed", before, self.state()
        if not self.remote.syntax_check(self.target):
            return "restore-unverified", before, self.state()
        return "restored", before, self.state()

    def deploy(self):
        try:
            self.remote.upload(self.payload, self.archive)
            self.note(f"uploaded {self.archive}")
            self.require("create staging", *self.remote.make_dir(self.staging))
            self.require("extract staging", *self.remote.extract(self.archive, self.staging))
            if not self.remote.exists("-f", f"{self.staging}/backend/server.js"):
                raise StepFailed("staging content", 1, "backend/server.js missing")
            if not self.remote.syntax_check(self.staging):
                raise StepFailed("syntax check staged", 1)

            # Swap step 1: move the old release aside. Its own exit code is checked,
            # so a failure here is distinguishable from a failed publish.
            if self.remote.exists("-d", self.target):
                self.require("move old release aside", *self.remote.move(self.target, self.rollback))
            else:
                self.note("no previous release present (first deployment)")

            # Swap step 2: publish the new release. Checked independently.
            self.require("publish new release", *self.remote.move(self.staging, self.target))

            if not self.remote.syntax_check(self.target):
                raise StepFailed("verify live", 1)
            self.require("provision env", *self.remote.provision_env())
        except StepFailed as error:
            self.note(f"FAILED: {error}")
            status, before, _after = self.recover()
            self.status = status
            if status == "restored":
                self.note(f"previous release restored and verified (from {self.rollback})")
            elif status == "live-untouched":
                self.note("the live directory was never moved; deployment unchanged")
            elif status == "nothing-to-restore":
                self.note("no previous release existed, so there was nothing to restore")
            elif status == "restore-unverified":
                self.note("RESTORE FAILED verification - manual intervention required")
            else:
                self.note(f"RESTORE FAILED ({status}) - manual intervention required; "
                          f"the previous release may still be at {self.rollback}")
            # Pre-swap failures leave the live directory untouched.
            if not before["rollback"] and self.remote.exists("-d", self.staging):
                self.remote.remove_tree(self.staging)
            self._cleanup()
            # Exit code follows observed state, not a local flag: a rollback that
            # exists means the live directory really was swapped.
            return EXIT_SWAP_FAILED if before["rollback"] else EXIT_STAGING_FAILED
        except Exception as error:  # transport or unexpected
            self.note(f"TRANSPORT FAILURE: {type(error).__name__}")
            status, _before, _after = self.recover()
            self.status = status
            self.note(f"recovery status: {status}")
            self._cleanup()
            return EXIT_TRANSPORT_FAILED

        self.status = "deployed"
        self._cleanup()
        self.note("deployed and verified")
        self.note("previous releases are retained and are NOT pruned automatically; "
                  "review and remove them by hand when satisfied")
        return EXIT_OK

    def _cleanup(self):
        self.remote.remove_file(self.archive)
        # The staging directory is removed only if it is still ours and unpublished.
        if self.remote.exists("-d", self.staging):
            self.remote.remove_tree(self.staging)


def main():
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import paramiko

    local_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    host = os.environ.get("WITT_SSH_HOST", "186.244.203.27")
    port = int(os.environ.get("WITT_SSH_PORT", "28987"))
    user = os.environ.get("WITT_SSH_USER", "root")
    key = os.environ.get("WITT_SSH_KEY", os.path.expanduser("~/.ssh/id_ed25519"))

    payload = build_archive(local_root)
    print(f"archive built: {len(payload)} bytes")

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, port=port, username=user, key_filename=key,
                   timeout=25, allow_agent=False, look_for_keys=False)
    try:
        deployer = Deployer(SshRemote(client), payload)
        print(f"staging={deployer.staging}")
        print(f"rollback={deployer.rollback}")
        code = deployer.deploy()
    finally:
        client.close()
    print()
    for line in deployer.report[-8:]:
        print(line)
    print("note: a running backend keeps its old working directory until restarted")
    return code


if __name__ == "__main__":
    sys.exit(main())
