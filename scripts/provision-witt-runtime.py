#!/usr/bin/env python3
"""Apply non-secret Witt runtime switches while preserving existing secrets."""

import os
import pathlib

ENV_FILE = pathlib.Path("/root/.witt/app.env")
MANAGEMENT_KEY = pathlib.Path("/root/.witt/cpa-management-key")
SETTINGS = {
    "WITT_CPA_MANAGEMENT_KEY_FILE": str(MANAGEMENT_KEY),
    "WITT_CPA_QUOTA_CONCURRENCY": "16",
    "OPEN_WEBUI_URL": "https://cpa.stellarbit.site:9443/",
    "WITT_REMOTE_DEVICE_MCP_ENABLED": "1",
    "WITT_BROWSER_MCP_ENABLED": "1",
}


def main():
    if not ENV_FILE.is_file():
        raise SystemExit("Witt app.env is missing")
    if not MANAGEMENT_KEY.is_file() or MANAGEMENT_KEY.stat().st_size < 32:
        raise SystemExit("CPA management credential is missing")
    lines = ENV_FILE.read_text(encoding="utf-8").splitlines()
    found = set()
    updated = []
    for line in lines:
        key = line.split("=", 1)[0] if "=" in line else ""
        if key in SETTINGS:
            updated.append(f"{key}={SETTINGS[key]}")
            found.add(key)
        else:
            updated.append(line)
    for key, value in SETTINGS.items():
        if key not in found:
            updated.append(f"{key}={value}")
    temporary = ENV_FILE.with_name(ENV_FILE.name + ".tmp-witt")
    temporary.write_text("\n".join(updated).rstrip() + "\n", encoding="utf-8")
    os.chmod(temporary, 0o600)
    os.replace(temporary, ENV_FILE)
    print("Witt runtime settings provisioned")


if __name__ == "__main__":
    main()
