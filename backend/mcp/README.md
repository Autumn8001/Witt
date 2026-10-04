# Remote Device MCP bridge

This stdio bridge offers fixed, read-only customer-device operations. It requires the local authenticated Gateway internal API; it cannot execute arbitrary commands or write files.

| Logical operation | MCP wire name |
| --- | --- |
| device.list | device_list |
| device.get | device_get |
| device.hostname | device_hostname |
| device.system_info | device_system_info |
| device.file_list | device_file_list |
| device.file_read | device_file_read |
| device.screenshot | device_screenshot |

Grok Build 1.0.44 rejects periods in MCP tool identifiers at session admission. The discoverable wire names therefore use underscores. Descriptions retain the logical operation names. tools/call also accepts the original dotted aliases for compatible clients.

Calls are disabled unless WITT_REMOTE_DEVICE_MCP_ENABLED=1. The API endpoint is restricted to HTTP(S) loopback, rejects credentials/query/fragment/path prefixes, does not follow redirects, and defaults to http://127.0.0.1:3003 and the credential is read from DROP_VAULT_TOKEN_FILE; no credential is stored in this directory. Never put token values in project configuration, CLI arguments, logs or Git.

Project-scoped MCP servers also require a trusted folder in Grok. Review the exact server command and three capabilities before granting trust. The native live acceptance fixture passes --trust only for its reviewed temporary project and uses an isolated leader socket. This is not automatic trust for customer/user repositories.

The Gateway negotiates capabilities as the intersection of the server-side device definition and the agent's registration declaration. Legacy definitions/agents retain only `system.hostname` (and the server's legacy definition also records `system.info` for upgraded agents); filesystem roots are aliases, never host paths, and must be present in both `allowed_roots` and the agent registration. The wire envelope is capped at 2 MiB. Screen capture results must be JPEG and decode to at most 1.25 MiB; MCP returns them as image content.

Validation: `node --test backend/test-remote-device.js backend/test-remote-device-mcp.js` checks capability negotiation, legal wire identifiers, logical descriptions, aliases, disabled authorization, invalid arguments, relative-path checks and bounded attachments. The separate native integration fixture exercises actual Gateway/TLS-WSS/Go Agent calls. A Windows device has also passed production WSS connection, reconnect, replacement-session, hostname and MCP-to-device acceptance; see docs/CUSTOMER-DEVICE-VALIDATION.md.

## Browser acceptance MCP

`playwright.js` launches the pinned `@playwright/mcp` dependency in an isolated, headless Chromium profile. It is disabled unless `WITT_BROWSER_MCP_ENABLED=1`; the Grok adapter sets that gate explicitly for administrator sessions. The launcher blocks service workers, omits image payloads by default, enables DevTools inspection, and uses a 1440×900 starting viewport. Frontend work must additionally exercise a 390×844 mobile viewport.
