# Known issues

Open problems that are real and unresolved. Nothing here is hidden or softened.

## Blocking other harnesses

1. **Antigravity cannot run on this server (hardware).** The official `agy`
   1.2.14 binary is compiled with pclmul enabled and aborts with SIGILL:
   `This binary was compiled with pclmul enabled, but this feature is not
   available on this processor`. `/proc/cpuinfo` has no `pclmulqdq`; the CPU is
   `QEMU Virtual CPU version 2.5+`. The published manifest lists only 1.2.14, so
   there is no older build to fall back to. Resolving this needs either a host
   with the CPU feature or a build published without it. The adapter, its args
   and its NDJSON parser are implemented against the official docs, but every
   Antigravity capability stays `"unknown"` because nothing was observed.

2. **Codex is not installed.** `codex` is absent from the server, so the Codex
   adapter is unit-tested but has no live result. The upstream test
   `tests/app-server-capabilities-check.cjs` still fails for this reason; that
   failure predates this work and is not a regression.

## Security and deployment

3. **Open WebUI has no HTTPS hostname.** It is reachable in plaintext at
   `http://186.244.203.27:3000/`. Nginx has no `server_name` for it and the only
   certificate lineage covers `api.stellarbit.site` and `cpa.stellarbit.site`.
   The Server Center reports this honestly (`openWebuiTls: false`) and
   `OPEN_WEBUI_URL` is configuration, not a hardcoded value. Fixing it means
   adding a hostname, a certificate and a proxy block.

4. **Port 443 has no `default_server`.** An unknown `Host` falls through to the
   first vhost, which is Sub2API. A probe against a made-up hostname returns 200
   with Sub2API's HTML, which can be mistaken for another service being proxied.
   Not introduced by this work, and not fixed here because changing nginx is out
   of scope for this stage.

5. **Sub2API has no credential in this environment.** The registry reports it as
   `Missing`; its model discovery returns 0 models. No behaviour was faked.

6. **CPA's Grok client-version override is an operator workaround.** On
   2026-10-01, xAI rejected CPA's pinned `0.2.120` client header with HTTP 426.
   The auth metadata now overrides it with `1.0.44`, following upstream
   CLIProxyAPI issue #6249, and the pre-change files are backed up root-only.
   Token refresh preserves the metadata, but a fresh xAI login can drop it; the
   durable fix is a CPA release with an updated or configurable version header.

## Not yet investigated

7. **Sticky sessions / session affinity.** CPA's credential pool behaviour was
   not researched, so Witt deliberately adds no routing keys or account hashing.
8. **UI manual acceptance.** The workspace, profile selector, model selector,
   provider status, harness indicator, error states, Server Center and the Open
   WebUI entry have not been checked in a real browser at desktop and mobile
   widths. Playwright is not installed in this environment.
9. **Codex live regression.** The claim that the Codex harness is unaffected rests
   on unit tests and the upstream suite, not on a live Codex turn.

## Environment gaps in the local test run

These are recorded so a failure is never mistaken for a regression:

10. `backend/test-workspace-overview.js` assumes Linux `os.networkInterfaces`
   output and fails on the Windows development host. Pre-existing.
11. `tests/ui-check.mjs` needs `playwright`, which is not installed. Pre-existing.

## Fixed during this pass

- **Workspace root validation ignored the configured work directory.**
  `normalizeWorkDir` used a hardcoded allowlist, so a session could not be created
  at all on any host whose project directory lived elsewhere. Now configuration
  driven, fail-closed, and covered by `backend/test-workdir-roots.js`.
- **Unknown model strings were accepted when no model policy was set**, and only
  failed later inside the harness. Model catalog membership is now required.
- **The harness switch guard did not cover non-Codex sessions**, because it only
  looked at `codexThreadId`. It now covers `harnessSessionId` too, and an absent
  `harness` field means "resolve from the model" rather than "keep the current
  harness", which is what let a switch slip through.
- **A runtime that died on its own was reported as a user-requested pause.**
  Only an interrupt the session actually requested is treated as a pause now.
- **Provider health checks ignored `secret_ref`**, so CPA was reported degraded
  while it was in fact healthy.
- **Harness children inherited every backend environment variable.** They now
  receive only a minimal non-secret system environment plus the one provider
  secret explicitly bound for that adapter.
- **Grok ignored Witt's access mode.** `read-only`, `workspace-write`, and
  `danger-full-access` now map to `plan`, `acceptEdits`, and
  `bypassPermissions`; unknown modes fail closed to `plan`.
- **Raw harness stderr could reach browser responses.** It remains available to
  the redacting server logger but is no longer included in API/SSE errors.
- **Cancellation had no escalation path.** Runtime termination now sends
  SIGTERM and uses SIGKILL after a bounded grace period if the child remains.
- **Runtime profile model names drifted from the selectable catalog.** Grok and
  Gemini profiles now use the same `-high` model IDs as the model catalog.
