package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestAssistRequiresLocalConsentAndBoundSession(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "sample.txt")
	os.WriteFile(path, []byte("before\n"), 0600)
	a := &assistPolicy{sessionID: "test-session", expires: time.Now().Add(time.Minute), capabilities: []string{"workspace.read", "workspace.write"}}
	config := agentConfig{roots: map[string]string{"project": root}, assist: a}
	p := workspacePacket("read", map[string]any{"root": "project", "path": "sample.txt"})
	if r := executeWithConfig(context.Background(), p, "test", config); r.Error != "ASSIST_SCOPE_DENIED" {
		t.Fatal("missing session accepted")
	}
	p.WorkspaceSessionID = a.sessionID
	if r := executeWithConfig(context.Background(), p, "test", config); r.Error != "" {
		t.Fatalf("authorized read: %s", r.Error)
	}
	a.paused = true
	if r := executeWithConfig(context.Background(), p, "test", config); r.Error != "ASSIST_NOT_ACTIVE" {
		t.Fatal("paused read accepted")
	}
	a.paused = false
	w := workspacePacket("write", map[string]any{"root": "project", "path": "sample.txt", "content": "after\n", "expected_sha256": hashBytes([]byte("before\n"))})
	w.WorkspaceSessionID = a.sessionID
	if r := executeWithConfig(context.Background(), w, "test", config); r.Error != "CLIENT_DECLINED" {
		t.Fatalf("write without consent: %s", r.Error)
	}
	a.approve = func(ctx context.Context, path, diff string) bool {
		if !strings.Contains(diff, "- before") || !strings.Contains(diff, "+ after") {
			t.Fatal("missing diff")
		}
		return true
	}
	r := executeWithConfig(context.Background(), w, "test", config)
	if r.Error != "" || !strings.Contains(r.Stdout, "before_sha256") {
		t.Fatalf("approved edit: %#v", r)
	}
	data, _ := os.ReadFile(path)
	if string(data) != "after\n" {
		t.Fatal("edit not written")
	}
	a.expires = time.Now().Add(-time.Second)
	if r := executeWithConfig(context.Background(), p, "test", config); r.Error != "ASSIST_NOT_ACTIVE" {
		t.Fatal("expired read accepted")
	}
}

func TestAssistCannotEscapeOrExecuteShell(t *testing.T) {
	a := &assistPolicy{sessionID: "test", expires: time.Now().Add(time.Minute), capabilities: []string{"workspace.read"}}
	config := agentConfig{roots: map[string]string{"project": t.TempDir()}, assist: a}
	for _, file := range []string{"../outside.txt", "D:/outside.txt"} {
		p := workspacePacket("read", map[string]any{"root": "project", "path": file})
		p.WorkspaceSessionID = "test"
		if r := executeWithConfig(context.Background(), p, "test", config); r.Error == "" {
			t.Fatal("outside read accepted")
		}
	}
	p := workspacePacket("exec", map[string]any{"root": "project", "program": "powershell", "argv": []string{"-Command", "echo bad"}})
	p.WorkspaceSessionID = "test"
	if r := executeWithConfig(context.Background(), p, "test", config); r.Error != "ASSIST_SCOPE_DENIED" {
		t.Fatal("exec capability accepted")
	}
	if _, e := assistChange("file", strings.Repeat("a", 65537), ""); e == nil {
		t.Fatal("oversize diff accepted")
	}
}

func TestAssistRejectsWindowsJunctionEscape(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows junction test")
	}
	root, outside := t.TempDir(), t.TempDir()
	if e := os.WriteFile(filepath.Join(outside, "sentinel.txt"), []byte("outside"), 0600); e != nil {
		t.Fatal(e)
	}
	link := filepath.Join(root, "escape")
	if out, e := exec.Command("cmd.exe", "/c", "mklink", "/J", link, outside).CombinedOutput(); e != nil {
		t.Fatalf("cannot create test junction: %v %s", e, out)
	}
	if data, e := os.ReadFile(filepath.Join(link, "sentinel.txt")); e != nil || string(data) != "outside" {
		t.Fatalf("test junction does not resolve: %v", e)
	}
	a := &assistPolicy{sessionID: "junction-test", expires: time.Now().Add(time.Minute), capabilities: []string{"workspace.read"}}
	p := workspacePacket("read", map[string]any{"root": "project", "path": "escape/sentinel.txt"})
	p.WorkspaceSessionID = a.sessionID
	result := executeWithConfig(context.Background(), p, "test", agentConfig{roots: map[string]string{"project": root}, assist: a})
	if (result.Error != "PATH_OUTSIDE_ROOT" && result.Error != "PATH_NOT_FOUND") || result.Stdout != "" {
		t.Fatalf("junction escaped: %#v", result)
	}
}

