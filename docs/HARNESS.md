# Harness state

Witt-Autumn keeps the original Codex App Server path. Grok Build is the only external Harness on the production path.

| Choice | Execution | Production state |
| --- | --- | --- |
| Codex | Original Witt App Server client in ChatService | CLI installed; local authentication unavailable, so live turns are blocked. Existing API and unit tests remain. |
| Grok Build | GrokBuildAdapter starts the Grok CLI, parses streaming JSON, and sends normalized events to ChatService | Verified previously through Witt, CPA and a real model, including resume, cancel, tools and MCP. New development delivery needs its own acceptance. |
| Gemini / Antigravity | Adapter retained outside the production load path | Unavailable: this server CPU lacks the instruction required by the published binary. It is disabled in the UI. |

The production selector chooses the existing Codex path or GrokBuildAdapter. Runtime Manager and other adapters remain compatibility/experimental code and are loaded lazily. No runtime is made available merely because an adapter file exists.

The Grok CLI uses the server-side CPA configuration. Headless Grok does not offer Witt interactive tool approval; its permission mode controls tool access. Witt never exposes the provider key to the browser.

See [ARCHITECTURE.md](ARCHITECTURE.md) for request flow and [KNOWN-ISSUES.md](KNOWN-ISSUES.md) for current blockers.
