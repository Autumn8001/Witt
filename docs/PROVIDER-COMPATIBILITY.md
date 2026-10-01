# Provider compatibility

Only rows backed by an actual test are marked PASS. Nothing here is inferred
from a successful chat completion alone.

Environment: server `ser918228796695`, CPA on `127.0.0.1:8317`, Sub2API on
`127.0.0.1:8080`, Grok Build 1.0.44, 2026-09-30.

## Matrix

| Harness | Provider | Protocol | Chat | Stream | Tools | Resume | Sticky | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Grok Build | CPA | `openai-responses` | PASS | PASS | PASS | PASS | not researched | PASS |
| Grok Build | CPA | `openai-chat-completions` | PASS | PASS | NOT TESTED | n/a | not researched | partial |
| Grok Build | CPA | `anthropic-messages` | PASS | NOT TESTED | NOT TESTED | n/a | not researched | partial |
| Codex | — | — | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | — | NOT TESTED |
| Antigravity | — | `gemini-native` | BLOCKED | BLOCKED | BLOCKED | BLOCKED | — | BLOCKED (runtime) |
| DeepSeek (Codex) | local adapter | `openai-responses` | unit only | unit only | NOT TESTED | NOT TESTED | — | NOT TESTED |

## CPA

- `GET /v1/models` → 200, 16 models including `grok-4.7-{high,medium,max,xhigh}`
  and `gemini-3.8-flash-high`. Requires the gateway key.
- `POST /v1/chat/completions` → 200 with real `grok-4.7` content and
  `reasoning_content`.
- `POST /v1/responses` → 200, Responses-shaped object. This is the backend Grok
  Build uses (`api_backend = "responses"`).
- `POST /v1/messages` → 200, Anthropic Messages shape with thinking blocks.
- SSE streaming on `/v1/chat/completions` works with `stream: true`.
- Health: `/healthz` → 200. `/health` → **404**, do not monitor it.

Tool calling and MCP were verified end to end through Grok Build (see
`docs/HARNESS-RUNTIME.md`). CPA's own tool-call translation was exercised as part
of that path, but was not isolated with a separate protocol-level fixture.

## Sub2API

- `GET /v1/models` without a key → 401. With the CPA key → 0 models, so Sub2API
  uses its own credential, which is not present in this environment.
- Health: `/health` → 200. `/healthz` returns 200 HTML from the SPA for unknown
  paths, so it is a false positive and must not be used.
- Secret: the registry reports `Missing` because no `WITT_SUB2API_API_KEY` is
  configured. Nothing was fabricated to make it look healthy.

## Protocol selection

Each provider records a protocol, and the resolver picks the harness. A provider
that discovers a Grok model does not become a harness; the harness is decided
separately by `RuntimeResolver`.

| Model prefix | Harness |
| --- | --- |
| `grok-*` | `grok-build` |
| `gemini-*` | `google-antigravity` |
| `gpt-*`, `deepseek-*`, unknown | `codex` |

## Sticky sessions

CPA exposes credential pools, concurrency limits and in-flight credential
tracking. Whether a given route pins one upstream account for the life of a
harness session was **not** investigated in this pass, so no affinity claim is
made and Witt adds no account hashing. This is deferred to the next stage.
