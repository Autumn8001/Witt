# Customer Device Agent

This is a transport agent, not an AI runtime. It holds one device token and
accepts only fixed, structured operations. It never accepts an arbitrary shell
command, PowerShell command, or script.

## Operations

The agent keeps protocol version `v=1` and returns operation results in
`stdout`. The registration packet declares `agent_version: 0.3.0`, its fixed
capabilities, and configured named roots.

* `system {command: "hostname"}` — the existing hostname check.
* `system {command: "info"}` — JSON with `hostname`, `os`, `arch`,
  `username`, and `home_dir`.
* `filesystem {operation: "list", root: "alias", path: "relative"}` —
  metadata only, at most 200 entries.
* `filesystem {operation: "read", root: "alias", path: "relative"}` —
  UTF-8 text only, at most 256 KiB.
* `screen {operation: "capture"}` — Windows GDI JPEG only, and only when the
  explicit opt-in flag is present. The result carries `mime: "image/jpeg"`
  and base64 `data`.

## Remote Workspace wire contract

New development sessions send `tool: "workspace"` and a JSON object in
`args`. Every project operation includes a configured root alias; the server
binds that alias to the Workspace Session, while the agent enforces it again
locally. The supported operations are:

* `{operation:"list"|"stat"|"read", root, path}`
* `{operation:"search", root, path, query}`
* `{operation:"write", root, path, content, expected_sha256}`
* `{operation:"patch", root, path, expected_sha256, before, after}`
* `{operation:"exec", root, cwd, program, argv, approval?}`
* `{operation:"git_status"|"git_diff", root, cwd}`
* `{operation:"system_info"}`

`path` and `cwd` are slash or backslash separated relative paths. They cannot
be absolute, UNC, drive-qualified, contain `..`, an ADS colon, a Windows device
name (`CON`, `NUL`, `COM1`, and so on), or trailing dots/spaces. The agent
canonicalises existing paths and parent directories before use, rejecting
symlink/junction escapes.

Writes require a SHA-256 precondition (`""` only means “create if absent”) and
are written to a same-directory temporary file then renamed. A patch requires
the expected hash and exactly one occurrence of `before`. Results include
`execution_state`: `not_started`, `completed`, or `unknown`. A cancellation
after a write/process starts is `unknown` and must never be replayed.

`exec` is a program plus argv, never a command line. The local allowlist is for
common development tools only; shell interpreters, destructive tools, and
destructive Git subcommands are denied. Package installation and Git commit,
push, rebase, or config require `approval:{id,confirmed:true}`. Server-side UI
approval is still required; this is a second local guard.

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
uses fixed Windows GDI calls and never starts a command interpreter or accepts
a script from the wire. Ctrl+C exits; transient failures reconnect with bounded
exponential backoff. A duplicate session closes the previous agent with code
4001; that agent exits to avoid connection contention. Disconnect cancels
in-flight work and does not replay commands.

Do not commit the executable, device token, or root configuration. The token
file should be readable only by the agent user. The Gateway receives only the
token hash in its device configuration.

## Acceptance

Acceptance must show PC-001 online in Witt and use a Remote Workspace Session
to list/read/search a test project, patch a known bug, run a test through a
program+argv invocation, and return `git diff`. It must reject path escape,
ADS/device-name paths, wrong hashes, ambiguous patches, shell commands, and
unapproved confirmation commands. Exercise disconnect/reconnect and verify no
unknown write or process is replayed.

The local test suite covers the protocol, allowlists, root boundaries, text
and size limits, registration capabilities, and disabled screen capture.
