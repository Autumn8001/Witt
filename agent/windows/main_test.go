package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func hostnamePacket() packet {
	return packet{V: 1, Type: "command", ID: "test-command", Tool: "system", Args: map[string]string{"command": "hostname"}, TimeoutMS: 1000}
}

func TestHostnameAllowlist(t *testing.T) {
	valid := hostnamePacket()
	result := execute(context.Background(), valid, "PC-001")
	if result.ExitCode != 0 || strings.TrimSpace(result.Stdout) == "" {
		t.Fatalf("hostname failed: %s", result.Error)
	}
	for _, mutate := range []func(*packet){
		func(p *packet) { p.Args["extra"] = "x" },
		func(p *packet) { p.Args["command"] = "powershell" },
		func(p *packet) { p.TimeoutMS = 31000 },
		func(p *packet) { p.ID = "" },
	} {
		p := hostnamePacket()
		mutate(&p)
		if execute(context.Background(), p, "PC-001").Error != "COMMAND_NOT_ALLOWED" {
			t.Fatal("unsafe command accepted")
		}
	}
}

func commandPacket(tool string, args map[string]string) packet {
	return packet{V: 1, Type: "command", ID: "test-command", Tool: tool, Args: args, TimeoutMS: 1000}
}

func TestSystemInfo(t *testing.T) {
	result := execute(context.Background(), commandPacket("system", map[string]string{"command": "info"}), "PC-001")
	if result.ExitCode != 0 {
		t.Fatalf("system.info failed: %s", result.Error)
	}
	var info map[string]string
	if err := json.Unmarshal([]byte(result.Stdout), &info); err != nil {
		t.Fatalf("system.info returned invalid JSON: %v", err)
	}
	for _, key := range []string{"hostname", "os", "arch", "username", "home_dir"} {
		if _, ok := info[key]; !ok {
			t.Fatalf("system.info omitted %q", key)
		}
	}
	if info["os"] != runtime.GOOS || info["arch"] != runtime.GOARCH {
		t.Fatalf("system.info platform mismatch: %#v", info)
	}
}

func TestFilesystemListAndRead(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "nested"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "hello.txt"), []byte("hello Witt\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "nested", "child.txt"), []byte("child"), 0o600); err != nil {
		t.Fatal(err)
	}
	config := agentConfig{roots: map[string]string{"work": root}}
	list := executeWithConfig(context.Background(), commandPacket("filesystem", map[string]string{
		"operation": "list", "root": "work", "path": ".",
	}), "PC-001", config)
	if list.ExitCode != 0 {
		t.Fatalf("file.list failed: %s", list.Error)
	}
	var entries []fileMetadata
	if err := json.Unmarshal([]byte(list.Stdout), &entries); err != nil {
		t.Fatalf("file.list returned invalid JSON: %v", err)
	}
	if len(entries) != 2 || entries[0].Path == "" || entries[1].Type == "" {
		t.Fatalf("unexpected file.list result: %#v", entries)
	}
	nested := executeWithConfig(context.Background(), commandPacket("filesystem", map[string]string{
		"operation": "list", "root": "work", "path": "nested",
	}), "PC-001", config)
	if nested.ExitCode != 0 {
		t.Fatalf("nested file.list failed: %s", nested.Error)
	}
	entries = nil
	if err := json.Unmarshal([]byte(nested.Stdout), &entries); err != nil || len(entries) != 1 || entries[0].Path != "nested/child.txt" {
		t.Fatalf("nested file.list returned wrong root-relative path: %#v (%v)", entries, err)
	}
	read := executeWithConfig(context.Background(), commandPacket("filesystem", map[string]string{
		"operation": "read", "root": "work", "path": "nested/child.txt",
	}), "PC-001", config)
	if read.ExitCode != 0 || read.Stdout != "child" {
		t.Fatalf("file.read failed: error=%s stdout=%q", read.Error, read.Stdout)
	}
}

