#!/bin/bash
# Diagnose the 426 Upgrade Required returned through the Grok -> CPA path.
set -u
export PATH="/root/.local/bin:/usr/local/bin:$PATH"

KEY=$(python3 -c "
import re
text=open('/opt/cliproxyapi/config.yaml',encoding='utf-8',errors='replace').read()
block=text.split('api-keys:',1)[1].split('\n\n',1)[0]
k=re.findall(r'(?m)^\s*-\s*\"([^\"]+)\"',block)
print(k[0] if k else '')
")

echo "=== 1. CPA /v1/chat/completions (direct) ==="
curl -sS -m 60 -o /tmp/d1.json -w 'HTTP %{http_code}\n' \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"grok-4.7-high","messages":[{"role":"user","content":"Say OK"}],"max_tokens":16}' \
  http://127.0.0.1:8317/v1/chat/completions
head -c 500 /tmp/d1.json; echo

echo "=== 2. CPA /v1/responses (direct, what Grok Build uses) ==="
curl -sS -m 60 -o /tmp/d2.json -w 'HTTP %{http_code}\n' \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"grok-4.7-high","input":"Say OK","stream":false}' \
  http://127.0.0.1:8317/v1/responses
head -c 700 /tmp/d2.json; echo

echo "=== 3. Grok Build headless (full stderr) ==="
set -a; . /root/.witt/cpa.env; set +a
cd /root/witt-grok-work
timeout 120 grok -p "Say OK" --model grok-4.7-high --output-format json \
  --no-auto-update --cwd /root/witt-grok-work > /tmp/d3.out 2>/tmp/d3.err
echo "exit=$?"
echo "--- stdout ---"; head -c 400 /tmp/d3.out; echo
echo "--- stderr ---"; head -c 1200 /tmp/d3.err; echo

echo "=== 4. Grok version + update check ==="
grok --version 2>&1 | head -2
timeout 60 grok update --check 2>&1 | head -10 || true

echo "=== 5. CPA logs (recent, redacted) ==="
ls -la /opt/cliproxyapi/logs 2>/dev/null | head -5
tail -c 1500 /opt/cliproxyapi/logs/*.log 2>/dev/null | sed -E 's/(sk-|xai-|AIza)[A-Za-z0-9_-]{6,}/REDACTED/g' | tail -20 || echo "no logs"

echo "=== 6. docker CPA recent output ==="
docker logs --tail 25 cli-proxy-api 2>&1 | sed -E 's/(sk-|xai-|AIza)[A-Za-z0-9_-]{6,}/REDACTED/g' | tail -25

rm -f /tmp/d1.json /tmp/d2.json /tmp/d3.out /tmp/d3.err
