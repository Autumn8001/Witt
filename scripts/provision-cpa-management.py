#!/usr/bin/env python3
"""Create Witt's CPA management credential without printing the secret."""

import os
import pathlib
import re
import secrets
import shutil

CONFIG = pathlib.Path("/opt/cliproxyapi/config.yaml")
KEY_FILE = pathlib.Path("/root/.witt/cpa-management-key")
BACKUP = pathlib.Path("/opt/cliproxyapi/config.yaml.pre-witt-management")


def main():
    KEY_FILE.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if KEY_FILE.exists():
        key = KEY_FILE.read_text(encoding="utf-8").strip()
        if len(key) < 32:
            raise SystemExit("existing CPA management key is invalid")
    else:
        key = secrets.token_urlsafe(48)
        temporary_key = KEY_FILE.with_name(KEY_FILE.name + ".tmp")
        temporary_key.write_text(key + "\n", encoding="utf-8")
        os.chmod(temporary_key, 0o600)
        os.replace(temporary_key, KEY_FILE)

    original = CONFIG.read_text(encoding="utf-8")
    pattern = re.compile(r"(?m)^(\s*secret-key:\s*).*$")
    if len(pattern.findall(original)) != 1:
        raise SystemExit("CPA remote-management secret-key is missing or ambiguous")
    updated = pattern.sub(lambda match: match.group(1) + '"' + key + '"', original)
    if not BACKUP.exists():
        shutil.copy2(CONFIG, BACKUP)
        os.chmod(BACKUP, 0o600)
    temporary_config = CONFIG.with_name(CONFIG.name + ".tmp-witt")
    temporary_config.write_text(updated, encoding="utf-8")
    os.chmod(temporary_config, 0o600)
    os.replace(temporary_config, CONFIG)
    print("CPA management credential provisioned")


if __name__ == "__main__":
    main()
