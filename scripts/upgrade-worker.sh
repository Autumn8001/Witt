#!/usr/bin/env bash
set -Eeuo pipefail

repo="${WITT_REPO_ROOT:-/opt/witt}"
releases="${WITT_RELEASES_ROOT:-$repo/.git/witt-releases}"
socket="${WITT_WORKER_SOCKET:-/run/witt/worker.sock}"
dropin="${WITT_WORKER_DROPIN:-/etc/systemd/system/witt-worker.service.d/10-release.conf}"
curl_bin="${WITT_CURL_BIN:-curl}"
systemctl_bin="${WITT_SYSTEMCTL_BIN:-systemctl}"
node_bin="${WITT_NODE_BIN:-node}"
sleep_bin="${WITT_SLEEP_BIN:-sleep}"
timeout_seconds="${WITT_WORKER_DRAIN_TIMEOUT_SECONDS:-240}"
poll_seconds="${WITT_WORKER_DRAIN_POLL_SECONDS:-2}"

usage() {
  echo "Usage: $0 <40-character-commit-sha>" >&2
  exit 2
}

[[ $# -eq 1 ]] || usage
sha="${1,,}"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || usage
[[ "$timeout_seconds" =~ ^[1-9][0-9]*$ ]] || { echo "invalid drain timeout" >&2; exit 2; }
[[ "$poll_seconds" =~ ^[1-9][0-9]*$ ]] || { echo "invalid drain poll interval" >&2; exit 2; }

release="$releases/$sha"
worker_entry="$release/backend/worker-service.js"
[[ -f "$worker_entry" ]] || { echo "worker snapshot is missing: $worker_entry" >&2; exit 2; }
[[ -d "$release/backend/node_modules" ]] || { echo "worker snapshot dependencies are missing: $release/backend/node_modules" >&2; exit 2; }
"$node_bin" --check "$worker_entry"

python_status() {
  local mode="$1"
  python3 -c '
import json, sys
mode = sys.argv[1]
try:
    data = json.load(sys.stdin)
except Exception as exc:
    raise SystemExit(f"invalid worker JSON: {exc}")
if not isinstance(data, dict) or data.get("ok") is not True:
    raise SystemExit("worker response did not report ok=true")
if type(data.get("runningCount")) is not int or data["runningCount"] < 0:
    raise SystemExit("worker response has invalid runningCount")
if data.get("draining") is not True:
    raise SystemExit("worker did not confirm draining=true")
print(data["runningCount"])
' "$mode"
}

python_health() {
  python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    raise SystemExit(1)
if (not isinstance(data, dict) or data.get("ok") is not True
        or type(data.get("activeCount")) is not int or data["activeCount"] < 0
        or data.get("draining") is not False):
    raise SystemExit(1)
'
}

resume_worker() {
  "$curl_bin" --silent --show-error --fail --max-time 5 \
    --unix-socket "$socket" -X POST http://localhost/admin/resume >/dev/null 2>&1 || true
}

echo "Requesting Worker drain before switching to $sha..."
if ! drain_reply="$("$curl_bin" --silent --show-error --fail --max-time 5 \
  --unix-socket "$socket" -X POST http://localhost/admin/drain)"; then
  echo "could not request Worker drain; no restart was attempted" >&2
  exit 1
fi
if ! initial_count="$(printf '%s' "$drain_reply" | python_status drain)"; then
  echo "Worker returned an invalid drain response; no restart was attempted" >&2
  exit 1
fi
echo "Worker accepted drain request; $initial_count task(s) were active."

drained=0
elapsed=0
while (( elapsed <= timeout_seconds )); do
  if ! status_reply="$("$curl_bin" --silent --show-error --fail --max-time 5 \
    --unix-socket "$socket" http://localhost/admin/status)"; then
    echo "Worker status request failed while draining; task state is unknown, no restart was attempted" >&2
    exit 1
  fi
  if ! running="$(printf '%s' "$status_reply" | python_status status)"; then
    echo "Worker status response was invalid; task state is unknown, no restart was attempted" >&2
    exit 1
  fi
  if [[ "$running" -eq 0 ]]; then
    drained=1
    break
  fi
  if (( elapsed >= timeout_seconds )); then
    break
  fi
  echo "Waiting for $running active task(s) (${elapsed}/${timeout_seconds}s)."
  "$sleep_bin" "$poll_seconds"
  elapsed=$((elapsed + poll_seconds))
done

if [[ "$drained" -ne 1 ]]; then
  resume_worker
  echo "Worker drain timed out after ${timeout_seconds}s; active work was not stopped. The Worker was returned to service and no restart was attempted. Re-run this command after tasks finish." >&2
  exit 1
fi

dropin_dir="$(dirname "$dropin")"
mkdir -p "$dropin_dir"
temporary="$dropin.tmp.$$"
cat > "$temporary" <<EOF
[Service]
WorkingDirectory=$release
ExecStart=
ExecStart=/usr/local/bin/node $worker_entry
Environment=WITT_WORKER_RELEASE_SHA=$sha
EOF
chmod 0644 "$temporary"
mv -f "$temporary" "$dropin"

echo "No active tasks remain. Switching Worker to snapshot $sha..."
"$systemctl_bin" daemon-reload
"$systemctl_bin" restart witt-worker.service

for attempt in {1..20}; do
  if health_reply="$("$curl_bin" --silent --show-error --fail --max-time 3 \
    --unix-socket "$socket" http://localhost/health 2>/dev/null)" &&
     printf '%s' "$health_reply" | python_health; then
    echo "Worker upgraded and healthy at $sha."
    exit 0
  fi
  "$sleep_bin" 1
done

echo "Worker restart completed but health verification failed; inspect witt-worker.service and its journal. Target drop-in remains set to $sha." >&2
exit 1
