package main

import (
	"context"
	"encoding/json"
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
