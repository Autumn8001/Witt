package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
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
	"os/user"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/gorilla/websocket"
)

const maxOutput = 256 * 1024
const maxFileRead = 256 * 1024
const maxListEntries = 200
const maxScreenshotBytes = 1280 * 1024
const version = "0.4.0"

var deviceIDPattern = regexp.MustCompile("^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
var drivePathPattern = regexp.MustCompile(`^[A-Za-z]:`)

type agentConfig struct {
	// roots contains canonical absolute paths. Keeping only canonical paths here
	// means every operation uses the same boundary that was checked at startup.
	roots              map[string]string
	allowScreenCapture bool
	fullAccess         bool
	assist             *assistPolicy
	dialer             *websocket.Dialer
}

type rootFlags struct {
	values map[string]string
}

func (r *rootFlags) String() string {
	if r == nil || len(r.values) == 0 {
		return ""
	}
	parts := make([]string, 0, len(r.values))
	for alias, path := range r.values {
		parts = append(parts, alias+"="+path)
	}
	return strings.Join(parts, ",")
}

func (r *rootFlags) Set(value string) error {
	alias, path, ok := strings.Cut(value, "=")
	if !ok || !deviceIDPattern.MatchString(alias) || strings.TrimSpace(path) == "" {
		return errors.New("root must be alias=absolutePath")
	}
	path = strings.TrimSpace(path)
	if !filepath.IsAbs(path) || strings.ContainsRune(path, '\x00') {
		return errors.New("root path must be absolute")
	}
	canonical, err := filepath.EvalSymlinks(path)
	if err != nil {
		return errors.New("root path must exist")
	}
	info, err := os.Stat(canonical)
	if err != nil || !info.IsDir() {
		return errors.New("root path must be a directory")
	}
	if r.values == nil {
		r.values = make(map[string]string)
	}
	if _, exists := r.values[alias]; exists {
		return errors.New("duplicate root alias")
	}
	r.values[alias] = canonical
	return nil
}

func configFromRoots(roots rootFlags, allowScreenCapture bool) agentConfig {
	values := make(map[string]string, len(roots.values))
	for alias, path := range roots.values {
		values[alias] = path
	}
	return agentConfig{roots: values, allowScreenCapture: allowScreenCapture}
}

func advertisedCapabilities(config agentConfig) []string {
	capabilities := []string{"system.hostname", "system.info", "workspace.system_info"}
	if len(config.roots) > 0 {
		// filesystem.* is retained for already-deployed servers during the
		// protocol rollout. New Remote Workspace sessions use workspace.*.
		capabilities = append(capabilities, "filesystem.list", "filesystem.read",
			"workspace.list", "workspace.stat", "workspace.read", "workspace.search",
			"workspace.write", "workspace.patch", "workspace.exec",
			"workspace.git_status", "workspace.git_diff")
		capabilities = append(capabilities, "workspace.read_image")
		if config.fullAccess {
			capabilities = append(capabilities, "workspace.full_access")
		}
	}
	if runtime.GOOS == "windows" && config.allowScreenCapture {
		capabilities = append(capabilities, "screen.capture")
	}
	return capabilities
}

func advertisedRoots(config agentConfig) []string {
	roots := make([]string, 0, len(config.roots))
	for alias := range config.roots {
		roots = append(roots, alias)
	}
	sort.Strings(roots)
	return roots
}

func registrationPacket(deviceID, hostname string, config agentConfig) packet {
	return packet{V: 1, Type: "register", DeviceID: deviceID, Hostname: hostname,
		AgentVersion: version, Capabilities: advertisedCapabilities(config), Roots: advertisedRoots(config)}
}

type packet struct {
	V            int      `json:"v"`
	Type         string   `json:"type"`
	ID           string   `json:"id,omitempty"`
	DeviceID     string   `json:"device_id,omitempty"`
	Hostname     string   `json:"hostname,omitempty"`
	AgentVersion string   `json:"agent_version,omitempty"`
	Capabilities []string `json:"capabilities,omitempty"`
	Roots        []string `json:"roots,omitempty"`
	Tool         string   `json:"tool,omitempty"`
	// Args deliberately stays as JSON until the selected tool validates its own
	// schema. Workspace commands need arrays and approval objects; decoding into
	// map[string]string used to silently discard that structure.
	Args               json.RawMessage `json:"args,omitempty"`
	TimeoutMS          int             `json:"timeout_ms,omitempty"`
	ExitCode           int             `json:"exit_code"`
	Stdout             string          `json:"stdout,omitempty"`
	Stderr             string          `json:"stderr,omitempty"`
	DurationMS         int64           `json:"duration_ms,omitempty"`
	Error              string          `json:"error,omitempty"`
	Truncated          bool            `json:"truncated,omitempty"`
	Mime               string          `json:"mime,omitempty"`
	Data               string          `json:"data,omitempty"`
	WorkspaceSessionID string          `json:"workspace_session_id,omitempty"`
	Approval           json.RawMessage `json:"approval,omitempty"`
	// ExecutionState distinguishes an operation that definitely did not begin
	// from one whose outcome cannot be known after a timeout/disconnect. The
	// gateway must never replay an unknown write or process invocation.
	ExecutionState string `json:"execution_state,omitempty"`
}

func decodeStringArgs(raw json.RawMessage) (map[string]string, error) {
	var args map[string]string
	if len(raw) == 0 || json.Unmarshal(raw, &args) != nil || args == nil {
		return nil, errors.New("invalid arguments")
	}
	return args, nil
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
	return executeWithConfig(ctx, p, deviceID, agentConfig{})
}

func executeWithConfig(ctx context.Context, p packet, deviceID string, config agentConfig) packet {
	result := packet{V: 1, Type: "result", ID: p.ID, DeviceID: deviceID, ExitCode: 1, ExecutionState: "not_started"}
	if p.Type != "command" || p.ID == "" || p.TimeoutMS < 1000 || p.TimeoutMS > 30000 {
		result.Error = "COMMAND_NOT_ALLOWED"
		return result
	}
	if config.assist != nil {
		if err := config.assist.check(p); err != nil {
			result.Error = err.Error()
			return result
		}
	}
	start := time.Now()
	commandCtx, cancel := context.WithTimeout(ctx, time.Duration(p.TimeoutMS)*time.Millisecond)
	defer cancel()

	switch p.Tool {
	case "system":
		args, err := decodeStringArgs(p.Args)
		if err != nil || len(args) != 1 {
			result.Error = "COMMAND_NOT_ALLOWED"
			return result
		}
		switch args["command"] {
		case "hostname":
			result = executeHostname(commandCtx, p, deviceID)
		case "info":
			result = executeSystemInfo(commandCtx, p, deviceID)
		default:
			result.Error = "COMMAND_NOT_ALLOWED"
		}
	case "filesystem":
		args, err := decodeStringArgs(p.Args)
		if err != nil || len(args) != 3 || (args["operation"] != "list" && args["operation"] != "read") {
			result.Error = "COMMAND_NOT_ALLOWED"
			return result
		}
		root, err := resolvePath(config, args["root"], args["path"])
		if err != nil {
			result.Error = err.Error()
			return result
		}
		if args["operation"] == "list" {
			result = executeFileList(commandCtx, p, deviceID, config.roots[args["root"]], root)
		} else {
			result = executeFileRead(commandCtx, p, deviceID, root)
		}
	case "screen":
		args, err := decodeStringArgs(p.Args)
		if err != nil || len(args) != 1 || args["operation"] != "capture" || !config.allowScreenCapture {
			result.Error = "COMMAND_NOT_ALLOWED"
			return result
		}
		result = executeScreenCapture(commandCtx, p, deviceID)
	case "workspace.read_image", "workspace", "workspace.list", "workspace.stat", "workspace.read", "workspace.search", "workspace.write", "workspace.patch", "workspace.exec", "workspace.git_status", "workspace.git_diff", "workspace.system_info":
		result = executeWorkspace(commandCtx, p, deviceID, config)
	default:
		result.Error = "COMMAND_NOT_ALLOWED"
	}
	if result.ExecutionState == "" {
		// Read-only legacy commands are fully observed before their response.
		result.ExecutionState = "completed"
	}
	if result.DurationMS == 0 {
		result.DurationMS = time.Since(start).Milliseconds()
	}
	return result
}

func executeHostname(ctx context.Context, p packet, deviceID string) packet {
	result := packet{V: 1, Type: "result", ID: p.ID, DeviceID: deviceID, ExitCode: 1}
	executable := "hostname"
	if runtime.GOOS == "windows" {
		executable = filepath.Join(os.Getenv("SystemRoot"), "System32", "hostname.exe")
		if !filepath.IsAbs(executable) {
			result.Error = "COMMAND_FAILED"
			return result
		}
	}
	cmd := exec.CommandContext(ctx, executable)
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
	if err == nil {
		result.ExitCode = 0
	} else if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		result.Error = "COMMAND_TIMEOUT"
	} else {
		result.Error = "COMMAND_FAILED"
	}
	return result
}

