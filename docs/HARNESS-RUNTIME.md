# Harness runtime

Witt talks to each harness through an adapter that hides the process protocol.
The adapter layer lives in `backend/runtime/`.

## Verified runtimes

| Harness id | UI label | Binary | Version | Verified |
| --- | --- | --- | --- | --- |
| `codex` | Codex | `codex` (not installed on this host) | — | NOT TESTED |
| `grok-build` | Grok Build | `/root/.local/bin/grok` | 1.0.44 | live, 2026-09-30 |
| `google-antigravity` | Gemini | `/root/.local/bin/agy` | 1.2.14 | BLOCKED (CPU) |

## Grok Build adapter

`backend/runtime/grok-build-adapter.js` drives the official CLI headlessly:

```
grok -p <prompt> --model <model> --output-format streaming-json \
     --no-auto-update --cwd <cwd> [--session-id <uuid> | --resume <id>] \
     [--reasoning-effort <level>] [--permission-mode <mode>] [--max-turns N]
```

A turn is one child process. `streaming-json` is NDJSON derived from the agent's
ACP session updates; `end` is always last and carries `sessionId`.

### Event mapping

| Harness event | Normalised | Notes |
| --- | --- | --- |
| `text` | `text_delta` | assistant text chunk |
| `thought` | `reasoning_delta` | reasoning chunk |
| `tool_call` | `tool_call` | `toolCallId`, `toolName`, `rawInput` |
| `tool_call_update` | `tool_call_update` | `status`, `rawOutput` |
| `plan` | `plan` | `entries` |
| `available_commands` | `commands` | advertised tools and slash commands |
| `usage` | `usage` | per-response boundary |
| `end` | `end` | `sessionId`, `stopReason`, `usage`, `modelUsage` |
| `error` | `error` | message |
| anything else | `notice` | the documented list is non-exhaustive |

### Capabilities (observed, not assumed)

`sessions`, `resume`, `fork`(unverified), `compact`, `mcp`, `shell`, `files`,
`subagents`, `skills`, `hooks`, `reasoning_levels`, `images`, `streaming`,
`cancel`, `tools`, `model_selection` are true where tested.
`review` is **false** (no review command is advertised) and `approvals` is
**false** (headless uses permission modes, there is no interactive round trip).
Unverified entries are the string `"unknown"`, never `true`.

### Session binding

The adapter passes a caller-supplied UUID as `--session-id` for a new session and
`--resume <id>` for later turns. Witt stores the returned id in
`conversation.harnessSessionId`, which is what makes a turn survive a Witt
backend restart: the CLI keeps the transcript under `~/.grok/sessions`.

## Antigravity adapter

`backend/runtime/antigravity-adapter.js` implements the documented surface
(`-p`, `--output-format stream-json`, `--conversation <id>`, `--continue`,
`--effort`, `--dangerously-skip-permissions`, `--input-format stream-json` for a
single stdin-driven process) and a tolerant NDJSON parser for the
`init` → `step_update` → `result` stream.

The official 1.2.14 binary **cannot execute on this host**: it is compiled with
pclmul enabled and aborts with SIGILL because the QEMU vCPU has no `pclmulqdq`.
The adapter detects this precisely and reports `runtime_incompatible` plus the
missing CPU feature instead of a generic failure. Its capabilities are therefore
`"unknown"` where behaviour was never observed.

## Crash isolation

`backend/runtime/harness-process.js` never throws into the backend. A missing
binary, a crash, a hang, and malformed output all settle into an exit summary
(`ok`, `errorType`, `signal`, `timedOut`, bounded `stderr`). Witt maps that onto
the turn status, so a dead runtime fails one turn and leaves the process serving.

## Logging

`backend/runtime/runtime-log.js` emits one JSON line per event with harness,
session id, provider, model, event type, duration and error type. Secrets and
credential-shaped tokens are scrubbed before they can reach a sink.
