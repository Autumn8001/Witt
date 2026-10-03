# Model harness validation — 2026-10-03

Scope: Grok models use Grok Build; GPT models use the existing Codex app-server harness. Gemini remains paused. Customer/device configuration expansion is deferred; existing drafts are preserved.

The automatic mapping already exists in production. This change rejects explicit model/harness mismatches and refuses to launch persisted mismatched sessions. It preserves existing session bindings and history. Switching harness families with existing runtime context still requires a new session or branch.

Validation:
- Syntax check passed.
- Capability/runtime targeted suite: 31/31 PASS.
- Backend regression suite: 139/139 PASS. Execution-boundary tests check Grok dispatch and Codex thread/start + turn/start with the original GPT model identifier; these use a fake Codex client and do not establish online GPT access.
- Separate DeepSeek/Codex executable test could not run because its fixed loopback port 33115 is occupied. No existing process was stopped.
- Grok online evidence from the preceding validation: actual Grok Build through CPA, including actual MCP calls, passed. No new online call was made for this routing-only change.
- GPT online: NOT TESTED. Production Codex profiles have no auth.json and the production service has neither CODEX_ACCESS_TOKEN nor OPENAI_API_KEY. Valid operator-provided Codex authentication is required; no login or credential transfer was performed.

Deployment: not performed. Production Backend and Web remain f40dfd757f7c234d7d4adf125f4df2e2d857f905; service active and local health ok. The remaining device/integration working-tree drafts prevent deployment under the required clean-worktree policy.
