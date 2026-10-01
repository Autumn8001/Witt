#!/bin/bash
# Configure Grok Build to reach Grok models through CPA, then run a live headless call.
# The CPA key is read on the server and stored root-only; it is never printed.
set -u
export PATH="/root/.local/bin:$PATH"

mkdir -p /root/.witt
chmod 700 /root/.witt

# Extract the CPA key server-side into a root-only env file.
python3 - <<'PY'
import os, re
text = open('/opt/cliproxyapi/config.yaml', encoding='utf-8', errors='replace').read()
block = text.split('api-keys:', 1)[1].split('\n\n', 1)[0]
keys = re.findall(r'(?m)^\s*-\s*"([^"]+)"', block)
key = keys[0] if keys else ''
path = '/root/.witt/cpa.env'
with open(path, 'w', encoding='utf-8') as handle:
    handle.write('WITT_CPA_KEY=%s\n' % key)
os.chmod(path, 0o600)
print('cpa env written, key length', len(key))
PY

BACKEND="${1:-responses}"

cat > /root/.grok/config.toml <<EOF
[cli]
installer = "internal"

# Witt: route Grok models through the local CPA gateway.
[model_providers.witt-cpa]
base_url = "http://127.0.0.1:8317/v1"
api_backend = "$BACKEND"

[model.witt-grok-high]
model = "grok-4.7-high"
model_provider = "witt-cpa"
name = "Grok 4.7 High via CPA"
env_key = "WITT_CPA_KEY"
context_window = 256000
EOF

echo "=== config.toml ==="
cat /root/.grok/config.toml
echo "=== models discovery ==="
timeout 90 grok models 2>&1 | head -25
echo "=== LIVE HEADLESS ($BACKEND) ==="
set -a; . /root/.witt/cpa.env; set +a
mkdir -p /root/witt-grok-work
cd /root/witt-grok-work
timeout 180 grok -p "Reply with one short friendly sentence." \
  --model witt-grok-high \
  --output-format streaming-json \
  --no-auto-update \
  --cwd /root/witt-grok-work 2>&1 | head -40
echo "=== exit: $? ==="
