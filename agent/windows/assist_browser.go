package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// The local page and API share a randomly allocated loopback origin. There is
// no CORS, persistent credential, custom URL scheme, service or fixed-port API.
//
//go:embed assist_page.html
var assistPage []byte

var launchAssistBrowser = openAssistBrowser
var chooseAssistFolder = pickAssistFolder

type browserApproval struct {
	ID        string `json:"id"`
	File      string `json:"file"`
	Diff      string `json:"diff"`
	ExpiresAt int64  `json:"expires_at"`
	ctx       context.Context
	result    chan bool
}
type assistBrowser struct {
	mu                          sync.Mutex
	operations                  sync.Mutex
	options                     assistOptions
	client                      *assistClient
	grant                       assistGrant
	policy                      *assistPolicy
	root, state, origin, secret string
	logs                        []string
	approval                    *browserApproval
	notifyApproval              func(context.Context, string, string, func(bool)) error
	folderPending               bool
	folderError                 string
	folderCancel                context.CancelFunc
	folderSerial                int
	cancel                      context.CancelFunc
	serial                      int
	lastSeen                    time.Time
	lastAction                  time.Time
	updater                     *assistUpdater
	pairDraft                   bool
	done                        chan struct{}
	once                        sync.Once
}

func assistRandom() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

func showAssistBrowser(options assistOptions) error {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return err
	}
	b := &assistBrowser{options: options, root: options.Root, origin: "http://" + listener.Addr().String(), secret: assistRandom(), state: "unpaired", lastSeen: time.Now(), lastAction: time.Now(), updater: newAssistUpdater(), done: make(chan struct{}), notifyApproval: notifyAssistApproval}
	server := &http.Server{Handler: b, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 20 * time.Second, MaxHeaderBytes: 8192}
	go func() { _ = server.Serve(listener) }()
	if err = launchAssistBrowser(b.origin + "/#" + b.secret); err != nil {
		server.Close()
		return err
	}
	if assistReadyFile != "" {
		if err = os.WriteFile(assistReadyFile, []byte(assistVersion), 0600); err != nil {
			server.Close()
			return err
		}
	}
	if b.updater.isAuto() {
		go b.updater.check(context.Background())
	}
	lastUpdateCheck := time.Now()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-b.done:
			server.Close()
			return nil
		case <-ticker.C:
			if b.updater.isAuto() {
				if time.Since(lastUpdateCheck) > 6*time.Hour {
					lastUpdateCheck = time.Now()
					go b.updater.check(context.Background())
				}
				_ = b.applyUpdate(true)
			}
			b.mu.Lock()
			stale := time.Since(b.lastSeen) > 120*time.Second
			expired := b.grant.Expires > 0 && time.Now().UnixMilli() >= b.grant.Expires
			b.mu.Unlock()
			if stale || expired {
				b.stop()
				server.Close()
				return nil
			}
		}
	}
}
func (b *assistBrowser) note(s string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.logs = append(b.logs, time.Now().Format("15:04:05")+" "+s)
	if len(b.logs) > 100 {
		b.logs = b.logs[len(b.logs)-100:]
	}
}
func (b *assistBrowser) stop() {
	b.once.Do(func() {
		b.operations.Lock()
		defer b.operations.Unlock()
		b.mu.Lock()
		p, c, g, client := b.policy, b.cancel, b.grant, b.client
		b.state = "disconnected"
		b.serial++
		b.grant.Token = ""
		if b.folderCancel != nil {
			b.folderCancel()
		}
		b.mu.Unlock()
		if p != nil {
			p.Lock()
			p.paused = true
			p.Unlock()
		}
		if c != nil {
			c()
		}
		if client != nil && g.Token != "" {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			var out any
			_ = client.request(ctx, "/assist/state", g.Token, map[string]string{"state": "revoked"}, &out)
		}
		close(b.done)
	})
}
func (b *assistBrowser) start() {
	b.mu.Lock()
	b.serial++
	serial := b.serial
	g, c, p, root := b.grant, b.client, b.policy, b.root
	ctx, cancel := context.WithDeadline(context.Background(), time.UnixMilli(g.Expires))
	b.cancel = cancel
	b.state = "connecting"
	b.mu.Unlock()
	go func() {
		_ = c.connect(ctx, g, agentConfig{roots: map[string]string{"project": root}, assist: p, dialer: c.dialer})
		cancel()
		b.mu.Lock()
		current := b.serial == serial
		b.mu.Unlock()
		if current {
			b.stop()
		}
	}()
}
func (b *assistBrowser) confirm(ctx context.Context, file, diff string) bool {
	if ctx.Err() != nil {
		return false
	}
	deadline, _ := ctx.Deadline()
	a := &browserApproval{ID: assistRandom(), File: file, Diff: diff, ExpiresAt: deadline.UnixMilli(), ctx: ctx, result: make(chan bool, 1)}
	b.mu.Lock()
	if b.approval != nil {
		b.mu.Unlock()
		return false
	}
	b.approval = a
	b.mu.Unlock()
	notifyCtx, cancelNotify := context.WithCancel(ctx)
	defer cancelNotify()
	if b.notifyApproval != nil {
		go func() {
			if err := b.notifyApproval(notifyCtx, file, diff, func(allow bool) { b.decide(a.ID, allow) }); err != nil {
				b.note("无法打开 Windows 确认窗口，请到连接器网页确认本次操作")
			}
		}()
	}
	defer func() {
		b.mu.Lock()
		if b.approval == a {
			b.approval = nil
		}
		b.mu.Unlock()
	}()
	select {
	case ok := <-a.result:
		select {
		case <-b.done:
			return false
		default:
		}
		return ok && ctx.Err() == nil
	case <-ctx.Done():
		b.note("本次操作确认超时或会话已结束；未开始执行")
		return false
	case <-b.done:
		return false
	}
}

