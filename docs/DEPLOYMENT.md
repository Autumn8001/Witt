# Witt-Autumn deployment

Production repository: `/opt/witt`, branch `platform/personal-ai-ops`. The only permitted remote for the product workflow is `git@github-witt-autumn:Autumn8001/Witt.git`. Do not change or push `main` or `upstream`.

## Release rule

1. Confirm the product branch, review the exact Diff, run the stated tests, and obtain explicit user confirmation for commit/push.
2. Commit and push the product branch. Confirm the local and origin SHA match and the worktree is clean.
3. Obtain a separate deployment confirmation. `scripts/deploy-commit.sh <full-SHA>` verifies branch, origin, SHA and clean worktree, creates a Git archive release under `/opt/witt/.git/witt-releases/<SHA>`, and generates a static `web/version.json`.
4. The script points both `witt.service` and Nginx `/vault/` at that same snapshot, restarts Witt and verifies local health plus backend/frontend SHA. The previous release remains available for rollback.
5. The phone workflow schedules this script in an independent transient systemd unit after a short delay. The Node process can restart without losing its task record; recovery verifies both SHAs.

The source worktree must never be served directly by Nginx. The runtime drop-in is `/etc/systemd/system/witt.service.d/10-release.conf`; the Nginx location is `/etc/nginx/snippets/witt-live.conf`. Root-only environment and CPA configuration stay outside Git.

## Checks

```sh
git -C /opt/witt status --short --branch
git -C /opt/witt rev-parse HEAD
git -C /opt/witt ls-remote origin refs/heads/platform/personal-ai-ops
systemctl is-active witt.service
curl -fsS http://127.0.0.1:3003/health
curl -fsS http://127.0.0.1:3003/version
curl -fsS https://cpa.stellarbit.site/vault/version.json
curl -fsS https://cpa.stellarbit.site/vault-api/health
```

The two version responses must contain the same full SHA as local HEAD and origin. The current rollout history and any temporary mismatch are recorded in [DEPLOYMENT-STATE.md](DEPLOYMENT-STATE.md).

## Recovery

If a release fails, inspect the transient `witt-deploy-*` unit, `witt.service`, Nginx syntax and the two version endpoints. The deploy script restores the previous systemd/Nginx configuration on a detected failure. Keep the previous snapshot; choose a known good committed SHA for a deliberate rollback. Do not use `git reset --hard`, force push, or delete unrelated worktree changes.
