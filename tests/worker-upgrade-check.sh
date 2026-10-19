#!/usr/bin/env bash
set -Eeuo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$repo/scripts/upgrade-worker.sh"
temp="$(mktemp -d)"
trap 'rm -rf "$temp"' EXIT

sha=0123456789abcdef0123456789abcdef01234567
release="$temp/releases/$sha"
mkdir -p "$release/backend/node_modules" "$temp/bin"
printf '"use strict";\n' > "$release/backend/worker-service.js"

cat > "$temp/bin/curl" <<'MOCK_CURL'
#!/usr/bin/env bash
set -eu
url="${!#}"
if [[ "$url" == *"/admin/drain" ]]; then
  case "$MOCK_CURL_MODE" in
    drain-fail) exit 7 ;;
    *) printf '%s\n' '{"ok":true,"draining":true,"runningCount":1}' ;;
  esac
elif [[ "$url" == *"/admin/status" ]]; then
  case "$MOCK_CURL_MODE" in
    status-fail) exit 7 ;;
    timeout) printf '%s\n' '{"ok":true,"draining":true,"runningCount":1}' ;;
    invalid-count) printf '%s\n' '{"ok":true,"draining":true,"runningCount":"0"}' ;;
    *) printf '%s\n' '{"ok":true,"draining":true,"runningCount":0}' ;;
  esac
elif [[ "$url" == *"/admin/resume" ]]; then
  printf '%s\n' 'resume' >> "$MOCK_CURL_LOG"
  printf '%s\n' '{"ok":true,"draining":false,"runningCount":1}'
elif [[ "$url" == *"/health" ]]; then
  printf '%s\n' '{"ok":true,"activeCount":0,"draining":false}'
else
  echo "unexpected curl URL: $url" >&2
  exit 9
fi
MOCK_CURL

cat > "$temp/bin/systemctl" <<'MOCK_SYSTEMCTL'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "$MOCK_SYSTEMCTL_LOG"
MOCK_SYSTEMCTL

cat > "$temp/bin/sleep" <<'MOCK_SLEEP'
#!/usr/bin/env bash
exit 0
MOCK_SLEEP
cat > "$temp/bin/node" <<'MOCK_NODE'
#!/usr/bin/env bash
[[ "$1" == --check && -f "$2" ]]
MOCK_NODE
chmod +x "$temp/bin/curl" "$temp/bin/systemctl" "$temp/bin/sleep" "$temp/bin/node"

run_case() {
  local mode="$1"
  local expected_rc="$2"
  local expected_restart="$3"
  local expected_resume="$4"
  local case_dir="$temp/case-$mode"
  mkdir -p "$case_dir"
  local rc=0
  : > "$case_dir/systemctl.log"
  : > "$case_dir/curl.log"
  if env \
    MOCK_CURL_MODE="$mode" \
    MOCK_SYSTEMCTL_LOG="$case_dir/systemctl.log" \
    MOCK_CURL_LOG="$case_dir/curl.log" \
    WITT_RELEASES_ROOT="$temp/releases" \
    WITT_WORKER_SOCKET="$case_dir/worker.sock" \
    WITT_WORKER_DROPIN="$case_dir/10-release.conf" \
    WITT_CURL_BIN="$temp/bin/curl" \
    WITT_SYSTEMCTL_BIN="$temp/bin/systemctl" \
    WITT_NODE_BIN="$temp/bin/node" \
    WITT_SLEEP_BIN="$temp/bin/sleep" \
    WITT_WORKER_DRAIN_TIMEOUT_SECONDS=1 \
    WITT_WORKER_DRAIN_POLL_SECONDS=1 \
      bash "$script" "$sha" > "$case_dir/output.log" 2>&1; then
    rc=0
  else
    rc=$?
  fi

  [[ "$rc" -eq "$expected_rc" ]] || {
    cat "$case_dir/output.log" >&2
    echo "$mode: expected exit $expected_rc, got $rc" >&2
    return 1
  }
  if [[ "$expected_restart" == yes ]]; then
    grep -q '^restart witt-worker.service$' "$case_dir/systemctl.log" || {
      echo "$mode: expected Worker restart" >&2
      return 1
    }
    grep -q "Environment=WITT_WORKER_RELEASE_SHA=$sha" "$case_dir/10-release.conf" || {
      echo "$mode: expected release drop-in" >&2
      return 1
    }
  else
    if grep -q 'restart witt-worker.service' "$case_dir/systemctl.log"; then
      echo "$mode: Worker was restarted after an unconfirmed drain" >&2
      return 1
    fi
    if [[ -e "$case_dir/10-release.conf" ]]; then
      echo "$mode: release drop-in changed before drain completed" >&2
      return 1
    fi
  fi
  if [[ "$expected_resume" == yes ]]; then
    grep -q '^resume$' "$case_dir/curl.log" || {
      echo "$mode: expected Worker admission to resume" >&2
      return 1
    }
  elif [[ -s "$case_dir/curl.log" ]]; then
    echo "$mode: Worker admission unexpectedly changed" >&2
    return 1
  fi
}

run_case drain-fail 1 no no
run_case status-fail 1 no no
run_case invalid-count 1 no no
run_case timeout 1 no yes
run_case idle 0 yes no
echo "worker upgrade checks passed (drain failure, status loss, invalid count, timeout resume, idle restart)"
