package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/gorilla/websocket"
)

type assistGrant struct {
	SessionID    string   `json:"assist_session_id"`
	DeviceID     string   `json:"device_id"`
	Token        string   `json:"device_token"`
	Ticket       string   `json:"pair_ticket"`
	Operator     string   `json:"operator_label"`
	Expires      int64    `json:"expires_at"`
	Capabilities []string `json:"allowed_capabilities"`
}

type assistOptions struct {
	Server, Code, Root, CAFile string
	Native                     bool
}
type assistPolicy struct {
	sync.RWMutex
	sessionID    string
	expires      time.Time
	capabilities []string
	paused       bool
	approve      func(context.Context, string, string) bool
	record       func(string)
}

func (a *assistPolicy) check(p packet) error {
	a.RLock()
	defer a.RUnlock()
	if a.paused || !time.Now().Before(a.expires) {
		return errors.New("ASSIST_NOT_ACTIVE")
	}
	var args workspaceArgs
	if p.Tool != "workspace" || p.WorkspaceSessionID != a.sessionID || json.Unmarshal(p.Args, &args) != nil || args.Root != "project" ||
		!assistHasCapability(a.capabilities, "workspace."+strings.TrimPrefix(args.Operation, "workspace.")) {
		return errors.New("ASSIST_SCOPE_DENIED")
	}
	return nil
}

func handleAssist(args []string) (bool, error) {
	if len(args) == 0 || args[0] != "join" {
		return false, nil
	}
	options := assistOptions{Server: "https://cpa.stellarbit.site/vault-api"}
	args = args[1:]
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		options.Code = args[0]
		args = args[1:]
	}
	f := flag.NewFlagSet("chloe-assist join", flag.ContinueOnError)
	f.StringVar(&options.Server, "server", options.Server, "HTTPS Chloe API base URL")
	f.StringVar(&options.Root, "root", "", "prefill workspace directory; approval is still required")
	f.StringVar(&options.CAFile, "ca-file", "", "additional trusted CA for an isolated development gateway")
	f.BoolVar(&options.Native, "native", false, "use the legacy native consent window")
	if err := f.Parse(args); err != nil {
		return true, err
	}
	if options.Native {
		return true, showAssist(options)
	}
	return true, showAssistBrowser(options)
}

type assistClient struct {
	base   string
	http   *http.Client
	dialer *websocket.Dialer
}

func newAssistClient(options assistOptions) (*assistClient, error) {
	u, err := url.Parse(strings.TrimRight(options.Server, "/"))
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("Assist requires an HTTPS server address")
	}
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12}
	if options.CAFile != "" {
		pool, err := x509.SystemCertPool()
		if err != nil {
			pool = x509.NewCertPool()
		}
		pem, err := os.ReadFile(options.CAFile)
		if err != nil || !pool.AppendCertsFromPEM(pem) {
			return nil, errors.New("cannot load trusted development CA")
		}
		tlsConfig.RootCAs = pool
	}
	return &assistClient{base: u.String(), http: &http.Client{Timeout: 12 * time.Second, Transport: &http.Transport{TLSClientConfig: tlsConfig},
		CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirect refused") }},
		dialer: &websocket.Dialer{TLSClientConfig: tlsConfig, HandshakeTimeout: 12 * time.Second}}, nil
}

