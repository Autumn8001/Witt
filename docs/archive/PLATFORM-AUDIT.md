# Platform audit

Baseline upstream SHA: `69b91aad1c5621199d5dc0ec486a5299c906ad37`
Audit host: Windows, Node.js 24.9.0. This is a source audit plus the upstream test suite. It is not a live Codex, Grok, Gemini, CPA, or server deployment test.

## 1. Current Witt architecture

Witt is a mobile-first shell around one Codex App Server process per user scope.

- `web/` is a static HTML, CSS, and JavaScript UI. `web/app.js` renders chat, approvals, artifacts, and settings. `web/browser-bridge.js` is the standalone browser transport.
- `backend/server.js` is the loopback HTTP API: auth, files, tasks, Codex account login, and chat routing.
- `backend/chat-service.js` owns conversations, SQLite history, uploads, artifacts, approvals, and the Codex turn lifecycle.
- `backend/app-server-client.js` speaks JSON-RPC over stdio to `codex app-server`.
- `backend/sqlite-store.js` persists conversations. `backend/auth-service.js` owns invite codes and device credentials.
- `android/` is a WebView shell plus a native SSH terminal. SSH credentials stay in Android Keystore and do not pass through the Node API.
- `deploy/` contains example systemd units and an Nginx site. They are templates, not a live configuration.

## 2. Codex coupling

Codex is hard-wired in these places:

- Process spawn: `codex app-server --listen stdio://`, `CODEX_HOME`, and profile directories under `/home/ubuntu/.codex*`.
- Session identity: `conversation.codexThreadId` and `conversation.codexProfile`.
- Turn protocol: `thread/start`, `thread/resume`, `thread/fork`, `thread/compact/start`, `turn/start`, `review/start`, and approval requests.
- Model policy: admin and non-admin GPT model sets, plus a DeepSeek path that still runs through Codex with a local Responses adapter.
- UI labels and capability panel: "CODEX RUNTIME" and actions that require `hasCodexContext`.

## 3. UI and Codex event coupling

`chat-service.js` translates App Server notifications into a stable stream: plans, commands, file diffs, messages, reviews, and approvals. The web UI renders that stream. It does not talk to Codex directly. The browser bridge already hides the transport, so a second harness can reuse the same event shape if its adapter emits it.

## 4. Keep as-is

Auth, device credentials, SQLite history, artifacts, attachment storage, approval cards, Android WebView, Android SSH, and the visual system should stay. They are not Codex-specific.

## 5. Abstract

Runtime selection, process lifecycle, session binding, model discovery, and provider endpoints need a boundary. The first cut lives in `backend/runtime/`. Codex behavior still goes through `AppServerClient`; the adapter is a wrapper, not a rewrite.

## 6. Do not rewrite

Do not replace the chat UI, Android app, approval interaction, artifact sandbox, or auth flow. Do not put a new LLM gateway in front of CPA or Sub2API.

## 7. Baseline tests

Recorded before product code changes, on this Windows host:

| Check | Result |
| --- | --- |
| `node --check` on backend sources | PASS |
| chat history, improvements, isolation | PASS |
| DeepSeek adapter unit test | PASS |
| sqlite store and coalescing | PASS |
| auth, images, approval, browser session, SSE | PASS |
| `backend/test-workspace-overview.js` | BASELINE FAILURE: Linux `os.networkInterfaces` assumption, `status` of undefined |
| `tests/app-server-capabilities-check.cjs` | BASELINE FAILURE: `/home/ubuntu/.local/bin/codex` missing |
| `backend/test-deepseek-codex.js` | NOT RUN: requires the same Linux Codex binary |
| `tests/ui-check.mjs` | BASELINE FAILURE: `playwright` is not installed |

These failures are environment gaps. They were not patched and are not product regressions.

## 8. Deployment

The API binds to `127.0.0.1`. Nginx is expected to terminate HTTPS and proxy `/vault-api/`. No deployment change was made during this audit. Existing CPA, Sub2API, Open WebUI, Postgres, Redis, Docker, and Nginx services must be inspected before any reload.

## 9. Security boundary

Device tokens and provider secrets stay on the server. Provider list responses expose `Configured` or `Missing`, never the secret value. Secrets are rejected in provider URLs. Android SSH passwords remain outside this API. This audit did not inspect the production host.