func executeSystemInfo(ctx context.Context, p packet, deviceID string) packet {
	result := packet{V: 1, Type: "result", ID: p.ID, DeviceID: deviceID, ExitCode: 1}
	if ctx.Err() != nil {
		result.Error = "COMMAND_TIMEOUT"
		return result
	}
	hostname, err := os.Hostname()
	if err != nil {
		result.Error = "COMMAND_FAILED"
		return result
	}
	current, _ := user.Current()
	username, homeDir := "", ""
	if current != nil {
		username, homeDir = current.Username, current.HomeDir
	}
	if homeDir == "" {
		homeDir, _ = os.UserHomeDir()
	}
	info := map[string]string{
		"hostname": hostname,
		"os":       runtime.GOOS,
		"arch":     runtime.GOARCH,
		"username": username,
		"home_dir": homeDir,
	}
	data, err := json.Marshal(info)
	if err != nil || len(data) > maxOutput {
		result.Error = "COMMAND_FAILED"
		return result
	}
	result.Stdout = string(data)
	result.ExitCode = 0
	return result
}

func normalizeRelativePath(raw string) (string, error) {
	return normalizeWorkspacePath(raw)
}

func withinPath(root, target string) bool {
	rel, err := filepath.Rel(root, target)
	if err != nil {
		return false
	}
	if rel == "." {
		return true
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

func resolvePath(config agentConfig, alias, rawPath string) (string, error) {
	root, ok := config.roots[alias]
	if !ok || alias == "" {
		return "", errors.New("ROOT_NOT_CONFIGURED")
	}
	if !filepath.IsAbs(root) {
		return "", errors.New("ROOT_UNAVAILABLE")
	}
	rel, err := normalizeRelativePath(rawPath)
	if err != nil {
		return "", err
	}
	target, err := filepath.EvalSymlinks(filepath.Join(root, rel))
	if err != nil {
		return "", errors.New("PATH_NOT_FOUND")
	}
	if !withinPath(root, target) {
		return "", errors.New("PATH_OUTSIDE_ROOT")
	}
	return target, nil
}

type fileMetadata struct {
	Name    string `json:"name"`
	Path    string `json:"path"`
	Type    string `json:"type"`
	Size    int64  `json:"size"`
	ModTime string `json:"mod_time"`
}

func executeFileList(ctx context.Context, p packet, deviceID, allowedRoot, directory string) packet {
	result := packet{V: 1, Type: "result", ID: p.ID, DeviceID: deviceID, ExitCode: 1}
	if ctx.Err() != nil {
		result.Error = "COMMAND_TIMEOUT"
		return result
	}
	info, err := os.Stat(directory)
	if err != nil {
		result.Error = "PATH_NOT_FOUND"
		return result
	}
	if !info.IsDir() {
		result.Error = "NOT_A_DIRECTORY"
		return result
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		result.Error = "FILE_LIST_FAILED"
		return result
	}
	metadata := make([]fileMetadata, 0, minInt(len(entries), maxListEntries))
	for i, entry := range entries {
		if i >= maxListEntries {
			result.Truncated = true
			break
		}
		entryPath := filepath.Join(directory, entry.Name())
		resolved, resolveErr := filepath.EvalSymlinks(entryPath)
		if resolveErr != nil || !withinPath(allowedRoot, resolved) {
			// Do not follow a link outside the configured root, and do not expose
			// its target metadata. The safe result remains useful for other files.
			continue
		}
		entryInfo, infoErr := os.Lstat(entryPath)
		if infoErr != nil {
			continue
		}
		kind := "file"
		if entryInfo.IsDir() {
			kind = "directory"
		} else if entryInfo.Mode()&os.ModeSymlink != 0 {
			kind = "symlink"
		}
		rel, relErr := filepath.Rel(allowedRoot, entryPath)
		if relErr != nil || !withinPath(allowedRoot, entryPath) {
			continue
		}
		metadata = append(metadata, fileMetadata{
			Name: entry.Name(), Path: filepath.ToSlash(rel), Type: kind,
			Size: entryInfo.Size(), ModTime: entryInfo.ModTime().UTC().Format(time.RFC3339Nano),
		})
	}
	data, err := json.Marshal(metadata)
	if err != nil || len(data) > maxOutput {
		result.Error = "OUTPUT_TOO_LARGE"
		return result
	}
	result.Stdout = string(data)
	result.ExitCode = 0
	return result
}

func executeFileRead(ctx context.Context, p packet, deviceID, path string) packet {
	result := packet{V: 1, Type: "result", ID: p.ID, DeviceID: deviceID, ExitCode: 1}
	if ctx.Err() != nil {
		result.Error = "COMMAND_TIMEOUT"
		return result
	}
	info, err := os.Stat(path)
	if err != nil {
		result.Error = "PATH_NOT_FOUND"
		return result
	}
	if !info.Mode().IsRegular() {
		result.Error = "NOT_A_FILE"
		return result
	}
	if info.Size() > maxFileRead {
		result.Error = "FILE_TOO_LARGE"
		return result
	}
	data, err := os.ReadFile(path)
	if err != nil {
		result.Error = "FILE_READ_FAILED"
		return result
	}
	if len(data) > maxFileRead {
		result.Error = "FILE_TOO_LARGE"
		return result
	}
	if !utf8.Valid(data) || bytes.IndexByte(data, 0) >= 0 || looksBinary(data) {
		result.Error = "BINARY_FILE"
		return result
	}
	result.Stdout = string(data)
	result.ExitCode = 0
	return result
}

func looksBinary(data []byte) bool {
	control := 0
	for _, b := range data {
		if b < 0x09 || (b > 0x0d && b < 0x20) {
			control++
		}
	}
	return control > 0 && control*20 > len(data)
}

func executeScreenCapture(ctx context.Context, p packet, deviceID string) packet {
	result := packet{V: 1, Type: "result", ID: p.ID, DeviceID: deviceID, ExitCode: 1}
	data, err := captureScreen(ctx)
	if err != nil {
		result.Error = err.Error()
		return result
	}
	if len(data) == 0 || len(data) > maxScreenshotBytes {
		result.Error = "SCREEN_CAPTURE_TOO_LARGE"
		return result
	}
	result.Mime = "image/jpeg"
	result.Data = base64.StdEncoding.EncodeToString(data)
	result.ExitCode = 0
	return result
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func runSession(ctx context.Context, url, deviceID, token string) error {
	return runSessionWithConfig(ctx, url, deviceID, token, agentConfig{})
}

func runSessionWithConfig(ctx context.Context, url, deviceID, token string, config agentConfig) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	header := http.Header{}
	header.Set("Authorization", "Bearer "+token)
	header.Set("X-Witt-Device-Id", deviceID)
	dialer := config.dialer
	if dialer == nil {
		dialer = websocket.DefaultDialer
	}
	conn, response, err := dialer.DialContext(ctx, url, header)
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
	if err := conn.WriteJSON(registrationPacket(deviceID, hostname, config)); err != nil {
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
	if config.assist != nil && config.assist.record != nil {
		config.assist.record("Connected · 已连接，随时可以暂停或撤销")
	} else {
		log.Printf("registered device %s", deviceID)
	}
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
			result := executeWithConfig(ctx, command, deviceID, config)
			if config.assist != nil && config.assist.record != nil {
				var a workspaceArgs
				json.Unmarshal(command.Args, &a)
				status := "completed"
				if result.Error != "" {
					status = result.Error
				}
				config.assist.record(a.Operation + " · " + a.Path + " · " + status)
			}
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

// Set by the standalone connector build so browser-renamed downloads such as
// "chloe-assist (1).exe" retain the same temporary-session entry point.
var assistBuild string

func main() {
	assistArgs := os.Args[1:]
	if assistBuild == "1" || strings.HasPrefix(strings.ToLower(filepath.Base(os.Args[0])), "chloe-assist") {
		if len(assistArgs) == 0 {
			assistArgs = []string{"join"}
		}
		if assistArgs[0] != "join" {
			log.Print("Chloe Assist supports only temporary join sessions")
			return
		}
	}
	if handled, err := handleAssist(assistArgs); handled {
		if err != nil {
			log.Print(err)
		}
		return
	}
	endpoint := flag.String("gateway", "", "WSS gateway URL")
	deviceID := flag.String("device-id", "", "configured device ID")
	tokenFile := flag.String("token-file", "", "file containing this device's bearer token")
	var roots rootFlags
	flag.Var(&roots, "root", "named filesystem root (repeatable): alias=absolutePath")
	allowScreenCapture := flag.Bool("allow-screen-capture", false, "allow the built-in Windows screenshot operation")
	fullAccess := flag.Bool("full-access", false, "grant this device filesystem and program access as the current Windows user")
	flag.Parse()
	parsed, parseErr := url.Parse(*endpoint)
	if parseErr != nil || parsed.Scheme != "wss" || parsed.Host == "" || parsed.User != nil ||
		parsed.RawQuery != "" || parsed.Fragment != "" || !deviceIDPattern.MatchString(*deviceID) || *tokenFile == "" {
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
	config := configFromRoots(roots, *allowScreenCapture)
	config.fullAccess = *fullAccess
	delay := time.Second
	for ctx.Err() == nil {
		err := runSessionWithConfig(ctx, *endpoint, *deviceID, token, config)
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
