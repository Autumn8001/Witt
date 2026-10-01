#!/bin/bash
# Cheap probe: has the xAI/CPA path recovered from the 426 / quota cooldown?
set -u
KEY=$(python3 -c "
import re
text=open('/opt/cliproxyapi/config.yaml',encoding='utf-8',errors='replace').read()
block=text.split('api-keys:',1)[1].split('\n\n',1)[0]
k=re.findall(r'(?m)^\s*-\s*\"([^\"]+)\"',block)
print(k[0] if k else '')
")
echo "=== CPA /v1/responses grok-4.7-high ==="
curl -sS -m 90 -o /tmp/p.json -w 'HTTP %{http_code}\n' \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"grok-4.7-high","input":"Reply with the single word OK.","stream":false}' \
  http://127.0.0.1:8317/v1/responses
head -c 300 /tmp/p.json; echo
echo "=== CPA cooldown snapshot (count only) ==="
docker logs --tail 400 cli-proxy-api 2>&1 | grep -c 'in cooldown' || true
docker logs --tail 400 cli-proxy-api 2>&1 | grep -o 'reason=[a-z]*' | sort | uniq -c | head -5 || true
rm -f /tmp/p.json
