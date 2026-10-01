#!/bin/bash
# Tool + MCP verification for Grok Build.
set -u
export PATH="/root/.local/bin:$PATH"
set -a; . /root/.witt/cpa.env; set +a
WORK=/root/witt-grok-work
mkdir -p "$WORK" /root/witt-mcp
cd "$WORK"

echo "TOKEN_FILE_CONTENT=WITT_FILE_TOKEN_42" > "$WORK/probe-token.txt"

echo "=== A5.1 built-in tool call (read_file) ==="
timeout 240 grok -p "Read the file probe-token.txt in the current directory and reply with only the token value it contains." \
  --model witt-grok-high --output-format streaming-json --no-auto-update \
  --cwd "$WORK" --yolo 2>&1 | python3 -c '
import sys, json
tool_calls = 0; text = []
for line in sys.stdin:
    line = line.strip()
    if not line.startswith("{"): continue
    try: event = json.loads(line)
    except Exception: continue
    kind = event.get("type")
    if kind == "tool_call":
        tool_calls += 1
        print("TOOL_CALL name=%s kind=%s input=%s" % (event.get("toolName"), event.get("kind"), json.dumps(event.get("rawInput"))[:120]))
    elif kind == "tool_call_update":
        print("TOOL_UPDATE status=%s rawOutput=%s" % (event.get("status"), json.dumps(event.get("rawOutput"))[:120]))
    elif kind == "text":
        text.append(event.get("data", ""))
    elif kind == "error":
        print("ERROR", event.get("message"))
print("tool_call_events:", tool_calls)
print("FINAL_TEXT:", "".join(text)[:200])
'

cat > /root/witt-mcp/witt_probe_mcp.py <<'PY'
#!/usr/bin/env python3
"""Minimal MCP stdio server exposing one safe read-only tool."""
import json
import sys

TOOLS = [{
    "name": "witt_ping",
    "description": "Return the Witt verification codeword.",
    "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
}]


def send(payload):
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


for raw in sys.stdin:
    raw = raw.strip()
    if not raw:
        continue
    try:
        message = json.loads(raw)
    except Exception:
        continue
    method = message.get("method")
    mid = message.get("id")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": mid, "result": {
            "protocolVersion": "2024-11-05",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "witt-probe", "version": "1.0.0"}}})
    elif method == "notifications/initialized":
        continue
    elif method == "tools/list":
        send({"jsonrpc": "2.0", "id": mid, "result": {"tools": TOOLS}})
    elif method == "tools/call":
        send({"jsonrpc": "2.0", "id": mid, "result": {
            "content": [{"type": "text", "text": "WITT_MCP_OK"}], "isError": False}})
    elif mid is not None:
        send({"jsonrpc": "2.0", "id": mid, "result": {}})
PY
chmod +x /root/witt-mcp/witt_probe_mcp.py

echo "=== grok mcp add help ==="
grok mcp add --help 2>&1 | head -30
