# Chloe Remote Assist — first development slice

## Existing implementation audited

The usable remote executor was already a separate Go executable in
`agent/windows`, not the Android/Chloe user interface. It needs neither Node nor
a local AI runtime. `remote-device/device-gateway.js` authenticates a device
token and negotiates capabilities/root aliases over outbound TLS WebSocket.
`CommandDispatcher` carries bounded JSON commands/results. The Go workspace
engine performs real Windows filesystem operations, canonicalizes paths and
checks write hashes. No SSH is used for customer file operations.

`RemoteWorkspaceService` generates a server-side runtime directory, a short-lived
MCP credential and Grok/Codex/Antigravity configurations. The existing stdio MCP
adapter converts `workspace_read` into the logical `workspace.read` operation.
Models run on the server. Their local file tools do not map to Windows.

The previous delivery problem was permanent device provisioning: a manually
configured device/token/root, persistent reconnect behavior and device-oriented
UI. Installing the complete Chloe client is not a technical prerequisite of the
existing executor. We retain that executor, WSS transport, workspace validation,
hash preconditions, MCP protocol and harness adapters.

## Implemented boundary

`backend/remote-assist/index.js` exports `createRemoteAssist(host)`:

- **Transport:** existing `DeviceGateway`/`CommandDispatcher`, with an authorization
  hook. Legacy devices keep their existing behavior.
- **Session/authorization:** `session-service.js`; single-use pairing code/ticket,
  customer-selected root and capabilities, operator ownership, absolute expiry,
  pause, explicit resume and revoke. Restart invalidates active grants.
- **Workspace files:** existing Go engine and backend validation. Assist additionally
  checks the bound session ID/capabilities locally on every command.
- **Shell/environment:** existing bounded operations remain an extension point;
  Assist does not grant them in this slice.
- **MCP:** existing `mcp/remote-workspace.js`, now filtering discovery to the
  session's granted capabilities. No new MCP wire protocol or agent loop.

The host supplies its Gateway, WorkspaceStore, authenticated principal, HTTP
helpers and `chatFor(principal)`. A Witt host can reuse this API/MCP contract
without importing the Chloe frontend. The package currently depends on the
existing workspace/gateway modules; it is not a separately published package.

## Browser + lightweight connector follow-up

The default exe now opens a local customer webpage in the default browser.
Pairing, server/operator/expiry review, directory selection, authorization,
pause/resume, per-edit diff confirmation and termination live on that page.
The existing WSS executor remains in the connector. The server-side harness,
Gateway and MCP contract are unchanged. `--native` retains the previous native
window for compatibility/testing; it is no longer the default.

The page is embedded in the executable, needs no web runtime installation and
is served only from a random `127.0.0.1` port. Local API requests require an
exact Host, same-origin POST and an unpredictable per-process bearer token.
The token is delivered in the browser fragment, removed from the address bar,
kept in page memory and never forwarded to the server. No CORS or persistent
local credentials are enabled. Remote traffic remains certificate-validated
HTTPS/WSS; loopback HTTP does not carry the model or server-side runtime.

Closing/refreshing the page requests revocation using a keepalive request.
If the browser crashes or cannot notify the connector, loss of page heartbeats
revokes and exits within 120 seconds. Grant expiry and network disconnect also
terminate the connector. Use **结束协助并退出连接器** for explicit termination.

The connector is still an executable: a browser alone cannot run the Windows
filesystem executor. This change removes the native control interface and
manual command requirement, not the need to obtain/start the connector once.
No URL-handler registration, permanent installation or automatic download is
introduced. Public signed distribution remains unfinished.

## Client and operator steps

1. On the **development** Chloe instance, open Remote Workspace, generate an
   Assist code and choose an expiry (15/30/60 minutes in the UI; API 1–60).
2. Transfer the locally built `artifacts/chloe-assist.exe` to the test Windows
   machine and verify `artifacts/SHA256SUMS.txt` through a trusted channel.
3. Run `chloe-assist.exe join XXXXX-XXXXX --server https://<test-host>/vault-api`.
   Without arguments the exe opens its customer webpage in the default browser;
   customers can enter the server and code there, without using a command line. The optional `--root`
   only prefills the directory; it does not approve access.
