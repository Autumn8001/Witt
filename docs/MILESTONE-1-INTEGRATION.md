# Milestone 1 integration log

Living record for the live-runtime pass. Status values are only PASS, FAIL, NOT TESTED, UNSUPPORTED, or BLOCKED_CREDENTIAL. Code existing is not PASS.

Starting product SHA: `332036eb515e6f6d237b04cec9ef39bb715c3b07`
Branch: `platform/personal-ai-ops`
Private main remains the Witt baseline and is not a product branch.

## Log

| When | Area | Action | Result |
| --- | --- | --- | --- |
| takeover | git | HEAD `332036e` matched `origin/platform/personal-ai-ops`; inherited Runtime, test, docs and script changes were uncommitted and preserved. Remotes were correct; product `main` remained `69b91aad` while `upstream/main` had advanced by one commit | PASS |
| A | server | Read-only inventory: Ubuntu 24.04.1, x86_64, QEMU vCPU, 4 cores. Docker: `open-webui` (0.0.0.0:3000, healthy), `cli-proxy-api`/CPA (127.0.0.1:8317), `sub2api` (127.0.0.1:8080, healthy), `sub2api-redis`, `sub2api-postgres`. Nginx on 443 for `api.stellarbit.site` and `cpa.stellarbit.site` | PASS |
| A | egress | Server can reach `x.ai`, `antigravity.google`, and npm. No node/npm/unzip present | PASS |
| A | Grok install | `x.ai/cli/install.sh` with `GROK_BIN_DIR=/root/.local/bin` | PASS: Grok 1.0.44 at `/root/.local/bin/grok` |
| B | Antigravity install | `antigravity.google/cli/install.sh` downloaded and SHA512-verified agy 1.2.14 | FAIL at exec: `pclmul enabled ... not available on this processor` |
| B | Antigravity diagnosis | `/proc/cpuinfo` has no `pclmulqdq`; CPU is `QEMU Virtual CPU version 2.5+`. Published manifest lists only 1.2.14, so no older build to fall back to | BLOCKED_RUNTIME_INCOMPATIBLE |
| D | CPA protocols | Live probes with the gateway key read server-side: `/v1/models` 200, `/v1/chat/completions` 200, `/v1/responses` 200, `/v1/messages` 200, SSE streaming works. Real `grok-4.7` answers with `reasoning_content` | PASS |
| A3 | Grok to CPA | `[model_providers.witt-cpa] base_url=http://127.0.0.1:8317/v1 api_backend=responses`; key from root-only `/root/.witt/cpa.env` via `env_key`, never printed | PASS |
| A4 | T-GROK-01/02/03 | Live headless `grok -p ... --output-format streaming-json` through CPA. Real `thought`, `text`, `usage`, `end` events; `modelUsage.grok-4.7`; exit 0 | PASS |
| A4 | T-GROK-04/05/06 | New session with fixed UUID returned `sessionId`. A separate later process using `-r <sid>` recalled codeword `ZEPHYR-9`, proving cross-process resume | PASS |
| A4 | T-GROK-07 (cancel) | SIGTERM during a long run: exit 143, 20751 bytes of stream consumed before cancel, no hang | PASS |
| A4 | T-GROK-08 | Invalid model: exit 1 with controlled `{"type":"error","message":"Couldn't set model ... unknown model id"}` | PASS |
| A5 | Built-in tool | `read_file` tool call with `rawInput.target_file`, `tool_call_update` completed carrying file content, final text contained `WITT_FILE_TOKEN_42` | PASS |
| A5 | MCP | Registered local stdio MCP server `wittprobe`. `search_tool` discovered `wittprobe__witt_ping`; `use_tool` returned `{"OkayOutput":"WITT_MCP_OK"}`; Grok continued and answered `WITT_MCP_OK` | PASS |
| fix | workdir | Root cause: `normalizeWorkDir` had a hardcoded allowlist `["/home/ubuntu", "/data/drop-vault", "/data/xuanyu-build-console"]` and never read `DROP_VAULT_CODEX_WORKDIR`, so no session could be created at `/root/witt-grok-work` | FIXED |
| E2E | Witt to Grok | Live run through the Witt HTTP API on the server, 27 checks | 27/27 PASS |
| 2026-10-01 outage | CPA to xAI | xAI raised its minimum Grok client version. CPA v8.0.7 still sent `x-grok-client-version: 0.2.120`, so both direct CPA protocols and Witt failed with HTTP 426 although Grok Build itself was 1.0.44 | FAIL, ROOT CAUSE CONFIRMED |
| 2026-10-01 recovery | CPA auth metadata | Applied the upstream-documented per-auth header override (`1.0.44`) after a root-only backup. No token values were printed or changed. Direct CPA smoke returned 200, then Witt live E2E returned 27/27 PASS | PASS |
| hardening | Runtime isolation | Harness children receive a minimal system environment plus the explicitly bound provider secret; access modes map to safe Grok permission modes; cancellation escalates after a grace period; raw stderr is no longer returned to browser/SSE clients | PASS (unit + live regression) |

## Live end-to-end result (Witt backend -> Grok Build -> CPA -> Grok 4.7)

Run on the server with the real backend, real CLI and real gateway.

| ID | Check | Result |
| --- | --- | --- |
| T-WITT-00 | backend boots | PASS |
| T-WITT-02 | harness inventory (grok installed, agy present) | PASS |
| T-WITT-03 | grok binary resolved | PASS |
| T-WITT-05 | providers expose protocol and secret state | PASS |
| T-WITT-06 | CPA health + discovery (16 models) | PASS |
| T-WITT-07 | Server Center real metrics (4 vCPU, mem, disk 30%, uptime) | PASS |
| T-WITT-08 | real service health (witt, open-webui, cpa, sub2api) | PASS |
| T-WITT-09 | Open WebUI entry present | PASS |
| T-GROK-11 | Witt creates a Grok session bound to `grok-build` | PASS |
| T-GROK-12 | real prompt through Witt, answered | PASS |
| T-GROK-13 | streaming events persisted | PASS |
| T-GROK-14 | `harness_session_id` persisted | PASS |
| T-GROK-15 | second turn keeps context (recalled codeword) | PASS |
| T-GROK-15b | session id stable across turns | PASS |
| T-GROK-16 | resume after a full backend restart | PASS |
| T-GROK-17 | cancel / abort | PASS |
| T-GROK-18 | invalid model rejected at the API | PASS |
| T-GROK-19 | runtime killed externally: turn fails, backend survives | PASS |
| T-GROK-20a | no secret in API or SSE responses | PASS |
| T-GROK-20b | no secret in the backend log | PASS |
| T-GROK-21 | harness switch refused on a bound session (409) | PASS |
| T-GROK-22 | structured `[runtime]` logs with session, model, events | PASS |
| T-MCP-01 | MCP tool discovered through Witt | PASS |
| T-MCP-02 | MCP tool called through Witt | PASS |
| T-MCP-03 | MCP result reached the model (`WITT_MCP_OK`) | PASS |

The backend was stopped after the run and port 3003 was released.
