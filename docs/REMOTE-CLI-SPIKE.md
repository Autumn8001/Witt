# Remote CLI development proof — 2026-10-16

Decision: reuse the existing outbound TLS WebSocket channel (route B). Do not
install sshd, replace the Agent loop, add MCP servers, change production or
build another client/UI.

## Audit findings

- The existing Go Assist is already a roughly 7.14 MB standalone Windows
  connector with browser consent/status, file execution and command approval.
  Customers do not need full Chloe, Node, Python, Grok or model keys.
- DeviceGateway/CommandDispatcher carry actual WSS traffic. AssistSessions
  binds authorization, device, root, expiry and revocation; WorkspaceDispatcher
  validates operations. Retain these implementations.
- Current Grok integration uses session-bound stdio MCP and intentionally
  excludes server-local Shell. The existing remote-assist factory is small;
  there is no large plugin marketplace to delete. Further generic device,
  plugin and MCP-platform expansion is unnecessary for this requirement.
- SSH is an operator-to-server connection, not an authorized server-to-customer
  Windows channel. No customer sshd/tunnel was found in the audited Assist
  path. Route A would add provisioning; route B reuses working WSS and consent.
- No performance benchmark was run. Route B adds one short-lived local Node
  CLI process and Unix-socket hop per operation, retaining the WSS connection;
  it avoids SSH handshake/setup on the Windows customer side.

## Implemented boundary

`Grok Build native run_terminal_cmd -> chloe-remote -> session Unix socket ->
existing authorization/dispatcher -> WSS -> Windows executor`

The CLI accepts operations, never device/session selectors or credentials.
The trusted operator supplies one bridge execute callback, e.g.
`(op,args) => service.executeMcp(runtime.secret,op,args)` for its fixed binding.
That method's historical name does not introduce an MCP dependency into the
CLI. Existing dispatcher and client consent are still enforced. File operations
use bounded paths and compare-and-swap hashes. There is no automatic retry.

This is an opt-in development adapter, NOT a production launch facility. Its
`isolated` assertion is a trusted caller contract, not an OS sandbox switch.
Do not set it for a host-native/root Grok process. The verified test uses an
existing Docker engine/image, non-root UID, read-only container filesystem,
dropped capabilities, and only its own socket/home mounted. No Docker socket,
production filesystem or Assist credentials enter the harness container.
The bridge is Linux-only. It does not add a daemon or public API.

Windows commands run with the customer's account after explicit command
approval; the workspace root is not an OS sandbox for arbitrary PowerShell.

## Real verification

`tests/assist-cli-spike.py` starts an isolated loopback HTTPS gateway and actual
Go Windows fixture, automates the existing consent page, stages development
code in a new server `/tmp` directory and runs the real Grok Build adapter in
a disposable container. An SSH stdio relay connects the isolated test gateway;
it is test plumbing, not a customer SSH requirement. No sshd configuration,
production process or real customer session is changed.

PASS: README/project read, approved text patch with returned diff, actual
PowerShell test (`TEST_PASS`, `OS=Win32NT`, Windows cwd), invalid authorization,
traversal/absolute-path/device-selector rejection, existing Windows junction
escape rejection, browser pause/revoke denial, connector exit/container cleanup.
Grok Build completed 8 turns with `end_turn`; Gemini was the available test
upstream. Grok model upstream: NOT TESTED (absent from current model catalog).
19 Node checks and the Windows Go suite passed.

NOT TESTED: the complete Chloe webpage conversation over this CLI path. The
default ChatService still uses its original MCP path; there is no production
switch, new customer distribution, installer or signed release this round.
Next smallest task: wire the proven isolated CLI runtime into the existing
conversation binding and test result display, without redesigning the UI.

Reproduction prerequisites: explicit test SSH host/port/key environment values,
known host verification, Paramiko, Playwright/Node dependencies, existing Linux
Docker/Grok/Node, OpenSSL and the Go browser fixture executable. See the test
orchestrator header. Test reports/diffs/events remain in ignored
`artifacts/assist-cli-spike/`; they are not production telemetry.
