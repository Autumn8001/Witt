# Witt-Autumn architecture

The product uses the original Witt authentication, conversation, file, approval, artifact and Android foundations. It runs one Node backend and a static Web UI behind the existing Nginx HTTPS host.

```text
Mobile browser / Android WebView
  -> Nginx /vault/ (Git release snapshot)
  -> Nginx /vault-api/ -> witt.service (same Git release snapshot)
       -> Auth and SQLite conversation store
       -> ChatService: conversation, queue, persistence, SSE
            -> existing Codex App Server path
            -> GrokBuildAdapter -> Grok CLI -> CPA -> model
       -> Provider Registry: CPA/Sub2API config, health, model discovery
       -> Server Center: read-only host/service overview
       -> Device Gateway -> authenticated Windows Agents
            -> system metadata, allowlisted files, optional screen capture
  -> Open WebUI: external link to an independent service
```

## Workspace and development delivery

ChatService owns the Witt conversation and its stream records. GrokBuildAdapter owns Grok process startup, streaming JSON parsing, session resume, tool-event translation and cancellation. A Git collector captures the status at turn start and the changes produced during that turn; preexisting edits are not eligible for automatic delivery.

The delivery route lives in `backend/routes/development.js`; its fixed-scope implementation lives in `backend/development-workflow.js`. The user reviews the Diff, starts tests, separately confirms exact-file commit/push, then separately confirms optional deployment. The workflow targets only `/opt/witt`, the product branch and the repository-specific origin. State is stored under `/opt/witt/.git/witt-development-jobs`; it is not a general CI system.

## Other components

- Provider Registry stores metadata in `providers.json` and resolves secret references on the server. It does not proxy model requests, translate protocols or implement sticky routing.
- Runtime Profiles are small in-memory presets. They do not create independent sessions or processes.
- Server Center reads CPU, memory, disk, uptime and selected HTTP, Docker and systemd states. It has no server write operations.
- Open WebUI, CPA and Sub2API are preexisting independent services. Witt does not modify their source.
- Remote Device is a separate, administrator-only control path. Its Gateway
  negotiates fixed capabilities with each authenticated Windows Agent and never
  accepts an arbitrary shell command. The current MVP exposes system metadata,
  allowlisted text-file browsing and optional screen capture through both the
  mobile workbench and the gated Grok MCP bridge. Existing account-device
  management and the Android local SSH terminal remain different features.

The existing Codex path is intentionally preserved. The unused Runtime Manager and unavailable Antigravity Adapter are not loaded by the production selector. See [HARNESS.md](HARNESS.md), [DEPLOYMENT.md](DEPLOYMENT.md), and [KNOWN-ISSUES.md](KNOWN-ISSUES.md).
