package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func TestBrowserLocalAPIRejectsForeignOriginsAndMissingSecret(t *testing.T) {
	b := &assistBrowser{origin: "http://127.0.0.1:43210", secret: assistRandom(), state: "unpaired", done: make(chan struct{})}
	for _, c := range []struct {
		host, origin, token string
		want                int
	}{
		{"127.0.0.1:43210", b.origin, "", 403},
		{"127.0.0.1:43210", "https://evil.example", b.secret, 403},
		{"evil.example", b.origin, b.secret, 403},
		{"127.0.0.1:43210", "", b.secret, 403},
		{"127.0.0.1:43210", b.origin, b.secret, 200},
	} {
		r := httptest.NewRequest("POST", "http://"+c.host+"/api/status", strings.NewReader("{}"))
		r.Header.Set("Origin", c.origin)
		r.Header.Set("Authorization", "Bearer "+c.token)
		w := httptest.NewRecorder()
		b.ServeHTTP(w, r)
		if w.Code != c.want {
			t.Fatalf("host=%s origin=%s: %d", c.host, c.origin, w.Code)
		}
		if strings.Contains(w.Body.String(), b.secret) {
			t.Fatal("secret leaked in response")
		}
	}
}
func TestBrowserApprovalIsBoundAndCancelled(t *testing.T) {
	b := &assistBrowser{done: make(chan struct{})}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan bool, 1)
	go func() { done <- b.confirm(ctx, "sample.txt", "-before\n+after") }()
	for n := 0; n < 100; n++ {
		b.mu.Lock()
		a := b.approval
		b.mu.Unlock()
		if a != nil {
			break
		}
		time.Sleep(time.Millisecond)
	}
	cancel()
	select {
	case allowed := <-done:
		if allowed {
			t.Fatal("cancelled edit approved")
		}
	case <-time.After(time.Second):
		t.Fatal("approval did not cancel")
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.approval != nil {
		t.Fatal("pending approval retained")
	}
}

func TestFolderPickerDoesNotBlockBrowserAndCanBeCancelled(t *testing.T) {
	previous := chooseAssistFolder
	started, cancelled := make(chan struct{}), make(chan struct{})
	chooseAssistFolder = func(ctx context.Context) (string, error) {
		close(started)
		<-ctx.Done()
		close(cancelled)
		return "late-result", ctx.Err()
	}
	defer func() { chooseAssistFolder = previous }()
	b := &assistBrowser{origin: "http://127.0.0.1:43210", secret: assistRandom(), state: "unpaired", root: "original", done: make(chan struct{})}
	request := func(route string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", b.origin+route, strings.NewReader("{}"))
		r.Header.Set("Origin", b.origin)
		r.Header.Set("Authorization", "Bearer "+b.secret)
		w := httptest.NewRecorder()
		b.ServeHTTP(w, r)
		return w
	}
	if w := request("/api/folder"); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("picker did not start")
	}
	if w := request("/api/status"); !strings.Contains(w.Body.String(), `"folder_pending":true`) {
		t.Fatal(w.Body.String())
	}
	if w := request("/api/folder-cancel"); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("picker did not cancel")
	}
	b.mu.Lock()
	if b.root != "original" || b.folderPending {
		t.Error("cancelled picker changed scope or remained pending")
	}
	b.mu.Unlock()
	b.stop()
}

// Test-only launcher: the real browser controller/lifecycle is exercised with
// Playwright without changing the user's default browser or registering URLs.
func TestAssistBrowserFixture(t *testing.T) {
	file := os.Getenv("ASSIST_BROWSER_FIXTURE")
	if file == "" {
		t.Skip("explicit isolated fixture only")
	}
	var options assistOptions
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(data, &options); err != nil {
		t.Fatal(err)
	}
	launchAssistBrowser = func(address string) error { return os.WriteFile(file+".url", []byte(address), 0600) }
	defer func() { launchAssistBrowser = openAssistBrowser }()
	if err = showAssistBrowser(options); err != nil {
		t.Fatal(err)
	}
}

// Isolated local UI fixture: invokes the real approval controller and API,
// without pairing to production or executing a customer command.
func TestAssistApprovalUIFixture(t *testing.T) {
	file := os.Getenv("ASSIST_APPROVAL_FIXTURE")
	if file == "" {
		t.Skip("explicit isolated UI fixture only")
	}
	b := &assistBrowser{secret: assistRandom(), state: "connected", done: make(chan struct{}), updater: newAssistUpdater()}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/fixture/approval" {
			b.ServeHTTP(w, r)
			return
		}
		if r.Method != "POST" || r.Header.Get("Origin") != b.origin || r.Header.Get("Authorization") != "Bearer "+b.secret {
			http.Error(w, "forbidden", 403)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 4*time.Second)
		defer cancel()
		ok := b.confirm(ctx, "命令执行：powershell.exe", "program: powershell.exe\nargv: [\"-NoProfile\",\"-Command\",\"Get-Service\"]\ncwd: D:\\test-workspace\ntimeout_ms: 30000\n此处仅测试确认界面，不执行命令。")
		json.NewEncoder(w).Encode(map[string]bool{"allowed": ok})
	}))
	defer server.Close()
	b.origin = server.URL
	if err := os.WriteFile(file+".url", []byte(b.origin+"/#"+b.secret), 0600); err != nil {
		t.Fatal(err)
	}
	select {
	case <-b.done:
	case <-time.After(time.Minute):
		t.Fatal("approval UI fixture not stopped")
	}
}
