#!/bin/bash
# Probe which protocols CPA and Sub2API actually serve.
# The gateway key is read on the server and never printed.
set -u
KEY=$(python3 - <<'PY'
import re
text = open('/opt/cliproxyapi/config.yaml', encoding='utf-8', errors='replace').read()
block = text.split('api-keys:', 1)[1].split('\n\n', 1)[0]
keys = re.findall(r'(?m)^\s*-\s*"([^"]+)"', block)
print(keys[0] if keys else '')
PY
)
if [ -z "$KEY" ]; then echo "NO CPA KEY FOUND"; exit 1; fi

probe() {
  local name="$1" url="$2" data="$3"
  if [ -n "$data" ]; then
    code=$(curl -sS -o /tmp/witt-probe.out -w '%{http_code}' -m 40 \
      -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
      -d "$data" "$url" 2>/dev/null)
  else
    code=$(curl -sS -o /tmp/witt-probe.out -w '%{http_code}' -m 25 \
      -H "Authorization: Bearer $KEY" "$url" 2>/dev/null)
  fi
  echo "--- $name -> HTTP $code"
  head -c 400 /tmp/witt-probe.out | tr -d '\000'; echo
}

CHAT='{"model":"grok-4.7-high","messages":[{"role":"user","content":"Reply with exactly: PROBE_OK"}],"max_tokens":24,"stream":false}'
RESP='{"model":"grok-4.7-high","input":"Reply with exactly: PROBE_OK","stream":false}'

probe "CPA  GET /v1/models"            "http://127.0.0.1:8317/v1/models" ""
probe "CPA  POST /v1/chat/completions" "http://127.0.0.1:8317/v1/chat/completions" "$CHAT"
probe "CPA  POST /v1/responses"        "http://127.0.0.1:8317/v1/responses" "$RESP"
probe "CPA  POST /v1/messages"         "http://127.0.0.1:8317/v1/messages" '{"model":"grok-4.7-high","max_tokens":24,"messages":[{"role":"user","content":"Reply with exactly: PROBE_OK"}]}'

echo "=== CPA streaming check (chat/completions stream=true) ==="
timeout 45 curl -sS -N -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"grok-4.7-high","messages":[{"role":"user","content":"Reply with exactly: PROBE_OK"}],"max_tokens":24,"stream":true}' \
  http://127.0.0.1:8317/v1/chat/completions 2>&1 | head -c 700
echo
rm -f /tmp/witt-probe.out
