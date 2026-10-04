# Customer Device Agent

This is a transport agent, not an AI runtime. It holds one device token and
accepts only the fixed, structured operations below. It never accepts an
arbitrary shell command, PowerShell command, or script.

## Operations

The agent keeps protocol version `v=1` and returns operation results in
`stdout`. The registration packet declares `agent_version: 0.2.0`, its fixed
capabilities, and configured named roots.

* `system {command: "hostname"}` — the existing hostname check.
* `system {command: "info"}` — JSON with `hostname`, `os`, `arch`,
  `username`, and `home_dir`.
* `filesystem {operation: "list", root: "alias", path: "relative"}` —
  metadata only, at most 200 entries.
* `filesystem {operation: "read", root: "alias", path: "relative"}` —
  UTF-8 text only, at most 256 KiB.
* `screen {operation: "capture"}` — Windows JPEG only, and only when the
  explicit opt-in flag is present. The result carries `mime: "image/jpeg"`
  and base64 `data`.

Filesystem operations are unavailable unless at least one root is configured.
Paths are canonicalized and checked after symlink/junction resolution; absolute
paths, drive/UNC paths, `..` escapes, and links outside the configured root are
rejected.

## Build

From agent/windows:

    go test -race ./...
    go vet ./...
    GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -o remote-agent.exe .

Do not commit the executable or device credentials. A validated cross-build is currently under /opt/witt/.git/witt-device-validation/remote-agent.exe.

## Configuration and run

An operator must provision a distinct random device token through a private channel. The Gateway receives only its SHA-256 hash in the external device configuration. The real Windows PC keeps the raw token in a local file protected for the agent user. Neither token nor configuration belongs in Git.

After a separately verified deployment exposes the Gateway, run on the real
Windows PC. `-root` may be repeated; each alias is exposed to the server but
only its canonical directory is accessible:

    .\remote-agent.exe -gateway wss://cpa.stellarbit.site/vault-api/device/ws -device-id PC-001 -token-file C:\Witt\device-token.txt -root work=C:\Users\Customer\Project -root docs=C:\Users\Customer\Documents

To explicitly enable screen capture, add:

    -allow-screen-capture

TLS verification is mandatory; there is no insecure TLS switch. Windows
hostname is executed from `SystemRoot/System32/hostname.exe`. Screen capture
uses a fixed built-in Windows capture path and never receives a script from the
wire. Ctrl+C exits; transient failures reconnect with bounded exponential
backoff. A duplicate session closes the previous agent with code 4001; that
agent exits to avoid connection contention. Disconnect cancels in-flight work
and does not replay commands.

Do not commit the executable, device token, or root configuration. The token
file should be readable only by the agent user. The Gateway receives only the
token hash in its device configuration.

## Acceptance

Acceptance must show PC-001 online in Witt, invoke `system.info`, list and
read a file below a configured root, reject a path escape and a binary file,
and, when explicitly enabled, capture a JPEG. Compare hostname and system info
with the actual Windows PC, exercise disconnect/reconnect, and verify no
command replay. Only after this should Remote Device MCP and Grok be enabled
and checked.

The local test suite covers the protocol, allowlists, root boundaries, text
and size limits, registration capabilities, and disabled screen capture.