// The native window and local webpage resolve the same single-use request.
func (b *assistBrowser) decide(id string, allow bool) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	a := b.approval
	if a == nil || a.ID != id || a.ctx.Err() != nil {
		return false
	}
	select {
	case <-b.done:
		return false
	default:
	}
	select {
	case a.result <- allow:
		b.approval = nil
		return true
	default:
		return false
	}
}
func (b *assistBrowser) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	if "http://"+r.Host != b.origin {
		http.Error(w, "Invalid host", 403)
		return
	}
	if r.Method == "GET" && r.URL.Path == "/" {
		w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write([]byte(strings.ReplaceAll(string(assistPage), "{{ASSIST_VERSION}}", assistVersion)))
		return
	}
	if r.Method == "GET" && (r.URL.Path == "/app.js" || r.URL.Path == "/app.css") {
		b.serveAsset(w, r)
		return
	}
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if r.Header.Get("Origin") != b.origin || subtle.ConstantTimeCompare([]byte(token), []byte(b.secret)) != 1 || r.Method != "POST" {
		http.Error(w, "Local authorization required", 403)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8192)
	var input struct {
		Auto        bool   `json:"auto"`
		PairDraft   bool   `json:"editing_pair"`
		Server      string `json:"server"`
		Code        string `json:"code"`
		Root        string `json:"root"`
		Edits       bool   `json:"edits"`
		Environment bool   `json:"environment"`
		Commands    bool   `json:"commands"`
		ID          string `json:"id"`
		Allow       bool   `json:"allow"`
	}
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		http.Error(w, "Invalid input", 400)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	if r.URL.Path == "/api/status" {
		b.mu.Lock()
		b.lastSeen = time.Now()
		out := map[string]any{"state": b.state, "server": b.options.Server, "code": b.options.Code, "root": b.root, "operator": b.grant.Operator, "expires": b.grant.Expires, "capabilities": b.grant.Capabilities, "logs": append([]string{}, b.logs...), "approval": b.approval, "folder_pending": b.folderPending, "folder_error": b.folderError, "update": b.updater.snapshot()}
		b.mu.Unlock()
		json.NewEncoder(w).Encode(out)
		return
	}

	b.mu.Lock()
	b.lastAction = time.Now()
	b.mu.Unlock()
	if r.URL.Path == "/api/activity" {
		b.mu.Lock()
		b.pairDraft = input.PairDraft
		b.mu.Unlock()
		json.NewEncoder(w).Encode(map[string]bool{"ok": true})
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/update/") {
		var err error
		switch r.URL.Path {
		case "/api/update/check":
			if b.updater == nil {
				err = errors.New("更新不可用")
			} else {
				b.updater.retryFailed()
				go b.updater.check(context.Background())
			}
		case "/api/update/settings":
			err = b.updater.setAuto(input.Auto)
		case "/api/update/install":
			err = b.applyUpdate(false)
		default:
			err = errors.New("未知更新操作")
		}
		if err != nil {
			w.WriteHeader(409)
			json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		} else {
			json.NewEncoder(w).Encode(map[string]bool{"ok": true})
		}
		return
	}
	if r.URL.Path == "/api/end" {
		json.NewEncoder(w).Encode(map[string]bool{"ok": true})
		go b.stop()
		return
	}
	if r.URL.Path == "/api/decision" {
		ok := b.decide(input.ID, input.Allow)
		if !ok {
			w.WriteHeader(http.StatusConflict)
			json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "确认请求已过期或已处理，未重复执行"})
		} else {
			json.NewEncoder(w).Encode(map[string]bool{"ok": true})
		}
		return
	}
	b.operations.Lock()
	defer b.operations.Unlock()
	err := func() error {
		select {
		case <-b.done:
			return errors.New("会话已结束")
		default:
		}
		b.mu.Lock()
		state := b.state
		b.mu.Unlock()
		switch r.URL.Path {
		case "/api/preview":
			if state != "unpaired" && state != "preview" {
				return errors.New("会话已开始，不能重新配对")
			}
			options := b.options
			options.Server = input.Server
			options.Code = input.Code
			c, err := newAssistClient(options)
			if err != nil {
				return err
			}
			var g assistGrant
			if err = c.request(r.Context(), "/assist/preview", "", map[string]string{"code": input.Code}, &g); err != nil {
				return err
			}
			b.mu.Lock()
			b.client = c
			b.options = options
			b.grant = g
			b.state = "preview"
			b.mu.Unlock()
		case "/api/folder":
			if state != "unpaired" && state != "preview" {
				return errors.New("授权后不可切换目录")
			}
			b.mu.Lock()
			if b.folderPending {
				b.mu.Unlock()
				return errors.New("目录选择窗口已打开，请完成选择或取消")
			}
			ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
			b.folderCancel = cancel
			b.folderPending = true
			b.folderError = ""
			b.folderSerial++
			serial := b.folderSerial
			b.mu.Unlock()
			go func() {
				defer cancel()
				root, err := chooseAssistFolder(ctx)
				b.mu.Lock()
				defer b.mu.Unlock()
				if b.folderSerial != serial {
					return
				}
				b.folderPending = false
				if err != nil {
					b.folderError = err.Error()
					return
				}
				if ctx.Err() == nil && (b.state == "preview" || b.state == "unpaired") {
					b.root = root
				}
			}()
		case "/api/folder-cancel":
			b.mu.Lock()
			if b.folderCancel != nil {
				b.folderCancel()
			}
			b.folderSerial++
			b.folderPending = false
			b.folderError = ""
			b.mu.Unlock()
		case "/api/authorize":
			if state != "preview" {
				return errors.New("请先核对授权信息")
			}
			b.mu.Lock()
			if b.folderCancel != nil {
				b.folderCancel()
			}
			b.folderSerial++
			b.folderPending = false
			b.mu.Unlock()
			root, err := filepath.Abs(input.Root)
			if strings.TrimSpace(input.Root) == "" {
				return errors.New("请先选择目录")
			}
			if err == nil {
				root, err = filepath.EvalSymlinks(root)
			}
			info, e := os.Stat(root)
			if err != nil || e != nil || !info.IsDir() {
				return errors.New("请选择存在的目录")
			}
			b.mu.Lock()
			g, c := b.grant, b.client
			b.mu.Unlock()
			caps := []string{}
			for _, cap := range g.Capabilities {
				if (cap == "workspace.system_info" && !input.Environment) || (cap == "workspace.exec" && !input.Commands) {
					continue
				}
				if !input.Edits && (cap == "workspace.write" || cap == "workspace.patch") {
					continue
				}
				caps = append(caps, cap)
			}
			var grant assistGrant
			if err = c.request(r.Context(), "/assist/authorize", "", map[string]any{"pair_ticket": g.Ticket, "workspace_root": root, "allowed_capabilities": caps}, &grant); err != nil {
				return err
			}
			p := &assistPolicy{sessionID: grant.SessionID, expires: time.UnixMilli(grant.Expires), capabilities: grant.Capabilities, approve: b.confirm, record: func(s string) {
				b.note(s)
				if strings.HasPrefix(s, "Connected") {
					b.mu.Lock()
					if b.state == "connecting" {
						b.state = "connected"
					}
					b.mu.Unlock()
				}
			}}
			b.mu.Lock()
			b.grant = grant
			b.policy = p
			b.root = root
			b.mu.Unlock()
			b.note("已授权目录：" + root)
			b.start()
		case "/api/pause":
			if state != "connected" && state != "connecting" && state != "paused" {
				return errors.New("当前连接不可暂停或恢复")
			}
			b.mu.Lock()
			p, c, g, cancel := b.policy, b.client, b.grant, b.cancel
			b.serial++
			b.state = "paused"
			b.mu.Unlock()
			p.Lock()
			p.paused = true
			p.Unlock()
			next := "paused"
			if state == "paused" {
				next = "active"
			}
			var out any
			err := c.request(r.Context(), "/assist/state", g.Token, map[string]string{"state": next}, &out)
			if cancel != nil {
				cancel()
			}
			if err != nil {
				go b.stop()
				return err
			}
			if next == "active" {
				p.Lock()
				p.paused = false
				p.Unlock()
				b.start()
			}
			b.note("授权状态：" + next)
		default:
			return errors.New("Unknown operation")
		}
		return nil
	}()
	if err != nil {
		w.WriteHeader(403)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

//go:embed assist_page.js
var assistPageJS []byte

//go:embed assist_page.css
var assistPageCSS []byte

func (b *assistBrowser) serveAsset(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/app.js" {
		w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
		_, _ = io.Copy(w, strings.NewReader(string(assistPageJS)))
	} else {
		w.Header().Set("Content-Type", "text/css; charset=utf-8")
		w.Write(assistPageCSS)
	}
}
