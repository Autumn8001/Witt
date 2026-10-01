#!/usr/bin/env python3
"""Run a shell command on the Witt server over SSH.

Usage:
  python scripts/remote-exec.py 'uname -a'
  python scripts/remote-exec.py -f path/to/script.sh

Connection values come from environment variables with safe defaults:
  WITT_SSH_HOST, WITT_SSH_PORT, WITT_SSH_USER, WITT_SSH_KEY

Output is redacted so secrets never land in logs or reports.
"""

import os
import re
import sys

import paramiko

HOST = os.environ.get("WITT_SSH_HOST", "186.244.203.27")
PORT = int(os.environ.get("WITT_SSH_PORT", "28987"))
USER = os.environ.get("WITT_SSH_USER", "root")
KEY = os.environ.get("WITT_SSH_KEY", os.path.expanduser("~/.ssh/id_ed25519"))

SECRET = re.compile(
    r"(?i)((?:api[_-]?key|token|secret|password|authorization|bearer"
    r"|x-api-key|x-goog-api-key|GEMINI_API_KEY|XAI_API_KEY|OPENAI_API_KEY)"
    r"\s*[:=]\s*)([^\s,;\"']+)"
)
# Real credentials are long random strings. Keep the minimum length high enough
# that flag names such as `--xai-api-base-url` are never redacted by mistake.
TOKENS = re.compile(
    r"\b(?:sk-[A-Za-z0-9_\-]{20,}|xai-[A-Za-z0-9_\-]{20,}"
    r"|AIza[A-Za-z0-9_\-]{20,}|ghp_[A-Za-z0-9]{20,})\b"
)


def redact(text):
    text = SECRET.sub(lambda match: match.group(1) + "REDACTED", text)
    return TOKENS.sub("REDACTED", text)


def emit(text):
    """Write UTF-8 bytes so Windows console code pages cannot break output."""
    buffer = getattr(sys.stdout, "buffer", None)
    if buffer is None:
        sys.stdout.write(text)
        return
    buffer.write(text.encode("utf-8", "replace"))
    buffer.flush()


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return 2
    if args[0] == "-f":
        with open(args[1], encoding="utf-8") as handle:
            command = handle.read()
    else:
        command = " ".join(args)

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        HOST, port=PORT, username=USER, key_filename=KEY,
        timeout=25, allow_agent=False, look_for_keys=False,
    )
    _stdin, stdout, stderr = client.exec_command(command, timeout=2400)
    emit(redact(stdout.read().decode("utf-8", "replace")))
    error = stderr.read().decode("utf-8", "replace").strip()
    if error:
        emit("\n[stderr]\n" + redact(error) + "\n")
    client.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