func TestAssistCommandsNeedExplicitLocalApproval(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows command authorization")
	}
	root := t.TempDir()
	a := &assistPolicy{sessionID: "command-test", expires: time.Now().Add(time.Minute), capabilities: []string{"workspace.exec", "workspace.read", "workspace.system_info"}}
	config := agentConfig{roots: map[string]string{"project": root}, assist: a}
	marker := filepath.Join(root, "command-marker.txt")
	script := "[System.IO.File]::WriteAllText('command-marker.txt','approved')"
	p := workspacePacket("exec", map[string]any{"root": "project", "program": "powershell.exe", "argv": []string{"-NoProfile", "-NonInteractive", "-Command", script}, "timeout_ms": 30000})
	p.TimeoutMS = 90000
	p.WorkspaceSessionID = a.sessionID
	if r := executeWithConfig(context.Background(), p, "test", config); r.Error != "CLIENT_DECLINED" {
		t.Fatalf("no callback: %#v", r)
	}
	a.approve = func(ctx context.Context, title, preview string) bool {
		if !strings.Contains(preview, script) || !strings.Contains(preview, root[:2]) || !strings.Contains(preview, "目录之外") {
			t.Fatal("incomplete command disclosure")
		}
		return false
	}
	if r := executeWithConfig(context.Background(), p, "test", config); r.Error != "CLIENT_DECLINED" {
		t.Fatalf("decline: %#v", r)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("command executed without consent")
	}
	a.approve = func(context.Context, string, string) bool { return true }
	if r := executeWithConfig(context.Background(), p, "test", config); r.Error != "" || r.ExitCode != 0 {
		t.Fatalf("approved command: %#v", r)
	}
	data, _ := os.ReadFile(marker)
	if string(data) != "approved" {
		t.Fatal("approved command did not execute")
	}
	read := workspacePacket("read", map[string]any{"root": "project", "path": "../outside.txt"})
	read.WorkspaceSessionID = a.sessionID
	if r := executeWithConfig(context.Background(), read, "test", config); r.Error == "" {
		t.Fatal("command grant expanded file tool scope")
	}
	info := workspacePacket("system_info", map[string]any{})
	info.WorkspaceSessionID = a.sessionID
	if r := executeWithConfig(context.Background(), info, "test", config); r.Error != "" {
		t.Fatalf("host scoped info: %#v", r)
	}
	diagnostic := workspacePacket("exec", map[string]any{"root": "project", "program": "powershell.exe", "argv": []string{"-NoProfile", "-NonInteractive", "-Command", "Get-Service | Select-Object -First 3 Name,Status | ConvertTo-Json -Compress"}})
	diagnostic.TimeoutMS = 90000
	diagnostic.WorkspaceSessionID = a.sessionID
	if r := executeWithConfig(context.Background(), diagnostic, "test", config); r.Error != "" || r.ExitCode != 0 || !strings.Contains(r.Stdout, "Status") {
		t.Fatalf("real service diagnostic failed: %s/%d", r.Error, r.ExitCode)
	}
	a.approve = func(context.Context, string, string) bool { a.Lock(); a.paused = true; a.Unlock(); return true }
	if r := executeWithConfig(context.Background(), diagnostic, "test", config); r.Error != "ASSIST_NOT_ACTIVE" {
		t.Fatalf("pause during approval: %#v", r)
	}
}

func TestAssistCancelsRunningCommand(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows cancellation")
	}
	root := t.TempDir()
	a := &assistPolicy{sessionID: "cancel-test", expires: time.Now().Add(time.Minute), capabilities: []string{"workspace.exec"}, approve: func(context.Context, string, string) bool { return true }}
	p := workspacePacket("exec", map[string]any{"root": "project", "program": "powershell.exe", "argv": []string{"-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 20; [IO.File]::WriteAllText('must-not-exist.txt','bad')"}})
	p.WorkspaceSessionID = a.sessionID
	p.TimeoutMS = 90000
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	time.AfterFunc(500*time.Millisecond, cancel)
	start := time.Now()
	result := executeWithConfig(ctx, p, "test", agentConfig{roots: map[string]string{"project": root}, assist: a})
	if result.Error != "EXECUTION_STATE_UNKNOWN" || result.ExecutionState != "unknown" {
		t.Fatalf("cancelled command: %#v", result)
	}
	if time.Since(start) > 5*time.Second {
		t.Fatal("cancellation did not return promptly")
	}
	if _, err := os.Stat(filepath.Join(root, "must-not-exist.txt")); !os.IsNotExist(err) {
		t.Fatal("cancelled command completed side effect")
	}
}