4. On the webpage, the customer checks the server address, operator, expiry and directory,
   optionally enables edits, then clicks **允许并连接**.
5. The operator refreshes the session and opens its Grok workspace in Chloe.
6. The customer can pause/resume or disconnect and exit. A network disconnect
   revokes an active session instead of silently reconnecting. Paused sessions
   require explicit customer resume. Expiry closes the client automatically.

Only `workspace.list/stat/read/search` and, if approved, `write/patch` are granted.
Each edit shows a complete replacement diff locally and needs a new customer
confirmation. Confirmation expires after 25 seconds; edits over 32 KiB total
before+after or 2,000 combined lines are rejected in this first slice. The
underlying hash precondition is checked again after approval. Changed files have
before/after hashes and their explicit diff in the operator audit. The client
retains operation/diff display in memory, not a general file-content log.

The client stores no pairing/device token on disk, does not register autorun,
install services or elevate. Credentials are held in memory for this session.
Server audit/history is deliberate private SQLite storage; active credentials
are not persisted. Customer endpoints expose status/scope/audit, not chat prompts,
reasoning or model credentials.

## Release status

This is a locally built Windows amd64 exe, **7,032,320 bytes**, approximately
**6.71 MiB**, with Go/WebSocket code statically included and only Windows system
DLLs required at runtime. The current artifact is **NotSigned**. There is no
trusted public release URL, Authenticode certificate or verified download/install
flow. SHA-256 alone is not publisher authentication. No one-click install PASS is
claimed; no Defender, SmartScreen or execution policy changes are made.

Build with Go using the commands in `scripts/build-chloe-assist.ps1`, or run its
`go test` / `go build` commands directly when local policy disallows unsigned
PowerShell scripts. Do not bypass that policy. Python, Paramiko, Pillow and
Playwright are development-test dependencies only.

## Verified evidence — 2026-10-15

Tests use a dedicated directory under `artifacts/assist-e2e/workspace`, a new
temporary Assist device and an isolated development server under `/tmp`. The
existing production service/configuration and installed persistent Windows
Agent were not changed. SSH only provisions the isolated test fixture; the
customer executable itself uses HTTPS/WSS with certificate validation. The
local test CA is passed explicitly with `--ca-file`, not installed system-wide.

| Check | Evidence / result |
| --- | --- |
| Unapproved session | No device/workspace before native Allow; server cannot dispatch files |
| Native consent | Actual Win32 exe, non-administrator Windows 11 Home session |
| Real model file read | Chloe conversation → Grok Build 1.0.44 → MCP discovery/call → Gateway → Windows; random file marker matched |
| Model file edit | Grok patch, file unchanged until native diff approval, actual content and audit diff verified |
| Scope | Traversal, outside absolute path and Shell rejected; outside sentinel unchanged |
| Windows junction | Actual temporary junction resolves in the test, but workspace read is refused |
| Pause/resume/revoke | Actual client controls; new MCP read denied when paused and after revoke, allowed after explicit resume; exe exits |
| Expiry | PASS: one-minute native/client + Gateway test; client exits and authorization expires |
| Operator UI | Real development HTTP API; 1440×900 and 390×844; pairing, disabled pre-authorization open, revoke, no page errors/overflow |
| Regressions | 54 Node tests passed; Go tests passed, including actual Windows junction rejection; no production deployment |

**Harness/model distinction:** the current upstream model list contains no
Grok 4.7 model. Initial real tests correctly failed with “unknown provider for
model grok-4.7-high”. The passing isolated fixture uses the actual **Grok Build
CLI** with the available **Gemini 3.8 Flash High** upstream, explicitly selected
with `--grok-upstream gemini-3.8-flash-high`. This test alias exists only in the
fixture's private Grok configuration. It is not evidence that Grok 4.7 works.

Real discovery also exposed that a listed project MCP configuration was not
started until its generated runtime folder was trusted. The adapter now trusts
only that service-generated directory, permits its MCP namespace and removes
server-local filesystem/Shell built-ins from Assist turns. MCP credentials and
capabilities are passed explicitly in the generated config, not assumed to be
inherited by a pre-existing runtime.

Local evidence is intentionally excluded from Git: `native-results.json`,
`grok-read-result.json`, `grok-edit-result.json`, `audit.json`, native consent and
diff screenshots, operator screenshots and `ui-results.json`.

