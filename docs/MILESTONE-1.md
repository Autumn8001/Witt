# Milestone 1 status

This is the honest status after the first implementation pass. It is not a claim that every production acceptance item passed.

## Repository

| Item | Value |
| --- | --- |
| Private repository | https://github.com/Autumn8001/Witt |
| Visibility | PRIVATE |
| Origin | https://github.com/Autumn8001/Witt.git |
| Upstream | https://github.com/LeoWilson-Ben/witt.git |
| Baseline upstream SHA | `69b91aad1c5621199d5dc0ec486a5299c906ad37` |
| Private main SHA | `69b91aad1c5621199d5dc0ec486a5299c906ad37` |
| Platform branch | `platform/personal-ai-ops` |
| Product HEAD | see `git rev-parse platform/personal-ai-ops` |

`main` was not used for product commits. The private repository already contained a one-line generated README. That unrelated initial commit was replaced by the Witt history. The replacement was force-pushed once, before product work.

## What is implemented

- Harness ids: `codex`, `grok-build`, `google-antigravity`.
- `RuntimeResolver`: `gpt-*` and `deepseek-*` and unknown models resolve to Codex. `grok-*` resolves to Grok Build. `gemini-*` resolves to Google Antigravity.
- Session settings reject a silent harness migration once `codexThreadId` exists. The API returns HTTP 409 and tells the client to start or branch a session.
- Provider registry stores protocol, health, and a secret reference. List responses do not include secret values.
- Runtime profiles: Grok Main, Gemini Fast, Codex Default. UI harness selection defaults to Auto.
- Server Center reads local CPU, memory, uptime, and optional HTTP health URLs. Open WebUI is linked only from `OPEN_WEBUI_URL`.

## What is not implemented

- Grok Build has no official ACP or headless runtime wired on this host. Its adapter refuses to start. Computer Use is not a fallback.
- Google Antigravity is not installed or authenticated here. Its adapter refuses to start. Capabilities that were not observed are false.
- CPA and Sub2API were not called. No tool-call, streaming, or sticky-session proof exists.
- Remote Device, Device Gateway, and Remote MCP are milestone 2 and were not started.
- No production Nginx, systemd, Docker, or database change was made.

## Verification

`backend/test-runtime-layer.js` passed. The upstream suite that passed before the change still passed after it. Environment failures that existed before the change remain: workspace overview on Windows, missing `/home/ubuntu/.local/bin/codex`, and missing Playwright. They are baseline failures, not new regressions.

Live Codex, Grok, Gemini, CPA, Sub2API, and Open WebUI flows are NOT TESTED.
