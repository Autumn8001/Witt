//go:build windows

package main

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unsafe"
)

func approvalTestWindow(t *testing.T) uintptr {
	t.Helper()
	end := time.Now().Add(5 * time.Second)
	for time.Now().Before(end) {
		hwnd := assistCall("FindWindowW", uintptr(unsafe.Pointer(assistStr("ChloeAssistApproval"))), 0)
		if hwnd != 0 && assistCall("IsWindowVisible", hwnd) != 0 {
			return hwnd
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("native approval window did not become visible")
	return 0
}

func TestBrowserNativeApprovalControlsRealWindowsCommand(t *testing.T) {
	for _, allow := range []bool{false, true} {
		t.Run(map[bool]string{false: "reject", true: "allow"}[allow], func(t *testing.T) {
			root := t.TempDir()
			b := &assistBrowser{done: make(chan struct{}), notifyApproval: notifyAssistApproval}
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			policy := &assistPolicy{sessionID: "native-approval-test", expires: time.Now().Add(time.Minute), capabilities: []string{"workspace.exec"}, approve: b.confirm}
			config := agentConfig{roots: map[string]string{"project": root}, assist: policy}
			p := workspacePacket("exec", map[string]any{"root": "project", "program": "powershell.exe", "argv": []string{"-NoProfile", "-NonInteractive", "-Command", "Get-Service | Select-Object -First 1 Name,Status | ConvertTo-Json -Compress; Write-Output chloe-native-approved"}})
			p.TimeoutMS = 90000
			p.WorkspaceSessionID = policy.sessionID
			result := make(chan packet, 1)
			go func() { result <- executeWithConfig(ctx, p, "fixture", config) }()
			hwnd := approvalTestWindow(t)
			defer assistCall("PostMessageW", hwnd, 0x10, 0, 0)
			details := assistGet(assistCall("GetDlgItem", hwnd, 302))
			if !strings.Contains(details, "Get-Service") || !strings.Contains(details, filepath.Clean(root)[:2]) || !strings.Contains(details, "目录之外") {
				t.Fatal("native preview omitted intent or risk")
			}
			if assistCall("GetWindowLongPtrW", hwnd, ^uintptr(19))&8 == 0 {
				t.Fatal("approval window is not topmost")
			}
			select {
			case <-result:
				t.Fatal("command ran before consent")
			default:
			}
			button := uintptr(304)
			if allow {
				button = 303
			}
			assistCall("PostMessageW", hwnd, 0x111, button, 0)
			select {
			case r := <-result:
				if allow {
					if r.Error != "" || !strings.Contains(r.Stdout, "chloe-native-approved") {
						t.Fatalf("approved Get-Service: %s / %s", r.Error, r.Stdout)
					}
				} else if r.Error != "CLIENT_DECLINED" {
					t.Fatalf("decline: %s", r.Error)
				}
			case <-ctx.Done():
				t.Fatal("native decision did not resolve command")
			}
			deadline := time.Now().Add(2 * time.Second)
			for assistCall("IsWindow", hwnd) != 0 && time.Now().Before(deadline) {
				time.Sleep(10 * time.Millisecond)
			}
			if assistCall("IsWindow", hwnd) != 0 {
				t.Fatal("resolved window remained open")
			}
		})
	}
}

func TestNativeApprovalClosesOnExpiryAndBrowserDecision(t *testing.T) {
	for _, mode := range []string{"expiry", "browser"} {
		t.Run(mode, func(t *testing.T) {
			b := &assistBrowser{done: make(chan struct{}), notifyApproval: notifyAssistApproval}
			ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
			defer cancel()
			result := make(chan bool, 1)
			go func() { result <- b.confirm(ctx, "test.txt", "-before\n+after") }()
			hwnd := approvalTestWindow(t)
			defer assistCall("PostMessageW", hwnd, 0x10, 0, 0)
			b.mu.Lock()
			id := b.approval.ID
			b.mu.Unlock()
			if b.decide("wrong-id", true) {
				t.Fatal("unbound decision accepted")
			}
			if mode == "browser" && !b.decide(id, true) {
				t.Fatal("browser decision rejected")
			}
			select {
			case ok := <-result:
				if ok != (mode == "browser") {
					t.Fatal("unexpected approval result")
				}
			case <-time.After(3 * time.Second):
				t.Fatal("approval did not resolve")
			}
			if b.decide(id, true) {
				t.Fatal("stale decision accepted")
			}
			deadline := time.Now().Add(2 * time.Second)
			for assistCall("IsWindow", hwnd) != 0 && time.Now().Before(deadline) {
				time.Sleep(10 * time.Millisecond)
			}
			if assistCall("IsWindow", hwnd) != 0 {
				t.Fatal("cancelled native window remained open")
			}
		})
	}
}