func TestFilesystemRejectsUnsafePaths(t *testing.T) {
	root := t.TempDir()
	config := agentConfig{roots: map[string]string{"work": root}}
	for _, path := range []string{"../outside", `..\outside`, `/tmp/outside`, `\\server\share\file`, `C:\outside`} {
		result := executeWithConfig(context.Background(), commandPacket("filesystem", map[string]string{
			"operation": "read", "root": "work", "path": path,
		}), "PC-001", config)
		if result.Error != "PATH_NOT_ALLOWED" && result.Error != "PATH_OUTSIDE_ROOT" {
			t.Errorf("unsafe path %q returned %q", path, result.Error)
		}
	}
	unknown := executeWithConfig(context.Background(), commandPacket("filesystem", map[string]string{
		"operation": "list", "root": "missing", "path": ".",
	}), "PC-001", config)
	if unknown.Error != "ROOT_NOT_CONFIGURED" {
		t.Fatalf("unknown root returned %q", unknown.Error)
	}
	withExtra := commandPacket("filesystem", map[string]string{"operation": "list", "root": "work", "path": ".", "extra": "x"})
	if executeWithConfig(context.Background(), withExtra, "PC-001", config).Error != "COMMAND_NOT_ALLOWED" {
		t.Fatal("extra filesystem argument accepted")
	}

	outside := t.TempDir()
	outsideFile := filepath.Join(outside, "secret.txt")
	if err := os.WriteFile(outsideFile, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link.txt")
	if err := os.Symlink(outsideFile, link); err != nil {
		t.Logf("symlink unavailable on this host: %v", err)
		return
	}
	result := executeWithConfig(context.Background(), commandPacket("filesystem", map[string]string{
		"operation": "read", "root": "work", "path": "link.txt",
	}), "PC-001", config)
	if result.Error != "PATH_OUTSIDE_ROOT" {
		t.Fatalf("symlink escape returned %q", result.Error)
	}
}

func TestFilesystemRejectsBinaryAndOversize(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "binary.bin"), []byte{0x00, 0x01, 0x02, 0x03}, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "large.txt"), []byte(strings.Repeat("x", maxFileRead+1)), 0o600); err != nil {
		t.Fatal(err)
	}
	config := agentConfig{roots: map[string]string{"work": root}}
	for path, want := range map[string]string{"binary.bin": "BINARY_FILE", "large.txt": "FILE_TOO_LARGE"} {
		result := executeWithConfig(context.Background(), commandPacket("filesystem", map[string]string{
			"operation": "read", "root": "work", "path": path,
		}), "PC-001", config)
		if result.Error != want {
			t.Errorf("%s returned %q, want %q", path, result.Error, want)
		}
	}
}

func TestCapabilitiesAndRegistration(t *testing.T) {
	withoutRoots := agentConfig{}
	if got := advertisedCapabilities(withoutRoots); strings.Join(got, ",") != "system.hostname,system.info" {
		t.Fatalf("unexpected default capabilities: %v", got)
	}
	config := agentConfig{roots: map[string]string{"work": t.TempDir()}, allowScreenCapture: true}
	registration := registrationPacket("PC-001", "DESKTOP-TEST", config)
	if registration.AgentVersion != "0.2.0" || registration.V != 1 {
		t.Fatalf("unexpected registration identity: %#v", registration)
	}
	for _, capability := range []string{"system.hostname", "system.info", "filesystem.list", "filesystem.read", "screen.capture"} {
		if !containsString(registration.Capabilities, capability) {
			t.Errorf("registration omitted capability %q", capability)
		}
	}
	if !containsString(registration.Roots, "work") {
		t.Fatalf("registration omitted root: %#v", registration.Roots)
	}
	if containsString(advertisedCapabilities(agentConfig{allowScreenCapture: false}), "screen.capture") {
		t.Fatal("screen.capture advertised without explicit opt-in")
	}
	if runtime.GOOS != "windows" && containsString(advertisedCapabilities(agentConfig{allowScreenCapture: true}), "screen.capture") {
		t.Fatal("screen.capture advertised on unsupported host")
	}
}

