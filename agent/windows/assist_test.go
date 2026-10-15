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
