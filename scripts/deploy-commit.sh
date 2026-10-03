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

releases="$repo/.git/witt-releases"
release="$releases/$sha"
mkdir -p "$releases"
if [[ ! -d "$release" ]]; then
  staging="$(mktemp -d "$releases/.new-$sha-XXXXXXXX")"
  git archive "$sha" | tar -xf - -C "$staging"
  printf '{"frontendSha":"%s"}\n' "$sha" > "$staging/web/version.json"
  node --check "$staging/backend/server.js"
  node --check "$staging/backend/chat-service.js"
  mv "$staging" "$release"
fi
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
    exit 0
  fi
  sleep 1
done
echo "version/health verification timed out" >&2
false
