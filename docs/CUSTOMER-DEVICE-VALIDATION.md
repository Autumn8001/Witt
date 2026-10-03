# Customer Device MVP validation

Validated on 2026-10-03. This feature is intentionally narrow: Witt can list a
configured customer computer and request the allowlisted `hostname` operation.
It does not provide a general-purpose remote shell.

## Implemented

- A native Go agent with token-file authentication, TLS WebSocket transport,
  heartbeat, bounded reconnect, replacement handling and clean cancellation.
- A same-process Device Gateway with per-device token hashes, online/offline
  state, one in-flight command per device, no command replay, timeouts and a
  combined 256 KiB output limit.
- Administrator-only device list/get/hostname HTTP routes and loopback-only MCP
  routes. Forwarded requests cannot use the internal routes.
- A mobile-responsive Devices panel and a gated Remote Device MCP bridge. MCP
  calls remain disabled unless `WITT_REMOTE_DEVICE_MCP_ENABLED=1` is explicitly
  supplied to the Grok child.
- Deployment installs the locked production `ws` dependency inside each
  immutable release.

## Automated evidence

- Gateway unit/integration suite: 9/9 pass.
- Native Linux Go Agent through real TLS/WSS, browser UI, HTTP routes and all
  three MCP operations: pass, and the test exits without leaving a process.
- Optional live Grok Adapter → MCP → Gateway → TLS/WSS → native Linux Agent:
  pass in the isolated fixture when existing CPA authentication is injected.
- Go tests and vet: pass. Windows amd64 cross-build: pass.
- The browser fixture checks 390×844 portrait and 844×390 landscape layouts
  without horizontal overflow.

No token, private key or provider credential is stored in this repository.
Production device definitions belong in `/root/.witt/devices.json`; each entry
contains only metadata and a SHA-256 token hash.

## Deliberate remaining field acceptance

Real Windows hardware has not been supplied, so Windows installation, public
production WSS and production Grok → Windows hostname remain **NOT TESTED**.
Before enabling the MCP gate, provision a private per-device token, install the
agent on the target PC and follow `agent/windows/README.md`. Cross-compilation
and the Linux native fixture do not replace that field check.