## Reproduction

Run `node --test backend/test-remote-assist.js` and the existing remote workspace,
transport/MCP/runtime regression tests with backend dependencies installed.
Run `go test ./...` from `agent/windows` and build the exe.

For the real server-side harness test, use
`scripts/assist-test-environment.py --host <reviewed-host> --port <ssh-port>
--key <private-key-path> --grok-upstream <available-test-model>`.
It requires a previously trusted SSH host, creates private test state and binds
only loopback ports. Then run `tests/test-assist-native.py` with the matching SSH
arguments. `--expiry-only` runs the one-minute expiry test. Run
`node tests/assist-ui.cjs` for operator browser acceptance. The customer browser
flow is `node tests/assist-browser.cjs`; `--lifecycle-only` checks page unload
and the actual two-minute heartbeat fallback without repeating model calls. Creating
`artifacts/assist-e2e/stop` closes the tunnel and only the verified fixture PID.

## Not completed / NOT TESTED

- A clean Windows VM without any existing Chloe installation, Windows 10 and
  Windows ARM64 have not been tested. Standalone execution on the current
  non-elevated Windows 11 machine is verified; no installed Chloe runtime is
  invoked by the exe.
- Grok 4.7 as the actual upstream, Codex with Assist, and full production chat
  regression are NOT TESTED in this slice.
- Shell/tests/installations, environment information, system changes, Git tools,
  image access and screen control are not granted to Assist in this slice.
- Publisher signing, trusted HTTPS distribution, automatic updates, packaging
  for commercial delivery and production deployment are not done.
- The supported expiry and consent limits are intentionally small. This is not
  a device-management platform, workflow engine or plugin marketplace.

Next minimal task: run this exact artifact on a clean Windows VM. Publisher
signing/distribution, Shell authorization and Codex acceptance remain separate
tasks; do not expand automatically.

## Browser follow-up verification

### Authorized deployment follow-up — 2026-10-16

The user subsequently authorized production deployment for testing. The
operator panel now includes HTTPS links to the separately built connector and
its SHA-256 file, with an explicit unsigned-release label. Deployment uses
`scripts/deploy-assist-release.sh <commit> <binary-sha256>` after transferring
the reviewed Git snapshot and artifact. It retains the old snapshot and backs
up the service/static configuration, verifies health and frontend/backend
versions, and rolls back on activation failure. Existing secrets/model settings
and the independent Worker are not provisioned or changed by this script.
The earlier no-deployment statements describe the original development round.

### Development verification boundary

`tests/assist-browser.cjs` drives the real Go browser controller on the same
non-elevated Windows 11 test machine, against the isolated Gateway and real
server-side Grok Build harness (Gemini upstream as disclosed above).
The fixture is a Go **test executable** with only the OS browser launcher
substituted by Playwright navigation; production pairing, authorization,
filesystem/WSS execution, approval and lifecycle code are unchanged. This is
not a clean-machine acceptance test of Windows default-browser association.

- PASS: unauthorized local API requests and foreign Origins rejected.
- PASS: preview alone leaves the remote session unapproved.
- PASS: browser consent establishes WSS; actual model read returns unique marker.
- PASS: file unchanged until webpage diff approval; actual patch/audit verified.
- PASS: webpage pause/resume and explicit end/revoke/process exit.
- PASS: 1280px and 390px page checks; no horizontal overflow or browser errors.
- Page-unload and forced page-close lease results: see local `browser-lifecycle-results.json`.
  The initial combined run passed the read/edit/control checks but used an
  incorrect 15-second close expectation; Chromium omitted its close notification.
  The corrected lifecycle run tests the documented 120-second heartbeat fallback.
- PASS: Go tests, plus 54 unchanged Node regression tests.

Local evidence and test credentials remain excluded from Git. Browser screenshots
are `browser-consent-1280.png`, `browser-consent-390.png`, `browser-diff.png`.
Default-browser launch and native directory-picker interaction on a clean machine,
Windows 10, signing, public delivery and production deployment remain NOT TESTED
or unfinished. No production configuration/service has been changed.

## Folder picker hotfix — 2026-10-16

