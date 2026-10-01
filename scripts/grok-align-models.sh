#!/bin/bash
# TOML treats dots in bare keys as path separators, so dotted model ids must be
# quoted: [model."grok-4.7-high"]. Re-register MCP through the CLI afterwards.
set -u
export PATH="/root/.local/bin:$PATH"

cat > /root/.grok/config.toml <<'EOF'
[cli]
installer = "internal"

# Witt: route Grok models through the local CPA gateway.
[model_providers.witt-cpa]
base_url = "http://127.0.0.1:8317/v1"
api_backend = "responses"

[model."grok-4.7-high"]
model = "grok-4.7-high"
model_provider = "witt-cpa"
name = "Grok 4.7 High"
env_key = "WITT_CPA_KEY"
context_window = 256000

[model."grok-4.7-medium"]
model = "grok-4.7-medium"
model_provider = "witt-cpa"
name = "Grok 4.7 Medium"
env_key = "WITT_CPA_KEY"
context_window = 256000

[model."grok-4.7-max"]
model = "grok-4.7-max"
model_provider = "witt-cpa"
name = "Grok 4.7 Max"
env_key = "WITT_CPA_KEY"
context_window = 256000

[model."grok-4.7-xhigh"]
model = "grok-4.7-xhigh"
model_provider = "witt-cpa"
name = "Grok 4.7 XHigh"
env_key = "WITT_CPA_KEY"
context_window = 256000
EOF

grok mcp add wittprobe python3 /root/witt-mcp/witt_probe_mcp.py --scope user 2>&1 | head -3
echo "=== models ==="
timeout 60 grok models 2>&1 | head -20
echo "=== mcp ==="
grok mcp list 2>&1 | head -5
echo "=== config ==="
cat /root/.grok/config.toml | head -40
