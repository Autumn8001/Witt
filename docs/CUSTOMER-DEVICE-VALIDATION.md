# Customer Device MVP validation

Updated on 2026-10-04. This feature is intentionally narrow: Witt can inspect a
configured customer computer through fixed read-only operations. It does not
provide a general-purpose remote shell.

## Implemented

- A native Go agent with token-file authentication, TLS WebSocket transport,
  heartbeat, bounded reconnect, replacement handling and clean cancellation.
- A same-process Device Gateway with per-device token hashes, online/offline
  state, one in-flight command per device, no command replay, timeouts and a
  combined 256 KiB output limit.
- Administrator-only routes for device status, system information, allowlisted
  file listing/reading and JPEG screen capture, plus loopback-only MCP routes.
  Forwarded requests cannot use the internal routes.
- A dedicated mobile-responsive customer-computer workbench and a gated Remote Device MCP bridge. MCP
  calls remain disabled unless `WITT_REMOTE_DEVICE_MCP_ENABLED=1` is explicitly
  supplied to the Grok child.
- Deployment installs the locked production `ws` dependency inside each
  immutable release.

## Automated evidence

- Gateway and MCP unit/integration suite: 14/14 pass.
- Native Linux Go Agent through real TLS/WSS, browser UI, HTTP routes and all
  three MCP operations: pass, and the test exits without leaving a process.
- Optional live Grok Adapter → MCP → Gateway → TLS/WSS → native Linux Agent:
  pass in the isolated fixture when existing CPA authentication is injected.
- Go tests and vet: pass. Windows amd64 cross-build: pass.
- The browser fixture exercises every operation and checks 390×844 portrait,
  844×390 landscape and desktop layouts in light/dark themes without horizontal
  overflow.

No token, private key or provider credential is stored in this repository.
Production device definitions belong in `/root/.witt/devices.json`; each entry
contains only metadata and a SHA-256 token hash.

## Field acceptance

The 0.2.0 Agent was accepted on the real `DESKTOP-O0RBGQQ` Windows desktop over
the production public WSS endpoint on 2026-10-04. Registration negotiated all
five configured capabilities. System information, a nested `agent/windows`
listing, UTF-8 README reading, JPEG capture and the MCP image response all
passed. The accepted screenshot was produced with native Windows GDI calls in
92 ms, decoded to 222,839 bytes and had valid JPEG boundaries; the image itself
was not retained in the repository or server logs. The Agent remained connected
after replacement/restart and did not spawn PowerShell.
