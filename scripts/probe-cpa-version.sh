#!/bin/bash
# Read-only: is the 426 caused by a CPA-side client-version setting? Change nothing.
set -u
echo "=== CPA version / build (from its own response headers) ==="
curl -sS -m 20 -D- -o /dev/null http://127.0.0.1:8317/healthz 2>/dev/null | grep -i 'x-cpa\|x-server' || echo "(no headers)"

echo "=== config keys mentioning version/xai/client ==="
grep -n -i 'version\|xai\|client\|spoof\|user-agent' /opt/cliproxyapi/config.yaml | head -30

echo "=== any CPA setting for the CLI version string? ==="
grep -n -i 'cli-chat-proxy\|cli_chat_proxy\|cli-version\|cli_version' /opt/cliproxyapi/config.yaml || echo "(none in config)"

echo "=== running image vs available ==="
docker inspect cli-proxy-api --format '{{.Config.Image}} created={{.Created}}' 2>/dev/null
docker images --format '{{.Repository}}:{{.Tag}} {{.CreatedSince}}' 2>/dev/null | grep -i 'cli-proxy\|cpa' || true

echo "=== recent upstream 426 lines: what version does CPA claim? ==="
docker logs --tail 200 cli-proxy-api 2>&1 | grep -o 'Grok CLI version ([0-9.]*)' | sort -u | head -5
echo "=== is any non-quota xai credential left? (counts only) ==="
docker logs --tail 300 cli-proxy-api 2>&1 | grep -o 'auth unavailable: [0-9]* of [0-9]*' | tail -3
