# Minimal Customer Device Agent

This is a transport agent, not an AI runtime. It holds one device token and allows only the exact hostname operation. It does not accept arbitrary shell or PowerShell commands.

## Build

From agent/windows:

    go test -race ./...
    go vet ./...
    GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -o remote-agent.exe .

Do not commit the executable or device credentials. A validated cross-build is currently under /opt/witt/.git/witt-device-validation/remote-agent.exe.

## PC-001 acceptance (pending)

An operator must provision a distinct random device token through a private channel. The Gateway receives only its SHA-256 hash in the external device configuration. The real Windows PC keeps the raw token in a local file protected for the agent user. Neither token nor configuration belongs in Git.

After a separately verified clean, committed deployment exposes the Gateway, run on the real Windows PC:

    .\remote-agent.exe -gateway wss://cpa.stellarbit.site/vault-api/device/ws -device-id PC-001 -token-file C:\Witt\device-token.txt

TLS verification is mandatory; there is no insecure TLS switch. Windows hostname is executed from SystemRoot/System32/hostname.exe. Ctrl+C exits; transient failures reconnect with bounded exponential backoff. A duplicate session closes the previous agent with code 4001; that agent exits to avoid connection contention. Disconnect cancels in-flight work and does not replay commands.

Acceptance must show PC-001 online in Witt, invoke hostname, compare the result with hostname on the actual Windows PC, exercise disconnect/reconnect and verify no command replay. Only after this should Remote Device MCP and Grok be enabled and checked.

Windows execution and public WSS acceptance: NOT TESTED.
