package main

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

var assistVersion = "2026.10.16.5"
var assistReadyFile string

const assistUpdateBase = "https://cpa.stellarbit.site/vault/downloads"
const assistUpdateKey = "rzML3HjNLn7NK+MfZQdcwTk+9p+z0SrLK2bQBtBPw+8="
const assistMaxBinary = 32 * 1024 * 1024

type assistRelease struct {
	Version  string `json:"version"`
	SHA256   string `json:"sha256"`
	Bytes    int64  `json:"bytes"`
	Platform string `json:"platform"`
}
type assistSignedRelease struct {
	Payload   string `json:"payload"`
	Signature string `json:"signature"`
}
type assistUpdateFeed struct {
	base   string
	client *http.Client
	key    ed25519.PublicKey
}
type assistUpdater struct {
	mu                    sync.Mutex
	feed                  assistUpdateFeed
	exe, directory, stage string
	envelope              []byte
	release               assistRelease
	auto, checking        bool
	message               string
	blockedHash           string
}

func officialAssistFeed() assistUpdateFeed {
	key, _ := base64.StdEncoding.DecodeString(assistUpdateKey)
	return assistUpdateFeed{assistUpdateBase, &http.Client{Timeout: 90 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("update redirect refused") }}, key}
}
func assistVersionParts(value string) ([4]int, error) {
	var result [4]int
	parts := strings.Split(value, ".")
	if len(parts) != 4 {
		return result, errors.New("invalid release version")
	}
	for i, p := range parts {
		if len(p) == 0 || len(p) > 8 {
			return result, errors.New("invalid release version")
		}
		for _, r := range p {
			if r < '0' || r > '9' {
				return result, errors.New("invalid release version")
			}
		}
		n, e := strconv.Atoi(p)
		if e != nil {
			return result, e
		}
		result[i] = n
	}
	return result, nil
}
func assistNewer(next, current string) bool {
	a, e := assistVersionParts(next)
	b, f := assistVersionParts(current)
	if e != nil || f != nil {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return a[i] > b[i]
		}
	}
	return false
}
func verifyAssistRelease(raw []byte, key ed25519.PublicKey) (assistRelease, error) {
	var envelope assistSignedRelease
	var release assistRelease
	if len(raw) > 16384 || json.Unmarshal(raw, &envelope) != nil {
		return release, errors.New("invalid update metadata")
	}
	payload, e := base64.StdEncoding.DecodeString(envelope.Payload)
	signature, f := base64.StdEncoding.DecodeString(envelope.Signature)
	if e != nil || f != nil || len(key) != ed25519.PublicKeySize || !ed25519.Verify(key, payload, signature) {
		return release, errors.New("update signature invalid")
	}
	if json.Unmarshal(payload, &release) != nil {
		return release, errors.New("invalid release")
	}
	_, e = assistVersionParts(release.Version)
	if e != nil || release.Platform != "windows-amd64" || release.Bytes < 1 || release.Bytes > assistMaxBinary || len(release.SHA256) != 64 {
		return release, errors.New("invalid release")
	}
	if _, e = hex.DecodeString(release.SHA256); e != nil {
		return release, e
	}
	return release, nil
}
func assistRegular(path string) error {
	info, e := os.Lstat(path)
	if e != nil {
		return e
	}
	if !info.Mode().IsRegular() {
		return errors.New("update requires a regular file")
	}
	return nil
}
func verifyAssistBinary(path string, release assistRelease) error {
	if err := assistRegular(path); err != nil {
		return err
	}
	f, e := os.Open(path)
	if e != nil {
		return e
	}
	defer f.Close()
	h := sha256.New()
	n, e := io.Copy(h, io.LimitReader(f, assistMaxBinary+1))
	if e != nil || n != release.Bytes || hex.EncodeToString(h.Sum(nil)) != strings.ToLower(release.SHA256) {
		return errors.New("update file verification failed")
	}
	return nil
}
func newAssistUpdater() *assistUpdater {
	exe, e := os.Executable()
	if e != nil {
		return nil
	}
	cache, e := os.UserCacheDir()
	if e != nil {
		return nil
	}
	id := sha256.Sum256([]byte(strings.ToLower(exe)))
	u := &assistUpdater{feed: officialAssistFeed(), exe: exe, directory: filepath.Join(cache, "ChloeAssist", hex.EncodeToString(id[:8])), auto: true, message: "等待检查更新"}
	if os.MkdirAll(u.directory, 0700) != nil {
		return nil
	}
	var settings struct {
		Auto *bool `json:"auto_update"`
	}
	if raw, e := os.ReadFile(filepath.Join(u.directory, "settings.json")); e == nil && json.Unmarshal(raw, &settings) == nil && settings.Auto != nil {
		u.auto = *settings.Auto
	}
	var pending struct {
		Stage    string `json:"stage"`
		Envelope []byte `json:"envelope"`
	}
	if raw, e := os.ReadFile(filepath.Join(u.directory, "pending.json")); e == nil && json.Unmarshal(raw, &pending) == nil && assistStagePath(exe, pending.Stage) {
		if r, e := verifyAssistRelease(pending.Envelope, u.feed.key); e == nil && assistNewer(r.Version, assistVersion) && verifyAssistBinary(pending.Stage, r) == nil {
			u.stage = pending.Stage
			u.envelope = pending.Envelope
			u.release = r
			u.message = "更新已就绪"
		}
	}
	if raw, e := os.ReadFile(filepath.Join(u.directory, "result.json")); e == nil {
		var result map[string]string
		if json.Unmarshal(raw, &result) == nil && result["status"] == "failed" {
			u.blockedHash = result["sha256"]
			u.message = "上次更新未完成，已保留原版本。本版不再自动重试；点击检查更新可重试。"
		}
	}
	time.AfterFunc(5*time.Second, func() {
		helpers, _ := filepath.Glob(filepath.Join(u.directory, "updater-*.exe"))
		for _, file := range helpers {
			if assistRegular(file) == nil && os.Remove(file) == nil {
				os.Remove(file + ".json")
			}
		}
	})
	return u
}
func assistStagePath(exe, stage string) bool {
	return filepath.IsAbs(stage) && strings.EqualFold(filepath.Dir(stage), filepath.Dir(exe)) && strings.HasPrefix(filepath.Base(stage), ".chloe-assist-update-") && strings.HasSuffix(stage, ".exe")
}
func (u *assistUpdater) snapshot() any {
	if u == nil {
		return map[string]any{"version": assistVersion, "message": "此运行方式不支持自动更新", "enabled": false}
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	return map[string]any{"version": assistVersion, "message": u.message, "auto": u.auto, "checking": u.checking, "ready": u.stage != "", "latest": u.release.Version, "enabled": true}
}
func (u *assistUpdater) setAuto(value bool) error {
	if u == nil {
		return errors.New("更新不可用")
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	raw, _ := json.Marshal(map[string]bool{"auto_update": value})
	if e := os.WriteFile(filepath.Join(u.directory, "settings.json"), raw, 0600); e != nil {
		return errors.New("无法保存更新设置")
	}
	u.auto = value
	return nil
}
func (u *assistUpdater) isAuto() bool {
	if u == nil {
		return false
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.auto
}
func (u *assistUpdater) retryFailed() {
	if u == nil {
		return
	}
	u.mu.Lock()
	u.blockedHash = ""
	u.mu.Unlock()
}
func (u *assistUpdater) check(ctx context.Context) {
	if u == nil {
		return
	}
	u.mu.Lock()
	if u.checking {
		u.mu.Unlock()
		return
	}
	u.checking = true
	u.message = "正在检查并准备更新…"
	u.mu.Unlock()
	err := u.download(ctx)
	u.mu.Lock()
	defer u.mu.Unlock()
	u.checking = false
	if err != nil {
		u.message = "更新检查失败，当前版本可继续使用。请稍后重试。"
	} else if u.stage != "" {
		u.message = "更新已验证并就绪"
	} else {
		u.message = "已是最新版本"
	}
}
func (u *assistUpdater) get(ctx context.Context, name string) (*http.Response, error) {
	if !strings.HasPrefix(u.feed.base, "https://") {
		return nil, errors.New("HTTPS required")
	}
	req, e := http.NewRequestWithContext(ctx, "GET", u.feed.base+"/"+name, nil)
	if e != nil {
		return nil, e
	}
	req.Header.Set("Cache-Control", "no-cache")
	client := *u.feed.client
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return errors.New("update redirect refused") }
	r, e := client.Do(req)
	if e != nil {
		return nil, e
	}
	if r.StatusCode != 200 {
		r.Body.Close()
		return nil, errors.New("update unavailable")
	}
	return r, nil
}
func (u *assistUpdater) download(ctx context.Context) error {
	r, e := u.get(ctx, "update.json?t="+strconv.FormatInt(time.Now().Unix(), 10))
	if e != nil {
		return e
	}
	raw, e := io.ReadAll(io.LimitReader(r.Body, 16385))
	r.Body.Close()
	if e != nil {
		return e
	}
	release, e := verifyAssistRelease(raw, u.feed.key)
	if e != nil {
		return e
	}
	if !assistNewer(release.Version, assistVersion) {
		u.mu.Lock()
		old := u.stage
		u.stage = ""
		u.release = assistRelease{}
		u.mu.Unlock()
		if old != "" && assistStagePath(u.exe, old) {
			os.Remove(old)
		}
		os.Remove(filepath.Join(u.directory, "pending.json"))
		return nil
	}
	u.mu.Lock()
	ready := u.stage != "" && u.release.SHA256 == release.SHA256
	stageReady := u.stage
	blocked := u.blockedHash == release.SHA256
	u.mu.Unlock()
	if blocked {
		return errors.New("failed version quarantined")
	}
	if ready && verifyAssistBinary(stageReady, release) == nil {
		return nil
	}
	r, e = u.get(ctx, "chloe-assist.exe?v="+release.Version)
	if e != nil {
		return e
	}
	defer r.Body.Close()
	f, e := os.CreateTemp(filepath.Dir(u.exe), ".chloe-assist-update-*.exe")
	if e != nil {
		return e
	}
	stage := f.Name()
	keep := false
	defer func() {
		f.Close()
		if !keep {
			os.Remove(stage)
		}
	}()
	_, e = io.Copy(f, io.LimitReader(r.Body, assistMaxBinary+1))
	if e == nil {
		e = f.Sync()
	}
	f.Close()
	if e != nil {
		return e
	}
	if e = verifyAssistBinary(stage, release); e != nil {
		return e
	}
	pending, _ := json.Marshal(map[string]any{"stage": stage, "envelope": raw})
	if e = os.WriteFile(filepath.Join(u.directory, "pending.json"), pending, 0600); e != nil {
		return e
	}
	u.mu.Lock()
	old := u.stage
	u.stage = stage
	u.envelope = raw
	u.release = release
	u.mu.Unlock()
	keep = true
	if old != "" && old != stage && assistStagePath(u.exe, old) {
		os.Remove(old)
	}
	return nil
}
func (u *assistUpdater) install() error {
	if u == nil {
		return errors.New("更新不可用")
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.checking || u.stage == "" {
		return errors.New("请先检查并准备更新")
	}
	if u.blockedHash == u.release.SHA256 {
		return errors.New("此版本上次更新失败，请点击检查更新后重试")
	}
	if e := verifyAssistBinary(u.stage, u.release); e != nil {
		return errors.New("更新验证失败，请重新检查更新")
	}
	if assistRegular(u.exe) != nil {
		return errors.New("当前程序路径不支持更新")
	}
	oldHash, _, e := sha256File(u.exe)
	if e != nil {
		return e
	}
	helper := filepath.Join(u.directory, "updater-"+assistRandom()+".exe")
	data, e := os.ReadFile(u.stage)
	if e != nil {
		return e
	}
	if e = os.WriteFile(helper, data, 0700); e != nil {
		return e
	}
	manifest := helper + ".json"
	if e = os.WriteFile(manifest, u.envelope, 0600); e != nil {
		return e
	}
	cmd := exec.Command(helper, "--assist-updater", u.exe, u.stage, manifest, strconv.Itoa(os.Getpid()), oldHash, u.directory)
	configureAssistChild(cmd)
	if e = cmd.Start(); e != nil {
		return errors.New("无法启动更新程序")
	}
	cmd.Process.Release()
	return nil
}

// Runs from a separate copy, so neither the target nor staged executable is locked.
func runAssistUpdateHelper(args []string) error {
	return runAssistUpdateHelperVerified(args, officialAssistFeed().key)
}
func runAssistUpdateHelperVerified(args []string, key ed25519.PublicKey) error {
	if len(args) != 6 {
		return errors.New("invalid updater arguments")
	}
	target, stage, manifest, cache := args[0], args[1], args[2], args[5]
	pid, e := strconv.Atoi(args[3])
	if e != nil || pid < 1 || !filepath.IsAbs(target) || !assistStagePath(target, stage) {
		return errors.New("invalid update target")
	}
	releaseHash := ""
	record := func(status string) {
		raw, _ := json.Marshal(map[string]string{"status": status, "sha256": releaseHash})
		os.WriteFile(filepath.Join(cache, "result.json"), raw, 0600)
	}
	success := false
	defer func() {
		if !success {
			record("failed")
		}
	}()
	raw, e := os.ReadFile(manifest)
	if e != nil {
		return e
	}
	release, e := verifyAssistRelease(raw, key)
	if e != nil {
		return e
	}
	releaseHash = release.SHA256
	if e = verifyAssistBinary(stage, release); e != nil {
		return e
	}
	if e = waitAssistProcess(pid, target); e != nil {
		return e
	}
	actual, _, e := sha256File(target)
	if e != nil || actual != args[4] {
		return errors.New("target changed during update")
	}
	if e = assistRegular(target); e != nil {
		return e
	}
	backup := target + ".previous.exe"
	if _, e = os.Lstat(backup); e == nil {
		if assistRegular(backup) != nil {
			return errors.New("invalid backup path")
		}
		if e = os.Remove(backup); e != nil {
			return e
		}
	}
	if e = os.Rename(target, backup); e != nil {
		return e
	}
	rollback := func() {
		record("failed")
		os.Remove(target)
		os.Rename(backup, target)
		cmd := exec.Command(target)
		configureAssistChild(cmd)
		if cmd.Start() == nil {
			cmd.Process.Release()
		}
	}
	if e = os.Rename(stage, target); e != nil {
		rollback()
		return e
	}
	ready := filepath.Join(cache, "ready-"+assistRandom())
	cmd := exec.Command(target, "--assist-update-ready", ready)
	configureAssistChild(cmd)
	if e = cmd.Start(); e != nil {
		rollback()
		return e
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	deadline := time.After(20 * time.Second)
	for {
		select {
		case <-ticker.C:
			if value, e := os.ReadFile(ready); e == nil && string(value) == release.Version {
				os.Remove(ready)
				os.Remove(filepath.Join(cache, "pending.json"))
				os.Remove(manifest)
				success = true
				record("updated")
				return nil
			}
		case <-exited:
			rollback()
			return errors.New("new connector exited before ready")
		case <-deadline:
			cmd.Process.Kill()
			<-exited
			rollback()
			return errors.New("new connector startup timed out")
		}
	}
}
func assistUpdateEntry(args []string) (bool, error) {
	if len(args) == 0 {
		return false, nil
	}
	if args[0] == "--assist-updater" {
		return true, runAssistUpdateHelper(args[1:])
	}
	return false, nil
}
func (b *assistBrowser) applyUpdate(auto bool) error {
	b.operations.Lock()
	defer b.operations.Unlock()
	b.mu.Lock()
	if b.state != "unpaired" || b.folderPending || (auto && (b.options.Code != "" || b.pairDraft || time.Since(b.lastAction) < 60*time.Second)) {
		b.mu.Unlock()
		return errors.New("更新将在空闲时安装；请先结束当前协助")
	}
	b.mu.Unlock()
	if e := b.updater.install(); e != nil {
		return e
	}
	b.mu.Lock()
	b.state = "updating"
	b.mu.Unlock()
	go b.stop()
	return nil
}
