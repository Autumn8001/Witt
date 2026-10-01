#!/bin/bash
# MCP tool chain verification for Grok Build.
set -u
export PATH="/root/.local/bin:$PATH"
set -a; . /root/.witt/cpa.env; set +a
WORK=/root/witt-grok-work
cd "$WORK"

echo "=== register MCP server (user scope) ==="
grok mcp add wittprobe python3 /root/witt-mcp/witt_probe_mcp.py --scope user 2>&1 | head -10
echo "=== mcp list ==="
grok mcp list 2>&1 | head -20
echo "=== inspect shows MCP server ==="
timeout 60 grok inspect 2>&1 | grep -A4 -i 'MCP Servers'

echo "=== A5.2 MCP tool chain ==="
timeout 300 grok -p "Use the wittprobe MCP tool named witt_ping and reply with only the exact string it returns." \
  --model witt-grok-high --output-format streaming-json --no-auto-update \
  --cwd "$WORK" --yolo 2>&1 | python3 -c '
import sys, json
calls = []; text = []
for line in sys.stdin:
    line = line.strip()
    if not line.startswith("{"): continue
    try: event = json.loads(line)
    except Exception: continue
    kind = event.get("type")
    if kind == "tool_call":
        calls.append(event.get("toolName"))
        print("TOOL_CALL name=%s kind=%s input=%s" % (event.get("toolName"), event.get("kind"), json.dumps(event.get("rawInput"))[:160]))
    elif kind == "tool_call_update":
        print("TOOL_UPDATE status=%s rawOutput=%s" % (event.get("status"), json.dumps(event.get("rawOutput"))[:160]))
    elif kind == "text":
        text.append(event.get("data", ""))
    elif kind == "error":
        print("ERROR", event.get("message"))
print("tool_names:", calls)
print("FINAL_TEXT:", "".join(text)[:200])
'
