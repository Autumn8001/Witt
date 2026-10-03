# Remote Device MCP bridge

This stdio bridge offers only the fixed device inventory/get/hostname operations. It requires the local authenticated Gateway internal API; it cannot execute arbitrary commands.

| Logical operation | MCP wire name |
| --- | --- |
| device.list | device_list |
| device.get | device_get |
| device.hostname | device_hostname |

Grok Build 1.0.44 rejects periods in MCP tool identifiers at session admission. The discoverable wire names therefore use underscores. Descriptions retain the logical operation names. tools/call also accepts the original dotted aliases for compatible clients.

Calls are disabled unless WITT_REMOTE_DEVICE_MCP_ENABLED=1. The API endpoint is restricted to HTTP(S) loopback, rejects credentials/query/fragment/path prefixes, does not follow redirects, and defaults to http://127.0.0.1:3003 and the credential is read from DROP_VAULT_TOKEN_FILE; no credential is stored in this directory. Never put token values in project configuration, CLI arguments, logs or Git.

Project-scoped MCP servers also require a trusted folder in Grok. Review the exact server command and three capabilities before granting trust. The native live acceptance fixture passes --trust only for its reviewed temporary project and uses an isolated leader socket. This is not automatic trust for customer/user repositories.

Validation: node --test backend/test-remote-device-mcp.js checks handshake, legal wire identifiers, logical descriptions, aliases, disabled authorization and invalid arguments. The separate native integration fixture exercises actual Gateway/TLS-WSS/Go Agent calls. A Windows device has also passed production WSS connection, reconnect, replacement-session, hostname and MCP-to-device acceptance; see docs/CUSTOMER-DEVICE-VALIDATION.md.

## Browser acceptance MCP

`playwright.js` launches the pinned `@playwright/mcp` dependency in an isolated, headless Chromium profile. It is disabled unless `WITT_BROWSER_MCP_ENABLED=1`; the Grok adapter sets that gate explicitly for administrator sessions. The launcher blocks service workers, omits image payloads by default, enables DevTools inspection, and uses a 1440×900 starting viewport. Frontend work must additionally exercise a 390×844 mobile viewport.
