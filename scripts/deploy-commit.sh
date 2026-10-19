#!/usr/bin/env bash
set -Eeuo pipefail

repo=/opt/witt
branch=platform/personal-ai-ops
origin=git@github-witt-autumn:Autumn8001/Witt.git
sha="${1:-}"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid commit SHA" >&2; exit 2; }
cd "$repo"
[[ "$(git branch --show-current)" == "$branch" ]] || { echo "wrong branch" >&2; exit 2; }
[[ "$(git remote get-url origin)" == "$origin" ]] || { echo "wrong origin" >&2; exit 2; }
[[ "$(git rev-parse HEAD)" == "$sha" ]] || { echo "HEAD changed" >&2; exit 2; }
[[ -z "$(git status --porcelain=v1 --untracked-files=all)" ]] || { echo "worktree is not clean" >&2; exit 2; }
[[ "$(git ls-remote origin "refs/heads/$branch" | cut -f1)" == "$sha" ]] || { echo "origin SHA differs" >&2; exit 2; }

python3 "$repo/scripts/provision-witt-runtime.py"
(cd "$repo/backend" &&
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund &&
  node node_modules/playwright/cli.js install chromium)

releases="$repo/.git/witt-releases"
release="$releases/$sha"
mkdir -p "$releases"
if [[ ! -d "$release" ]]; then
  staging="$(mktemp -d "$releases/.new-$sha-XXXXXXXX")"
  git archive "$sha" | tar -xf - -C "$staging"
  printf '{"frontendSha":"%s"}\n' "$sha" > "$staging/web/version.json"
  node --check "$staging/backend/server.js"
  node --check "$staging/backend/chat-service.js"
  (cd "$staging/backend" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
  # Downloads are separately built release artifacts, never tracked binaries.
  # Keep a compatible published connector through ordinary frontend releases.
  previous="$(systemctl show witt.service -p WorkingDirectory --value)"
  python3 - "$previous" "$staging" <<'PY'
import hashlib, json, pathlib, re, shutil, sys
previous, staging = map(pathlib.Path, sys.argv[1:])
assert re.fullmatch(r'/opt/witt/\.git/witt-releases/[0-9a-f]{40}', str(previous))
source = staging / 'agent/windows/assist_update.go'
if source.exists():
    downloads = previous / 'web/downloads'
    metadata = json.loads((downloads / 'release.json').read_text())
    version = re.search(r'var assistVersion = "([0-9.]+)"', source.read_text()).group(1)
    assert metadata['version'] == version, 'Connector changed: use deploy-assist-release.sh with a new build'
    assert hashlib.sha256((downloads / 'chloe-assist.exe').read_bytes()).hexdigest() == metadata['sha256']
    shutil.copytree(downloads, staging / 'web/downloads')
PY
  mv "$staging" "$release"
fi
# mktemp creates staging with mode 0700. Nginx workers must be able to
# traverse the immutable release directory to serve its public web/ files.
chmod 755 "$release"
[[ -f "$release/web/version.json" ]] || printf '{"frontendSha":"%s"}\n' "$sha" > "$release/web/version.json"
node --check "$release/backend/server.js"
node --check "$release/backend/chat-service.js"

dropin=/etc/systemd/system/witt.service.d/10-release.conf
nginxconf=/etc/nginx/snippets/witt-live.conf
old_dropin="$(mktemp)"
old_nginx="$(mktemp)"
cp "$dropin" "$old_dropin"
cp "$nginxconf" "$old_nginx"
rollback() {
  trap - ERR
  cp "$old_dropin" "$dropin"
  cp "$old_nginx" "$nginxconf"
  systemctl daemon-reload
  nginx -t
  systemctl restart witt.service
  systemctl reload nginx
  echo "deployment failed; previous release restored" >&2
}
trap rollback ERR

cat > "$dropin" <<EOF
[Service]
WorkingDirectory=$release
ExecStart=
ExecStart=/usr/local/bin/node $release/backend/server.js
Environment=WITT_DEPLOY_SHA=$sha
EOF
python3 - "$nginxconf" "$release" <<'PY'
import re
import sys
from pathlib import Path
p = Path(sys.argv[1])
release = sys.argv[2]
s = p.read_text()
pattern = r'alias /opt/witt/\.git/witt-releases/[0-9a-f]{40}/web/;'
updated, count = re.subn(pattern, 'alias ' + release + '/web/;', s)
if count != 1:
    raise SystemExit('unexpected Witt static alias')
p.write_text(updated)
PY
nginx -t
systemctl daemon-reload
systemctl restart witt.service
systemctl reload nginx

for attempt in {1..20}; do
  backend="$(curl -fsS --max-time 4 http://127.0.0.1:3003/version 2>/dev/null || true)"
  frontend="$(curl -fsS --max-time 4 https://cpa.stellarbit.site/vault/version.json 2>/dev/null || true)"
  if [[ "$backend" == *"\"backendSha\":\"$sha\""* && "$frontend" == *"\"frontendSha\":\"$sha\""* ]] &&
     curl -fsS --max-time 4 http://127.0.0.1:3003/health >/dev/null; then
    rm -f "$old_dropin" "$old_nginx"
    trap - ERR
    echo "deployed $sha"
    if systemctl cat witt-worker.service >/dev/null 2>&1; then
      worker_exec="$(systemctl show --property=ExecStart --value witt-worker.service 2>/dev/null || true)"
      if [[ "$worker_exec" == *"$release/backend/worker-service.js"* ]]; then
        echo "Worker already uses snapshot $sha; it was left running."
      else
        echo "Worker remains on its current snapshot; it was left running. After its active tasks finish, run: $repo/scripts/upgrade-worker.sh $sha"
      fi
    else
      echo "Worker service is not installed; this web deployment did not install or start it."
    fi
    exit 0
  fi
  sleep 1
done
echo "version/health verification timed out" >&2
false
