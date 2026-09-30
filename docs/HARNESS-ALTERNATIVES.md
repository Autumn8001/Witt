# Harness alternatives

These runtimes are recorded only. They are not production harnesses.

| Name | Status | Current route |
| --- | --- | --- |
| DeepSeek Harness | Not in production | `deepseek-*` resolves to Codex as a best-effort fallback |
| OpenCode | Not in production | No adapter is registered |

Production harnesses are `codex`, `grok-build`, and `google-antigravity`.
Codex is the default and the fallback. Grok models resolve to Grok Build.
Gemini models resolve to Google Antigravity, which the UI may label Gemini.
