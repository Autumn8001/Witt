#!/bin/bash
# Temporary operator workaround for CLIProxyAPI issue #6249.
# CPA v8.0.7 pins x-grok-client-version=0.2.120, which xAI stopped accepting.
# Add per-auth headers after making a root-only backup. No credential values are
# printed, and existing metadata/permissions are preserved.
set -euo pipefail

AUTH_DIR="${CPA_AUTH_DIR:-/opt/cliproxyapi/auths}"
CLIENT_VERSION="${GROK_CLIENT_VERSION:-1.0.44}"
BACKUP_DIR="${CPA_AUTH_BACKUP_DIR:-/root/.witt/cpa-auth-before-grok-version}"

python3 - "$AUTH_DIR" "$BACKUP_DIR" "$CLIENT_VERSION" <<'PY'
import json
import os
import shutil
import sys
import tempfile

auth_dir, backup_dir, version = sys.argv[1:]
if not os.path.isdir(auth_dir):
    raise SystemExit("CPA auth directory does not exist")

os.makedirs(backup_dir, mode=0o700, exist_ok=True)
changed = 0
already_current = 0
skipped = 0

for name in os.listdir(auth_dir):
    if not name.endswith(".json"):
        continue
    source = os.path.join(auth_dir, name)
    try:
        with open(source, encoding="utf-8") as handle:
            record = json.load(handle)
    except (OSError, json.JSONDecodeError):
        skipped += 1
        continue
    if not isinstance(record, dict) or record.get("type") != "xai":
        continue

    headers = record.get("headers")
    if headers is None:
        headers = {}
    if not isinstance(headers, dict):
        skipped += 1
        continue
    expected = {
        "x-grok-client-version": version,
        "User-Agent": f"xai-grok-workspace/{version}",
    }
    if all(headers.get(key) == value for key, value in expected.items()):
        already_current += 1
        continue

    backup = os.path.join(backup_dir, name)
    if not os.path.exists(backup):
        shutil.copy2(source, backup)
    record["headers"] = {**headers, **expected}
    mode = os.stat(source).st_mode & 0o777
    fd, temporary = tempfile.mkstemp(prefix=f".{name}.", dir=auth_dir, text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(record, handle, ensure_ascii=False, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, source)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    changed += 1

print(f"xai auth metadata updated={changed} already_current={already_current} skipped={skipped}")
print(f"backup directory={backup_dir}")
PY
