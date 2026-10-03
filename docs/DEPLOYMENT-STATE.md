# Production deployment state

Checked: 2026-10-02 14:44 UTC. Production host: ser918228796695; repository: /opt/witt; branch: platform/personal-ai-ops.

## Starting condition

- Git HEAD and origin/product branch: ff0a16b4572a6148c79d59613f69f4be64b0649b.
- Worktree: 13 tracked modifications and 7 untracked files.
- witt.service started at 07:29 UTC, before current backend edits.
- Nginx served /opt/witt/web directly. Public HTML and JS therefore reflected uncommitted files while Node retained its earlier loaded code.
- The current backend process did not expose an embedded build SHA, so its exact Git SHA could not be proven from the process alone.
- The current API did not contain the uncommitted development delivery routes; those routes existed only in the edited server.js source.

## Containment applied

- A release snapshot was extracted from Git HEAD into /opt/witt/.git/witt-releases/ff0a16b4572a6148c79d59613f69f4be64b0649b.
- Both systemd ExecStart and Nginx static alias now point to that same immutable release snapshot.
- Node syntax checks and nginx configuration test passed. witt.service restarted at 14:44 UTC. Local /health and public /vault/index.html returned HTTP 200.
- The source worktree and its uncommitted files were preserved; Nginx no longer serves that worktree.
- Backend and frontend currently come from the same committed source SHA: ff0a16b4572a6148c79d59613f69f4be64b0649b.

## Next release rule

Build a new release snapshot only from a clean, committed, origin-pushed product branch SHA. Check syntax and tests before switching both systemd and Nginx to that same snapshot. Verify local health, public HTTPS, static file hashes, and deployed SHA after restart. Keep the previous release directory for rollback. Never serve /opt/witt/web directly again.

The proposed /version API and static version.json are not yet part of this release; they must be validated with the next committed release.

## First release attempt after convergence

Commit `57b4e21a916938a5523bff8f0f0b9493a38cde41` was pushed. Its first release attempt failed version verification and automatically restored `ff0a16b`; the service remained healthy. Root cause: `mktemp -d` created the staging directory with mode 0700, and the Nginx worker could not traverse the moved release directory. The deployment script now sets the release directory to 0755 before switching Nginx. The source tree and root-only runtime configuration were not exposed by this change; only `web/` is aliased publicly.
