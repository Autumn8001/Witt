package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func hostnamePacket() packet {
	return packet{V: 1, Type: "command", ID: "test-command", Tool: "system", Args: argsJSON(map[string]string{"command": "hostname"}), TimeoutMS: 1000}
}

func argsJSON(value any) json.RawMessage {
	data, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return data
}

func TestHostnameAllowlist(t *testing.T) {
	valid := hostnamePacket()
	result := execute(context.Background(), valid, "PC-001")
	if result.ExitCode != 0 || strings.TrimSpace(result.Stdout) == "" {
		t.Fatalf("hostname failed: %s", result.Error)
	}
	for _, mutate := range []func(*packet){
		func(p *packet) { p.Args = argsJSON(map[string]string{"command": "hostname", "extra": "x"}) },
		func(p *packet) { p.Args = argsJSON(map[string]string{"command": "powershell"}) },
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
	return packet{V: 1, Type: "command", ID: "test-command", Tool: tool, Args: argsJSON(args), TimeoutMS: 1000}
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
	if got := advertisedCapabilities(withoutRoots); strings.Join(got, ",") != "system.hostname,system.info,workspace.system_info" {
		t.Fatalf("unexpected default capabilities: %v", got)
	}
	config := agentConfig{roots: map[string]string{"work": t.TempDir()}, allowScreenCapture: true}
	registration := registrationPacket("PC-001", "DESKTOP-TEST", config)
	if registration.AgentVersion != version || registration.V != 1 {
		t.Fatalf("unexpected registration identity: %#v", registration)
	}
	expected := []string{"system.hostname", "system.info", "filesystem.list", "filesystem.read", "workspace.list", "workspace.stat", "workspace.read", "workspace.search", "workspace.write", "workspace.patch", "workspace.exec", "workspace.git_status", "workspace.git_diff", "workspace.system_info"}
	if runtime.GOOS == "windows" {
		expected = append(expected, "screen.capture")
	}
	for _, capability := range expected {
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

func workspacePacket(operation string, args map[string]any) packet {
	args["operation"] = operation
	return packet{V: 1, Type: "command", ID: "workspace-test", Tool: "workspace", Args: argsJSON(args), TimeoutMS: 5000}
}

func TestWorkspaceRejectsTraversalADSAndDeviceNames(t *testing.T) {
	root := t.TempDir()
	config := agentConfig{roots: map[string]string{"work": root}}
	for _, path := range []string{"../x", `..\\x`, `C:\\x`, `\\\\host\\share`, "file.txt:secret", "con", "NUL.txt", "dir.", "dir "} {
		result := executeWithConfig(context.Background(), workspacePacket("read", map[string]any{"root": "work", "path": path}), "PC-001", config)
		if result.Error != "PATH_NOT_ALLOWED" && result.Error != "PATH_OUTSIDE_ROOT" {
			t.Errorf("path %q returned %q", path, result.Error)
		}
	}
}

func TestWorkspaceWriteHashAndPatchPreconditions(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "code.txt")
	if err := os.WriteFile(path, []byte("one\ntwo\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	config := agentConfig{roots: map[string]string{"work": root}}
	badWrite := executeWithConfig(context.Background(), workspacePacket("write", map[string]any{
		"root": "work", "path": "code.txt", "content": "changed", "expected_sha256": strings.Repeat("0", 64),
	}), "PC-001", config)
	if badWrite.Error != "HASH_MISMATCH" || badWrite.ExecutionState != "not_started" {
		t.Fatalf("write mismatch: %#v", badWrite)
	}
	if data, _ := os.ReadFile(path); string(data) != "one\ntwo\n" {
		t.Fatal("mismatched write changed file")
	}
	hash := hashBytes([]byte("one\ntwo\n"))
	badPatch := executeWithConfig(context.Background(), workspacePacket("patch", map[string]any{
		"root": "work", "path": "code.txt", "expected_sha256": hash, "before": "absent", "after": "new",
	}), "PC-001", config)
	if badPatch.Error != "PATCH_MISMATCH" || badPatch.ExecutionState != "not_started" {
		t.Fatalf("patch mismatch: %#v", badPatch)
	}
	duplicatePatch := executeWithConfig(context.Background(), workspacePacket("patch", map[string]any{
		"root": "work", "path": "code.txt", "expected_sha256": hash, "before": "o", "after": "x",
	}), "PC-001", config)
	if duplicatePatch.Error != "PATCH_MISMATCH" {
		t.Fatalf("ambiguous patch: %#v", duplicatePatch)
	}
	goodPatch := executeWithConfig(context.Background(), workspacePacket("patch", map[string]any{
		"root": "work", "path": "code.txt", "expected_sha256": hash, "before": "two", "after": "three",
	}), "PC-001", config)
	if goodPatch.ExitCode != 0 || goodPatch.ExecutionState != "completed" {
		t.Fatalf("good patch: %#v", goodPatch)
	}
	if data, _ := os.ReadFile(path); string(data) != "one\nthree\n" {
		t.Fatalf("patch did not update content: %q", data)
	}
}

func TestWorkspaceReadStatSearchAndCreate(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	config := agentConfig{roots: map[string]string{"work": root}}
	created := executeWithConfig(context.Background(), workspacePacket("write", map[string]any{
		"root": "work", "path": "src/sample.txt", "content": "one needle\ntwo\n", "expected_sha256": "",
	}), "PC-001", config)
	if created.ExitCode != 0 {
		t.Fatalf("create failed: %#v", created)
	}
	read := executeWithConfig(context.Background(), workspacePacket("read", map[string]any{"root": "work", "path": "src/sample.txt"}), "PC-001", config)
	var file map[string]string
	if read.ExitCode != 0 || json.Unmarshal([]byte(read.Stdout), &file) != nil || file["content"] != "one needle\ntwo\n" || len(file["sha256"]) != 64 {
		t.Fatalf("read result: %#v", read)
	}
	stat := executeWithConfig(context.Background(), workspacePacket("stat", map[string]any{"root": "work", "path": "src/sample.txt"}), "PC-001", config)
	if stat.ExitCode != 0 || !strings.Contains(stat.Stdout, `"type":"file"`) {
		t.Fatalf("stat result: %#v", stat)
	}
	search := executeWithConfig(context.Background(), workspacePacket("search", map[string]any{"root": "work", "path": ".", "query": "needle"}), "PC-001", config)
	if search.ExitCode != 0 || !strings.Contains(search.Stdout, `"path":"src/sample.txt"`) {
		t.Fatalf("search result: %#v", search)
	}
}

func TestWorkspaceExecPolicyAndGit(t *testing.T) {
	root := t.TempDir()
	config := agentConfig{roots: map[string]string{"work": root}}
	deny := executeWithConfig(context.Background(), workspacePacket("exec", map[string]any{
		"root": "work", "cwd": ".", "program": "powershell", "argv": []string{"-Command", "Get-ChildItem"},
	}), "PC-001", config)
	if deny.Error != "COMMAND_DENIED" || deny.ExecutionState != "not_started" {
		t.Fatalf("shell was not denied: %#v", deny)
	}
	destructive := executeWithConfig(context.Background(), workspacePacket("exec", map[string]any{
		"root": "work", "cwd": ".", "program": "git", "argv": []string{"reset", "--hard"},
	}), "PC-001", config)
	if destructive.Error != "COMMAND_DENIED" {
		t.Fatalf("destructive git operation was not denied: %#v", destructive)
	}
	unknown := executeWithConfig(context.Background(), workspacePacket("exec", map[string]any{
		"root": "work", "cwd": ".", "program": "made-up-tool", "argv": []string{},
	}), "PC-001", config)
	if unknown.Error != "COMMAND_DENIED" {
		t.Fatalf("unknown program was not denied: %#v", unknown)
	}
	inlineCode := executeWithConfig(context.Background(), workspacePacket("exec", map[string]any{
		"root": "work", "cwd": ".", "program": "node", "argv": []string{"-e", "process.exit(0)"},
	}), "PC-001", config)
	if inlineCode.Error != "COMMAND_DENIED" {
		t.Fatalf("inline code execution was not denied: %#v", inlineCode)
	}
	needsApproval := executeWithConfig(context.Background(), workspacePacket("exec", map[string]any{
		"root": "work", "cwd": ".", "program": "git", "argv": []string{"commit", "-m", "x"},
	}), "PC-001", config)
	if needsApproval.Error != "APPROVAL_REQUIRED" {
		t.Fatalf("confirm command did not require approval: %#v", needsApproval)
	}
	git, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git not installed in test environment")
	}
	for _, argv := range [][]string{{"init"}, {"config", "user.email", "agent@example.invalid"}, {"config", "user.name", "Agent Test"}} {
		cmd := exec.Command(git, argv...)
		cmd.Dir = root
		if output, runErr := cmd.CombinedOutput(); runErr != nil {
			t.Fatalf("git %v: %v: %s", argv, runErr, output)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "main.go"), []byte("package test\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, argv := range [][]string{{"add", "main.go"}, {"commit", "-m", "initial"}} {
		cmd := exec.Command(git, argv...)
		cmd.Dir = root
		if output, runErr := cmd.CombinedOutput(); runErr != nil {
			t.Fatalf("git %v: %v: %s", argv, runErr, output)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "main.go"), []byte("package changed\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	status := executeWithConfig(context.Background(), workspacePacket("git_status", map[string]any{"root": "work", "cwd": "."}), "PC-001", config)
	if status.ExitCode != 0 || !strings.Contains(status.Stdout, " M main.go") {
		t.Fatalf("git status: %#v", status)
	}
	diff := executeWithConfig(context.Background(), workspacePacket("git_diff", map[string]any{"root": "work", "cwd": "."}), "PC-001", config)
	if diff.ExitCode != 0 || !strings.Contains(diff.Stdout, "package changed") {
		t.Fatalf("git diff: %#v", diff)
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

func TestScreenshotEncodingResizesAndBounds(t *testing.T) {
	source := image.NewRGBA(image.Rect(0, 0, 2000, 1000))
	for y := 0; y < source.Bounds().Dy(); y++ {
		for x := 0; x < source.Bounds().Dx(); x++ {
			source.SetRGBA(x, y, color.RGBA{R: uint8(x % 251), G: uint8(y % 251), B: uint8((x + y) % 251), A: 0xff})
		}
	}
	encoded, err := encodeScreenshot(source)
	if err != nil {
		t.Fatalf("encodeScreenshot failed: %v", err)
	}
	if len(encoded) > maxScreenshotBytes {
		t.Fatalf("screenshot exceeds attachment limit: %d", len(encoded))
	}
	config, err := jpeg.DecodeConfig(bytes.NewReader(encoded))
	if err != nil {
		t.Fatalf("encoded screenshot is not JPEG: %v", err)
	}
	if max(config.Width, config.Height) > maxScreenshotDimension {
		t.Fatalf("screenshot dimensions exceed limit: %dx%d", config.Width, config.Height)
	}
}

func TestScreenshotEncodingRejectsEmptyImage(t *testing.T) {
	if _, err := encodeScreenshot(nil); err == nil || err.Error() != "SCREEN_CAPTURE_FAILED" {
		t.Fatalf("empty screenshot returned unexpected error: %v", err)
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

func TestFullAccessOutsideProject(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	file := filepath.Join(outside, "sample.txt")
	config := agentConfig{roots: map[string]string{"work": root}}
	args := map[string]any{"root": "work", "path": file, "content": "outside", "expected_sha256": ""}
	denied := executeWithConfig(context.Background(), workspacePacket("write", args), "PC-001", config)
	if denied.Error == "" {
		t.Fatal("bounded device accepted outside file")
	}
	config.fullAccess = true
	written := executeWithConfig(context.Background(), workspacePacket("write", args), "PC-001", config)
	if written.Error != "" {
		t.Fatalf("full access write: %s", written.Error)
	}
	read := executeWithConfig(context.Background(), workspacePacket("read", map[string]any{"root": "work", "path": file}), "PC-001", config)
	if read.Error != "" || !strings.Contains(read.Stdout, "outside") {
		t.Fatalf("full access read: %#v", read)
	}
	args["content"] = "overwrite"
	conflict := executeWithConfig(context.Background(), workspacePacket("write", args), "PC-001", config)
	if conflict.Error == "" {
		t.Fatal("full access bypassed write hash")
	}
	imagePath := filepath.Join(outside, "image.jpg")
	f, err := os.Create(imagePath)
	if err != nil {
		t.Fatal(err)
	}
	if err = jpeg.Encode(f, image.NewRGBA(image.Rect(0, 0, 20, 10)), nil); err != nil {
		t.Fatal(err)
	}
	f.Close()
	pic := executeWithConfig(context.Background(), workspacePacket("read_image", map[string]any{"root": "work", "path": imagePath}), "PC-001", config)
	if pic.Error != "" || pic.Mime != "image/jpeg" || len(pic.Data) == 0 {
		t.Fatalf("image response missing: %s", pic.Error)
	}
	if runtime.GOOS == "windows" {
		result := executeWithConfig(context.Background(), workspacePacket("exec", map[string]any{"root": "work", "cwd": outside, "program": "powershell.exe", "argv": []string{"-NoProfile", "-Command", "Write-Output full-access-ok"}}), "PC-001", config)
		if result.Error != "" || !strings.Contains(result.Stdout, "full-access-ok") {
			t.Fatalf("full exec: %#v", result)
		}
	}
}