func (c *assistClient) request(ctx context.Context, route, token string, input, output any) error {
	body, err := json.Marshal(input)
	if err != nil {
		return err
	}
	method := "POST"
	if input == nil {
		method = "GET"
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+route, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := c.http.Do(req)
	if err != nil {
		return errors.New("无法连接授权服务器，请检查地址和网络")
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		var e struct {
			Error string `json:"error"`
		}
		json.NewDecoder(io.LimitReader(res.Body, 8192)).Decode(&e)
		return fmt.Errorf("授权请求失败：%s (%d)", e.Error, res.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(res.Body, 1024*1024)).Decode(output)
}

func (c *assistClient) connect(ctx context.Context, grant assistGrant, config agentConfig) error {
	u, _ := url.Parse(c.base + "/device/ws")
	u.Scheme = "wss"
	return runSessionWithConfig(ctx, u.String(), grant.DeviceID, grant.Token, config)
}

// Produce a complete, bounded replacement diff, not an abbreviated claim.
// First release deliberately limits approval previews to small UTF-8 edits.
func assistChange(path, before, after string) (string, error) {
	if len(before)+len(after) > 32*1024 || strings.Count(before, "\n")+strings.Count(after, "\n") > 2000 {
		return "", errors.New("ASSIST_EDIT_TOO_LARGE")
	}
	var b strings.Builder
	fmt.Fprintf(&b, "--- %s (before)\r\n+++ %s (after)\r\n", path, path)
	for _, line := range strings.Split(strings.ReplaceAll(before, "\r\n", "\n"), "\n") {
		b.WriteString("- " + line + "\r\n")
	}
	for _, line := range strings.Split(strings.ReplaceAll(after, "\r\n", "\n"), "\n") {
		b.WriteString("+ " + line + "\r\n")
	}
	return b.String(), nil
}

func executeAssistEdit(ctx context.Context, p packet, deviceID string, config agentConfig, args workspaceArgs, target string) packet {
	if info, e := os.Stat(target); e == nil && (!info.Mode().IsRegular() || info.Size() > 32*1024) {
		return workspaceError(p, deviceID, "ASSIST_EDIT_TOO_LARGE", "not_started")
	}
	beforeBytes, err := os.ReadFile(target)
	if err != nil && !(os.IsNotExist(err) && args.Operation == "write" && args.ExpectedSHA256 == "") {
		return workspaceError(p, deviceID, "FILE_READ_FAILED", "not_started")
	}
	before := string(beforeBytes)
	after := args.Content
	if (err == nil && !strings.EqualFold(hashBytes(beforeBytes), args.ExpectedSHA256)) || (err != nil && args.ExpectedSHA256 != "") {
		return workspaceError(p, deviceID, "HASH_MISMATCH", "not_started")
	}
	if args.Operation == "patch" {
		if args.Before == "" || strings.Count(before, args.Before) != 1 {
			return workspaceError(p, deviceID, "PATCH_MISMATCH", "not_started")
		}
		after = strings.Replace(before, args.Before, args.After, 1)
	}
	if !utf8.Valid(beforeBytes) || !utf8.ValidString(after) {
		return workspaceError(p, deviceID, "NOT_UTF8", "not_started")
	}
	diff, err := assistChange(args.Path, before, after)
	if err != nil {
		return workspaceError(p, deviceID, err.Error(), "not_started")
	}
	if config.assist.approve == nil || !approveAssistChange(ctx, config.assist, args.Path, diff) {
		return workspaceError(p, deviceID, "CLIENT_DECLINED", "not_started")
	}
	if ctx.Err() != nil || config.assist.check(p) != nil {
		return workspaceError(p, deviceID, "ASSIST_NOT_ACTIVE", "not_started")
	}
	// Re-resolve after the dialog: the directory may have become a junction.
	rechecked, _, err := resolveWorkspacePath(config, args.Root, args.Path, args.Operation == "write")
	if err != nil || !strings.EqualFold(filepath.Clean(rechecked), filepath.Clean(target)) {
		return workspaceError(p, deviceID, "PATH_OUTSIDE_ROOT", "not_started")
	}
	var result packet
	if args.Operation == "write" {
		result = executeWorkspaceWrite(ctx, p, deviceID, target, args)
	} else {
		result = executeWorkspacePatch(ctx, p, deviceID, target, args)
	}
	if result.Error == "" && result.ExitCode == 0 {
		result.Stdout = stringMustJSON(map[string]any{"sha256": hashBytes([]byte(after)), "change": map[string]string{"before_sha256": hashBytes(beforeBytes), "after_sha256": hashBytes([]byte(after)), "diff": diff}})
	}
	return result
}
func stringMustJSON(value any) string { b, _ := json.Marshal(value); return string(b) }

func approveAssistChange(ctx context.Context, a *assistPolicy, file, diff string) bool {
	approvalCtx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	return a.approve(approvalCtx, file, diff)
}

func assistHasCapability(values []string, wanted string) bool {
	for _, v := range values {
		if v == wanted {
			return true
		}
	}
	return false
}