The original browser connector synchronously waited for an unowned shell folder
picker while disabling every web button. A real running connector on the test
Windows machine was confirmed to have that visible shell dialog behind the
browser. The picker now uses a connector-owned window (so the browser remains enabled),
raises the dialog and requests foreground activation when initialized. Opening it returns immediately to the
webpage; status polling exposes pending/error state, cancellation is available,
and a 90-second deadline closes an abandoned picker. Ending the connector also
cancels the picker. Late picker results cannot change an authorized root, and
manual path edits are no longer overwritten by polling.

Go tests cover non-blocking requests/cancellation. Explicit native acceptance
`ASSIST_PICKER_TEST_ROOT=<dedicated-root> go test -run TestAssistRealFolderDialog`
selected the real test directory and cancelled a separate real dialog on this
Windows machine. The standalone build now embeds its entry-point marker so
browser-renamed downloads also open the customer webpage.

The download artifact can be updated separately from the server snapshot;
this client-only fix does not require restarting the production service.

`node tests/assist-folder-ui.cjs` also passed against the real local Windows
picker: web buttons stay enabled, manual input survives polling, web cancellation
works and the connector host exits. Its consent form is exposed by a test-only
status-response override; no production session is authorized by this test.


### Foreground follow-up — connector 2026.10.16.3

A repeated report was verified against the actual downloaded binary: its hash
matched bb41940, and its real shell dialog existed on-screen but was behind
other applications. Ordinary foreground activation was insufficient. Only the
folder dialog is now topmost until dismissed; the browser remains enabled.
Explicit Windows dialog acceptance now also checks WS_EX_TOPMOST before driving
selection/cancel. The customer page displays version 2026.10.16.3.


## Explicit environment / command consent — connector 2026.10.16.4

The operator can request `allow_environment` (workspace.system_info) and
`allow_commands` (workspace.exec) when creating an invitation. The customer's
local webpage independently opts in, unchecked by default. Existing grants are
never upgraded. The legacy `--native` consent window filters both new grants.

`workspace.system_info` is host-scoped metadata, not a project path. Commands
reuse the existing session-bound MCP and WSS protocol. A server-owned session
lookup enables the Assist command policy; model arguments cannot enable it.
Every command, including PowerShell diagnostics, requires local approval of the
complete program, argv, cwd and timeout. This approval is also the separate
confirmation for installs, configuration and service actions. It expires after
60 seconds; execution has its own budget, default 30 seconds, max 5 minutes.
No automatic retries, privilege escalation or persistent service installation
is introduced. Windows may still refuse operations requiring administrator
rights. A command is explicitly NOT confined to the file root: after consent it
can affect anything the current Windows account can access. File APIs and cwd
remain root-confined, including symlink/junction checks.

Pause/end/expiry cancel the session context and reject new commands. A live
Windows test cancelled a running PowerShell before its delayed file write and
returned EXECUTION_STATE_UNKNOWN promptly. Cancellation is best effort: already
applied system changes are not rolled back, and detached child processes or
external installers are not guaranteed to stop. No service/installer or reboot
lifecycle manager was added in this iteration.

Audit stores command program, cwd, intent SHA-256 and outcome, not argv, command
stdout, file content or credentials. The customer sees full arguments only in
the local approval preview. Existing file-edit diff auditing remains unchanged.

Validation on 2026-10-16:
- PASS: 56 targeted Node checks, then all 11 workspace checks after adding the
  trusted command budget regression (57 checks in the combined set).
- PASS: Go suite; additional Windows direct approval/decline and in-flight
  cancellation checks. Commands without consent did not create a marker;
  command consent did not permit out-of-root file reads.
- PASS: `node tests/assist-browser.cjs --commands`, isolated Linux server + real
  Windows connector/browser, actual Grok Build with Gemini 3.8 Flash High test
  upstream: MCP file read/patch and diff, rejected command, approved Get-Service
  plus random stdout marker, pause/resume/revoke and process exit. Desktop and
  mobile command confirmation were rendered, without overflow or page errors.
- PASS: calling the ended real MCP session returned WORKSPACE_SESSION_INVALID
  (the existing HTTP route maps this denial to 500; access was refused).
- NOT TESTED: actual Grok upstream, clean Windows 10/VM, UAC/admin operation,
  installing WSL/Hadoop, changing services or configuration, detached child
  process termination, and code signing. Production model configuration was
  not changed by the isolated test.
