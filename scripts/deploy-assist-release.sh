#!/usr/bin/env bash
# Publish a reviewed Git snapshot + separately built Windows artifact. No env
# provisioning, model remapping, worker restart or production-branch push.
set -Eeuo pipefail
sha="${1:-}"
binary_hash="${2:-}"
[[ "$sha" =~ ^[0-9a-f]{40}$ && "$binary_hash" =~ ^[0-9a-f]{64}$ ]] || exit 2
repo=/opt/witt
release="$repo/.git/witt-releases/$sha"
binary="/tmp/chloe-assist-$sha.exe"
[[ -f "$binary" ]] || exit 2
printf '%s  %s\n' "$binary_hash" "$binary" | sha256sum -c -
cd "$repo"
git cat-file -e "$sha^{commit}"
previous="$(systemctl show witt.service -p WorkingDirectory --value)"
[[ "$previous" =~ ^/opt/witt/\.git/witt-releases/[0-9a-f]{40}$ ]] || exit 2
git merge-base --is-ancestor "${previous##*/}" "$sha"
[[ ! -e "$release" ]] || { echo 'Release already exists; inspect it before retrying' >&2; exit 2; }
staging="$(mktemp -d "$repo/.git/witt-releases/.assist-$sha-XXXXXXXX")"
git archive "$sha" | tar -xf - -C "$staging"
printf '{"frontendSha":"%s"}\n' "$sha" > "$staging/web/version.json"
node --check "$staging/backend/server.js"
node --check "$staging/web/remote-assist.js"
(cd "$staging/backend" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
mkdir -p "$staging/web/downloads"
install -m 0644 "$binary" "$staging/web/downloads/chloe-assist.exe"
printf '%s  chloe-assist.exe\n' "$binary_hash" > "$staging/web/downloads/SHA256SUMS.txt"
chmod 0755 "$staging"
mv "$staging" "$release"
backup="$(mktemp -d "$repo/.git/assist-deploy-backup-XXXXXXXX")"
dropin=/etc/systemd/system/witt.service.d/10-release.conf
nginxconf=/etc/nginx/snippets/witt-live.conf
cp "$dropin" "$backup/service.conf"
cp "$nginxconf" "$backup/nginx.conf"
rollback() {
 trap - ERR
 cp "$backup/service.conf" "$dropin"
 cp "$backup/nginx.conf" "$nginxconf"
 systemctl daemon-reload
 nginx -t
 systemctl restart witt.service
 systemctl reload nginx
 echo "Deployment failed; restored $previous; backups: $backup" >&2
}
trap rollback ERR
cat > "$dropin" <<EOF
[Service]
WorkingDirectory=$release
ExecStart=
ExecStart=/usr/local/bin/node $release/backend/server.js
Environment=WITT_DEPLOY_SHA=$sha
EOF
python3 - "$nginxconf" "$previous" "$release" <<'PY'
import sys
from pathlib import Path
p=Path(sys.argv[1]);text=p.read_text();old='alias '+sys.argv[2]+'/web/;'
assert text.count(old)==1, 'Unexpected static alias; aborting'
p.write_text(text.replace(old,'alias '+sys.argv[3]+'/web/;'))
PY
nginx -t
systemctl daemon-reload
systemctl restart witt.service
systemctl reload nginx
for attempt in {1..20}; do
 if curl -fsS --max-time 4 http://127.0.0.1:3003/health >/dev/null &&
    curl -fsS --max-time 4 http://127.0.0.1:3003/version | python3 -c 'import json,sys; assert json.load(sys.stdin)["backendSha"]==sys.argv[1]' "$sha" &&
    curl -fsS --max-time 4 https://cpa.stellarbit.site/vault/version.json | python3 -c 'import json,sys; assert json.load(sys.stdin)["frontendSha"]==sys.argv[1]' "$sha"; then
  trap - ERR
  echo "Deployed $sha; Windows SHA256=$binary_hash; rollback files=$backup"
  exit 0
 fi
 sleep 1
done
echo 'Health/version verification failed' >&2
false
