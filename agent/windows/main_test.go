package main

import (
	"context"
	"crypto/tls"
	"net/http"
	"net/http/httptest"
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