func TestRepeatedRootFlag(t *testing.T) {
	work, docs := t.TempDir(), t.TempDir()
	var flags rootFlags
	if err := flags.Set("work=" + work); err != nil {
		t.Fatalf("work root rejected: %v", err)
	}
	if err := flags.Set("docs=" + docs); err != nil {
		t.Fatalf("docs root rejected: %v", err)
	}
	if err := flags.Set("work=" + docs); err == nil {
		t.Fatal("duplicate root alias accepted")
	}
	if err := flags.Set("relative=not-absolute"); err == nil {
		t.Fatal("relative root accepted")
	}
	config := configFromRoots(flags, false)
	if len(config.roots) != 2 || config.roots["work"] != work || config.roots["docs"] != docs {
		t.Fatalf("unexpected configured roots: %#v", config.roots)
	}
}

func TestScreenCaptureRequiresOptIn(t *testing.T) {
	request := commandPacket("screen", map[string]string{"operation": "capture"})
	result := executeWithConfig(context.Background(), request, "PC-001", agentConfig{})
	if result.Error != "COMMAND_NOT_ALLOWED" {
		t.Fatalf("screen.capture without opt-in returned %q", result.Error)
	}
	if runtime.GOOS != "windows" {
		result = executeWithConfig(context.Background(), request, "PC-001", agentConfig{allowScreenCapture: true})
		if result.Error != "SCREEN_CAPTURE_UNSUPPORTED" {
			t.Fatalf("non-Windows screen.capture returned %q", result.Error)
		}
	}
}

func containsString(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func TestBoundedOutput(t *testing.T) {
	w := &boundedWriter{limit: maxOutput}
	input := []byte(strings.Repeat("x", maxOutput+32))
	n, err := w.Write(input)
	if n != len(input) || err != nil || len(w.data) != maxOutput || !w.truncated {
		t.Fatal("output limit failed")
	}
}

func TestSessionReconnectCleanup(t *testing.T) {
	upgrader := websocket.Upgrader{}
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		var p packet
		if conn.ReadJSON(&p) != nil {
			return
		}
		conn.WriteJSON(packet{V: 1, Type: "registered", DeviceID: "PC-001"})
		conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(4001, "replaced"), time.Now().Add(time.Second))
	}))
	defer server.Close()
	old := websocket.DefaultDialer
	copyDialer := *old
	copyDialer.TLSClientConfig = &tls.Config{RootCAs: server.Client().Transport.(*http.Transport).TLSClientConfig.RootCAs}
	websocket.DefaultDialer = &copyDialer
	defer func() { websocket.DefaultDialer = old }()
	for i := 0; i < 10; i++ {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		err := runSession(ctx, "wss"+strings.TrimPrefix(server.URL, "https"), "PC-001", "unit-test-device-token-value")
		cancel()
		if !websocket.IsCloseError(err, 4001) {
			t.Fatalf("unexpected session end: %T", err)
		}
	}
}

func TestSessionCancellation(t *testing.T) {
	connected := make(chan struct{})
	upgrader := websocket.Upgrader{}
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		var p packet
		if conn.ReadJSON(&p) != nil {
			return
		}
		conn.WriteJSON(packet{V: 1, Type: "registered", DeviceID: "PC-001"})
		close(connected)
		conn.ReadJSON(&p)
	}))
	defer server.Close()
	old := websocket.DefaultDialer
	copyDialer := *old
	copyDialer.TLSClientConfig = &tls.Config{RootCAs: server.Client().Transport.(*http.Transport).TLSClientConfig.RootCAs}
	websocket.DefaultDialer = &copyDialer
	defer func() { websocket.DefaultDialer = old }()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- runSession(ctx, "wss"+strings.TrimPrefix(server.URL, "https"), "PC-001", "unit-test-device-token-value")
	}()
	select {
	case <-connected:
	case <-time.After(3 * time.Second):
		t.Fatal("registration timeout")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("session did not exit on cancellation")
	}
}
