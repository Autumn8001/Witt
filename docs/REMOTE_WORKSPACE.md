# Remote Vibecoding Workspace

Remote Workspace lets a Grok Build conversation work on one customer Windows
project without installing an AI runtime, CPA key, Grok CLI, or Witt backend on
the customer computer.

The server creates an immutable binding:

`customer -> device -> root alias -> workspace session -> Grok harness session`

The actual Windows path stays in the customer Agent configuration. Grok is
given only a one-turn MCP credential and cannot select another device or root.

## Enable one customer root

On the server, add the device to `WITT_DEVICE_CONFIG` (normally
`/root/.witt/devices.json`). `workspace_roots` is a display label only; it is
not sent to Grok as a usable filesystem path.

```json
{
  "devices": [{
    "device_id": "PC-CUSTOMER-01",
    "label": "客户 A 的开发电脑",
    "customer_id": "customer-a",
    "token_sha256": "<sha256 of the device token>",
    "allowed_roots": ["project"],
    "workspace_roots": { "project": "客户 A · 网站项目" },
    "capabilities": [
      "workspace.list", "workspace.stat", "workspace.read", "workspace.search",
      "workspace.write", "workspace.patch", "workspace.exec",
      "workspace.git_status", "workspace.git_diff", "workspace.system_info"
    ]
  }]
}
```

On the Windows computer, run the Agent with the matching alias. The physical
path is configured locally and never belongs in this server file:

```powershell
remote-agent.exe -gateway wss://your-witt.example/device/ws -device-id PC-CUSTOMER-01 `
  -token-file C:\ProgramData\Witt\device-token -root project=D:\Customer\Website
```

The Agent must be version `0.3.0` or newer. It reports the workspace
capabilities at registration. Witt only enables **开始远程开发** after the
device is online and all required capabilities have been negotiated.

## Operations and approval

- Safe: list, stat, read, search, system info, git status/diff, bounded file
  writes and exact one-match patches with SHA-256 preconditions.
- Confirmation required: dependency/service changing commands, external Git
  operations, and unknown commands. Confirmation is shown in the existing
  Witt conversation approval UI.
- Denied: shells, PowerShell, destructive Git, device-management utilities,
  absolute paths, traversal, UNC paths, ADS, sensitive paths and unknown
  programs.

If a write, patch, or command is sent and the Agent disconnects or times out,
Witt returns `EXECUTION_STATE_UNKNOWN`. It never retries that operation; read
the affected file and `workspace_git_diff` before deciding what happened.

## Operator notes

- Runtime state and audit metadata are stored under
  `WITT_REMOTE_WORKSPACE_DIR` (default: `<auth-dir>/remote-workspaces`).
- Runtime MCP credentials are one-process and one-workspace. A backend restart
  invalidates them; the next Grok turn creates a fresh scoped credential.
- Existing `customer-devices` routes remain diagnostic compatibility routes.
  Grok Remote Workspace sessions never use them and never receive a device ID.
- The first production acceptance should use a disposable test repository and
  verify list/read, one patch, a test command, git diff, one rejected command,
  one confirmed command, and disconnect behaviour before any real customer
  project is bound.

## MCP bridge regression verification

Verified on 2026-10-06: the bridge replaces only the `workspace_` namespace
prefix. Compound names remain `workspace.git_status`, `workspace.git_diff`
and `workspace.system_info`, matching backend validation and Agent operations.

`backend/test-remote-workspace-mcp.js` starts the actual stdio MCP process and
calls all ten tools through the internal HTTP route, session authentication,
policy and bound dispatcher. It also rejects unknown tools, path traversal and
paused workspace credentials. The device transport is simulated; no production
credentials or customer files are used. The related MCP, workspace, device and
runtime parser suites passed 65/65 tests.

This validates the bridge fix, not Windows 0.3.0 field acceptance. The full
Remote Workspace Windows/Grok chain remains NOT TESTED in this validation;
use the disposable-project acceptance procedure above. This change does not
deploy or restart production services.
