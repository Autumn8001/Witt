package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

const maxOutput = 256 * 1024
const version = "0.1.0"

type packet struct {
	V            int               `json:"v"`
	Type         string            `json:"type"`
	ID           string            `json:"id,omitempty"`
	DeviceID     string            `json:"device_id,omitempty"`
	Hostname     string            `json:"hostname,omitempty"`
	AgentVersion string            `json:"agent_version,omitempty"`
	Tool         string            `json:"tool,omitempty"`
	Args         map[string]string `json:"args,omitempty"`
	TimeoutMS    int               `json:"timeout_ms,omitempty"`
	ExitCode     int               `json:"exit_code"`
	Stdout       string            `json:"stdout,omitempty"`
	Stderr       string            `json:"stderr,omitempty"`
	DurationMS   int64             `json:"duration_ms,omitempty"`
	Error        string            `json:"error,omitempty"`
	Truncated    bool              `json:"truncated,omitempty"`
}

type boundedWriter struct {
	data      []byte
	limit     int
	truncated bool
}

func (w *boundedWriter) Write(p []byte) (int, error) {
	n := len(p)
	remaining := w.limit - len(w.data)
	if remaining > 0 {
		take := n
		if take > remaining {
			take = remaining
		}
		w.data = append(w.data, p[:take]...)
	}
	if n > remaining {
		w.truncated = true
	}
	return n, nil
}

func execute(ctx context.Context, p packet, deviceID string) packet {
	result := packet{V: 1, Type: "result", ID: p.ID, DeviceID: deviceID, ExitCode: 1}
	if p.Type != "command" || p.ID == "" || p.Tool != "system" || len(p.Args) != 1 || p.Args["command"] != "hostname" || p.TimeoutMS < 1000 || p.TimeoutMS > 30000 {
		result.Error = "COMMAND_NOT_ALLOWED"
		return result
	}
	start := time.Now()
	commandCtx, cancel := context.WithTimeout(ctx, time.Duration(p.TimeoutMS)*time.Millisecond)
	defer cancel()
	executable := "hostname"
	if runtime.GOOS == "windows" {
		executable = filepath.Join(os.Getenv("SystemRoot"), "System32", "hostname.exe")
		if !filepath.IsAbs(executable) {
			result.Error = "COMMAND_FAILED"
			return result
		}
	}
	cmd := exec.CommandContext(commandCtx, executable)
	stdout := &boundedWriter{limit: maxOutput}
	stderr := &boundedWriter{limit: maxOutput}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	err := cmd.Run()
	combined := append([]byte(nil), stdout.data...)
	available := maxOutput - len(combined)
	if len(stderr.data) > available {
		stderr.data = stderr.data[:available]
		stderr.truncated = true
	}
	result.Stdout, result.Stderr = string(combined), string(stderr.data)
	result.Truncated = stdout.truncated || stderr.truncated
	result.DurationMS = time.Since(start).Milliseconds()
	if err == nil {
		result.ExitCode = 0
	} else if errors.Is(commandCtx.Err(), context.DeadlineExceeded) {
		result.Error = "COMMAND_TIMEOUT"
	} else {
		result.Error = "COMMAND_FAILED"
	}
	return result
}

func runSession(ctx context.Context, url, deviceID, token string) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	header := http.Header{}
	header.Set("Authorization", "Bearer "+token)
	header.Set("X-Witt-Device-Id", deviceID)
	conn, response, err := websocket.DefaultDialer.DialContext(ctx, url, header)
	if err != nil {
		if response != nil {
			return fmt.Errorf("gateway HTTP %d", response.StatusCode)
		}
		return err
	}
	defer conn.Close()
	var workers sync.WaitGroup
	defer func() { cancel(); conn.Close(); workers.Wait() }()
	var writeMu sync.Mutex
	go func() { <-ctx.Done(); conn.Close() }()
	hostname, _ := os.Hostname()
	if err := conn.WriteJSON(packet{V: 1, Type: "register", DeviceID: deviceID, Hostname: hostname, AgentVersion: version}); err != nil {
		return err
	}
	conn.SetReadLimit(300 * 1024)
	conn.SetReadDeadline(time.Now().Add(65 * time.Second))
	var registered packet
	if err := conn.ReadJSON(&registered); err != nil {
		return err
	}
	if registered.V != 1 || registered.Type != "registered" || registered.DeviceID != deviceID {
		return errors.New("registration rejected")
	}
	log.Printf("registered device %s", deviceID)
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	workers.Add(1)
	go func() {
		defer workers.Done()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				writeMu.Lock()
				conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
				err := conn.WriteJSON(packet{V: 1, Type: "heartbeat", ID: fmt.Sprintf("h-%d", time.Now().UnixNano())})
				writeMu.Unlock()
				if err != nil {
					conn.Close()
					return
				}
			}
		}
	}()
	busy := make(chan struct{}, 1)
	for {
		if ctx.Err() != nil {
			conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""), time.Now().Add(time.Second))
			return nil
		}
		conn.SetReadDeadline(time.Now().Add(65 * time.Second))
		var p packet
		err := conn.ReadJSON(&p)
		if err != nil {
			return err
		}
		if p.V != 1 {
			return errors.New("unsupported protocol")
		}
		if p.Type == "heartbeat_ack" {
			continue
		}
		if p.Type != "command" {
			return errors.New("unsupported message")
		}
		select {
		case busy <- struct{}{}:
		default:
			return errors.New("concurrent command rejected")
		}
		workers.Add(1)
		go func(command packet) {
			defer workers.Done()
			defer func() { <-busy }()
			result := execute(ctx, command, deviceID)
			if ctx.Err() != nil {
				return
			}
			writeMu.Lock()
			defer writeMu.Unlock()
			conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
			if conn.WriteJSON(result) != nil {
				conn.Close()
			}
		}(p)
	}
}

func main() {
	endpoint := flag.String("gateway", "", "WSS gateway URL")
	deviceID := flag.String("device-id", "", "configured device ID")
	tokenFile := flag.String("token-file", "", "file containing this device's bearer token")
	flag.Parse()
	parsed, parseErr := url.Parse(*endpoint)
	if parseErr != nil || parsed.Scheme != "wss" || parsed.Host == "" || parsed.User != nil ||
		parsed.RawQuery != "" || parsed.Fragment != "" || !regexp.MustCompile("^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$").MatchString(*deviceID) || *tokenFile == "" {
		log.Fatal("gateway must be wss://; device-id and token-file are required")
	}
	raw, err := os.ReadFile(*tokenFile)
	if err != nil {
		log.Fatal("cannot read token file")
	}
	token := strings.TrimSpace(string(raw))
	if len(token) < 24 || len(token) > 512 || strings.ContainsAny(token, "\r\n") {
		log.Fatal("invalid token file")
	}
	for i := range raw {
		raw[i] = 0
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	delay := time.Second
	for ctx.Err() == nil {
		err := runSession(ctx, *endpoint, *deviceID, token)
		if ctx.Err() != nil {
			break
		}
		if err != nil && !errors.Is(err, io.EOF) {
			if websocket.IsCloseError(err, 4001) {
				log.Print("device session replaced; exiting")
				return
			}
			log.Print("connection ended; retrying")
		}
		jitter := time.Duration(rand.Int63n(int64(delay / 2)))
		select {
		case <-ctx.Done():
			return
		case <-time.After(delay + jitter):
		}
		if delay < 30*time.Second {
			delay *= 2
			if delay > 30*time.Second {
				delay = 30 * time.Second
			}
		}
	}
}
