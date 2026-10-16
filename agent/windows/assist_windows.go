//go:build windows

package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"
)

var assistUser = syscall.NewLazyDLL("user32.dll")
var assistKernel = syscall.NewLazyDLL("kernel32.dll")
var assistGDI = syscall.NewLazyDLL("gdi32.dll")
var assistOLE = syscall.NewLazyDLL("ole32.dll")
var assistShell = syscall.NewLazyDLL("shell32.dll")
var assistProc = syscall.NewCallback(assistWindowProc)
var assistWindows = map[uintptr]func(uint32, uintptr, uintptr) (uintptr, bool){}
var assistHost *assistUI

type assistClass struct {
	Size, Style                        uint32
	Proc                               uintptr
	ClassExtra, WindowExtra            int32
	Instance, Icon, Cursor, Background uintptr
	Menu, Name                         *uint16
	IconSmall                          uintptr
}
type assistMessage struct {
	Window         uintptr
	Message        uint32
	WParam, LParam uintptr
	Time           uint32
	X, Y           int32
	Private        uint32
}
type assistBrowse struct {
	Owner, Root     uintptr
	Display, Title  *uint16
	Flags           uint32
	Callback, Param uintptr
	Image           int32
}
type assistUI struct {
	hwnd                                                                       uintptr
	code, server, root, details, status, log, edit, preview, allow, pause, end uintptr
	font                                                                       uintptr
	queue                                                                      chan func()
	closed                                                                     atomic.Bool
	connectionSerial                                                           int
	options                                                                    assistOptions
	client                                                                     *assistClient
	grant                                                                      assistGrant
	policy                                                                     *assistPolicy
	cancel                                                                     context.CancelFunc
	logLines                                                                   []string
	busy                                                                       bool
}

func assistStr(s string) *uint16 { p, _ := syscall.UTF16PtrFromString(s); return p }
func assistCall(name string, args ...uintptr) uintptr {
	v, _, _ := assistUser.NewProc(name).Call(args...)
	return v
}
func assistText(h uintptr, s string) {
	assistCall("SetWindowTextW", h, uintptr(unsafe.Pointer(assistStr(s))))
}
func assistGet(h uintptr) string {
	n := assistCall("GetWindowTextLengthW", h)
	b := make([]uint16, n+1)
	assistCall("GetWindowTextW", h, uintptr(unsafe.Pointer(&b[0])), uintptr(len(b)))
	return syscall.UTF16ToString(b)
}
func assistEnable(h uintptr, b bool) {
	v := uintptr(0)
	if b {
		v = 1
	}
	assistCall("EnableWindow", h, v)
}

func assistWindowProc(h uintptr, m uint32, w, l uintptr) uintptr {
	if callback := assistWindows[h]; callback != nil {
		if r, handled := callback(m, w, l); handled {
			return r
		}
	}
	return assistCall("DefWindowProcW", h, uintptr(m), w, l)
}
func (u *assistUI) post(f func()) {
	if u.closed.Load() {
		return
	}
	select {
	case u.queue <- f:
		assistCall("PostMessageW", u.hwnd, 0x8001, 0, 0)
	default:
	}
}
func (u *assistUI) control(class, text string, style uintptr, x, y, w, h, id int) uintptr {
	c := assistCall("CreateWindowExW", 0, uintptr(unsafe.Pointer(assistStr(class))), uintptr(unsafe.Pointer(assistStr(text))), style|0x50000000,
		uintptr(x), uintptr(y), uintptr(w), uintptr(h), u.hwnd, uintptr(id), 0, 0)
	assistCall("SendMessageW", c, 0x30, u.font, 1)
	return c
}
func (u *assistUI) note(text string) {
	u.logLines = append(u.logLines, time.Now().Format("15:04:05")+"  "+text)
	if len(u.logLines) > 100 {
		u.logLines = u.logLines[len(u.logLines)-100:]
	}
	assistText(u.log, strings.Join(u.logLines, "\r\n"))
	assistCall("SendMessageW", u.log, 0x115, 7, 0)
}

func showAssist(options assistOptions) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	assistOLE.NewProc("CoInitializeEx").Call(0, 2)
	defer assistOLE.NewProc("CoUninitialize").Call()
	instance, _, _ := assistKernel.NewProc("GetModuleHandleW").Call(0)
	cursor := assistCall("LoadCursorW", 0, 32512)
	class := assistClass{Proc: assistProc, Instance: instance, Cursor: cursor, Background: 16, Name: assistStr("ChloeAssistWindow")}
	class.Size = uint32(unsafe.Sizeof(class))
	if assistCall("RegisterClassExW", uintptr(unsafe.Pointer(&class))) == 0 {
		return fmt.Errorf("cannot register Assist window")
	}
	u := &assistUI{options: options, queue: make(chan func(), 128)}
	assistHost = u
	u.font, _, _ = assistGDI.NewProc("CreateFontW").Call(17, 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 5, 0, uintptr(unsafe.Pointer(assistStr("Segoe UI"))))
	u.hwnd = assistCall("CreateWindowExW", 0, uintptr(unsafe.Pointer(class.Name)), uintptr(unsafe.Pointer(assistStr("Chloe Assist · 临时远程协助"))), 0x00ca0000,
		180, 60, 740, 732, 0, 0, instance, 0)
	if u.hwnd == 0 {
		return fmt.Errorf("cannot create Assist window")
	}
	assistWindows[u.hwnd] = u.message
	u.control("STATIC", "Chloe Assist", 0, 24, 20, 680, 30, 0)
	u.control("STATIC", "只授权本次协助。关闭窗口即可结束访问，不安装服务、不自动启动。", 0, 24, 55, 680, 26, 0)
	u.control("STATIC", "服务器（请核对服务方地址）", 0, 24, 90, 680, 22, 0)
	u.server = u.control("EDIT", options.Server, 0x00810080, 24, 116, 680, 28, 11)
	u.control("STATIC", "临时会话码", 0, 24, 157, 140, 24, 0)
	u.code = u.control("EDIT", options.Code, 0x00810080, 165, 153, 320, 28, 12)
	u.preview = u.control("BUTTON", "查看授权信息", 0x10000, 500, 152, 204, 30, 101)
	u.details = u.control("STATIC", "尚未授权。先查看服务方与到期时间。", 0, 24, 196, 680, 48, 0)
	u.control("STATIC", "允许访问的目录（该目录之外不可访问）", 0, 24, 250, 680, 22, 0)
	u.root = u.control("EDIT", options.Root, 0x00810080, 24, 278, 535, 28, 13)
	u.control("BUTTON", "选择目录…", 0x10000, 570, 277, 134, 30, 104)
	u.edit = u.control("BUTTON", "允许代码修改（每次修改仍需在本窗口确认差异）", 0x10003, 24, 319, 680, 28, 14)
	u.control("STATIC", "本轮不开放 Shell、环境安装、系统配置或屏幕控制。", 0, 24, 355, 680, 24, 0)
	u.allow = u.control("BUTTON", "允许并连接", 0x10001, 24, 392, 210, 36, 102)
	assistEnable(u.allow, false)
	u.pause = u.control("BUTTON", "暂停", 0x10000, 252, 392, 210, 36, 103)
	assistEnable(u.pause, false)
	u.end = u.control("BUTTON", "断开并退出", 0x10000, 480, 392, 224, 36, 105)
	u.status = u.control("STATIC", "Disconnected · 未连接", 0, 24, 446, 680, 24, 0)
	u.log = u.control("EDIT", "操作记录将显示在这里；不显示服务方 Prompt 或模型推理。", 0x00a10844, 24, 478, 680, 190, 15)
	assistCall("ShowWindow", u.hwnd, 5)
	assistCall("UpdateWindow", u.hwnd)
	assistCall("SetTimer", u.hwnd, 1, 1000, 0)
	var msg assistMessage
	for {
		r := assistCall("GetMessageW", uintptr(unsafe.Pointer(&msg)), 0, 0, 0)
		if r == 0 || r == ^uintptr(0) {
			break
		}
		if assistCall("IsDialogMessageW", u.hwnd, uintptr(unsafe.Pointer(&msg))) == 0 {
			assistCall("TranslateMessage", uintptr(unsafe.Pointer(&msg)))
			assistCall("DispatchMessageW", uintptr(unsafe.Pointer(&msg)))
		}
	}
	assistGDI.NewProc("DeleteObject").Call(u.font)
	return nil
}

func (u *assistUI) message(m uint32, w, l uintptr) (uintptr, bool) {
	switch m {
	case 0x8001:
		for {
			select {
			case f := <-u.queue:
				f()
			default:
				return 0, true
			}
		}
	case 0x10:
		u.shutdown()
		return 0, true
	case 2:
		delete(assistWindows, u.hwnd)
		assistCall("PostQuitMessage", 0)
		return 0, true
	case 0x113:
		if u.grant.Expires > 0 && time.Now().UnixMilli() >= u.grant.Expires {
			u.note("授权已到期，正在退出")
			u.shutdown()
		}
		return 0, true
	case 0x111:
		if w>>16 != 0 {
			return 0, false
		}
		switch int(w & 0xffff) {
		case 101:
			u.loadPreview()
		case 102:
			u.authorize()
		case 103:
			u.togglePause()
		case 104:
			u.browse()
		case 105:
			u.shutdown()
		}
		return 0, true
	}
	return 0, false
}
func (u *assistUI) loadPreview() {
	if u.busy || u.policy != nil {
		return
	}
	u.options.Server = assistGet(u.server)
	u.options.Code = assistGet(u.code)
	c, err := newAssistClient(u.options)
	if err != nil {
		u.note(err.Error())
		return
	}
	u.client = c
	u.busy = true
	assistEnable(u.preview, false)
	go func() {
		var g assistGrant
		err := c.request(context.Background(), "/assist/preview", "", map[string]string{"code": u.options.Code}, &g)
		u.post(func() {
			u.busy = false
			assistEnable(u.preview, true)
			if err != nil {
				u.note(err.Error())
				assistEnable(u.allow, false)
				return
			}
			u.grant = g
			assistText(u.details, fmt.Sprintf("服务方：%s\r\n授权有效期至：%s · 文件只读%s", g.Operator, time.UnixMilli(g.Expires).Local().Format("2006-01-02 15:04:05"), func() string {
				if assistHasCapability(g.Capabilities, "workspace.write") {
					return " / 可逐次批准修改"
				}
				return ""
			}()))
			assistEnable(u.edit, assistHasCapability(g.Capabilities, "workspace.write"))
			assistEnable(u.allow, true)
			u.note("已获取授权信息；点击允许之前，不会连接工作区。")
		})
	}()
}
func (u *assistUI) browse() {
	if u.policy != nil {
		return
	}
	buffer := make([]uint16, 32768)
	b := assistBrowse{Owner: u.hwnd, Display: &buffer[0], Title: assistStr("选择本次允许访问的工作区目录"), Flags: 0x41}
	id, _, _ := assistShell.NewProc("SHBrowseForFolderW").Call(uintptr(unsafe.Pointer(&b)))
	if id == 0 {
		return
	}
	defer assistOLE.NewProc("CoTaskMemFree").Call(id)
	if v, _, _ := assistShell.NewProc("SHGetPathFromIDListW").Call(id, uintptr(unsafe.Pointer(&buffer[0]))); v != 0 {
		assistText(u.root, syscall.UTF16ToString(buffer))
	}
}
func (u *assistUI) authorize() {
	if u.busy || u.policy != nil || u.grant.Ticket == "" {
		return
	}
	if strings.TrimSpace(assistGet(u.root)) == "" {
		u.note("请先选择授权目录。")
		return
	}
	root, err := filepath.Abs(assistGet(u.root))
	if err == nil {
		root, err = filepath.EvalSymlinks(root)
	}
	info, statErr := os.Stat(root)
	if err != nil || statErr != nil || !info.IsDir() {
		u.note("请选择一个存在的目录。")
		return
	}
	caps := []string{}
	edits := assistCall("SendMessageW", u.edit, 0xf0, 0, 0) == 1
	for _, cap := range u.grant.Capabilities {
		// Legacy native consent has no command/environment controls. Never grant silently.
		if cap == "workspace.exec" || cap == "workspace.system_info" {
			continue
		}
		if !edits && (cap == "workspace.write" || cap == "workspace.patch") {
			continue
		}
		caps = append(caps, cap)
	}
	input := map[string]any{"pair_ticket": u.grant.Ticket, "workspace_root": root, "allowed_capabilities": caps}
	u.busy = true
	assistEnable(u.allow, false)
	assistEnable(u.preview, false)
	go func() {
		var grant assistGrant
		err := u.client.request(context.Background(), "/assist/authorize", "", input, &grant)
		u.post(func() {
			u.busy = false
			if err != nil {
				u.note(err.Error())
				assistEnable(u.preview, true)
				return
			}
			u.grant = grant
			u.policy = &assistPolicy{sessionID: grant.SessionID, expires: time.UnixMilli(grant.Expires), capabilities: grant.Capabilities, approve: u.confirm,
				record: func(s string) {
					u.post(func() {
						u.note(s)
						if strings.HasPrefix(s, "Connected") {
							assistText(u.status, s)
						}
					})
				}}
			for _, h := range []uintptr{u.root, u.code, u.server, u.edit, u.preview, u.allow} {
				assistEnable(h, false)
			}
			assistEnable(u.pause, true)
			u.note("已授权目录：" + root)
			u.startConnection(root)
		})
	}()
}
func (u *assistUI) startConnection(root string) {
	u.connectionSerial++
	serial := u.connectionSerial
	grant := u.grant
	ctx, cancel := context.WithDeadline(context.Background(), time.UnixMilli(u.grant.Expires))
	u.cancel = cancel
	config := agentConfig{roots: map[string]string{"project": root}, assist: u.policy, dialer: u.client.dialer}
	assistText(u.status, "Connecting · 正在建立加密连接")
	go func() {
		_ = u.client.connect(ctx, grant, config)
		cancel()
		u.post(func() {
			if serial != u.connectionSerial {
				return
			}
			u.policy.RLock()
			paused := u.policy.paused
			u.policy.RUnlock()
			if paused {
				assistText(u.status, "Paused · 已暂停，所有新操作被拒绝")
				return
			}
			assistText(u.status, "Disconnected · 本次连接已结束")
			assistEnable(u.pause, false)
			u.note("已断开；不会自动重连。请关闭窗口结束本次协助。")
			u.policy.Lock()
			u.policy.paused = true
			u.policy.Unlock()
		})
	}()
}
func (u *assistUI) togglePause() {
	if u.busy || u.policy == nil {
		return
	}
	u.busy = true
	assistEnable(u.pause, false)
	u.policy.Lock()
	wasPaused := u.policy.paused
	u.policy.paused = true
	u.policy.Unlock()
	state := "paused"
	if wasPaused {
		state = "active"
	}
	go func() {
		var result any
		err := u.client.request(context.Background(), "/assist/state", u.grant.Token, map[string]string{"state": state}, &result)
		u.post(func() {
			u.busy = false
			if err != nil {
				u.note(err.Error())
				if u.cancel != nil {
					u.cancel()
				}
				assistText(u.status, "Disconnected · 无法恢复授权")
				return
			}
			assistEnable(u.pause, true)
			if wasPaused {
				u.policy.Lock()
				u.policy.paused = false
				u.policy.Unlock()
				assistText(u.pause, "暂停")
				u.startConnection(assistGet(u.root))
			} else {
				if u.cancel != nil {
					u.cancel()
				}
				assistText(u.pause, "恢复连接")
				assistText(u.status, "Paused · 已暂停，所有新操作被拒绝")
			}
			u.note("授权状态：" + state)
		})
	}()
}
func (u *assistUI) shutdown() {
	if u.closed.Swap(true) {
		return
	}
	if u.policy != nil {
		u.policy.Lock()
		u.policy.paused = true
		u.policy.Unlock()
	}
	if u.cancel != nil {
		u.cancel()
	}
	if u.client != nil && u.grant.Token != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		var result any
		_ = u.client.request(ctx, "/assist/state", u.grant.Token, map[string]string{"state": "revoked"}, &result)
		cancel()
	}
	u.grant.Token = ""
	assistCall("DestroyWindow", u.hwnd)
}
func (u *assistUI) confirm(ctx context.Context, file, diff string) bool {
	done := make(chan bool, 1)
	var window uintptr
	u.post(func() {
		if ctx.Err() != nil {
			done <- false
			return
		}
		window = assistCall("CreateWindowExW", 0, uintptr(unsafe.Pointer(assistStr("ChloeAssistWindow"))), uintptr(unsafe.Pointer(assistStr("Chloe Assist · 确认文件修改"))), 0x00c80000, 200, 100, 730, 590, u.hwnd, 0, 0, 0)
		dialog := &assistUI{hwnd: window, font: u.font}
		dialog.control("STATIC", "允许本次修改？ "+file, 0, 20, 18, 680, 28, 0)
		dialog.control("STATIC", "请在 25 秒内确认完整差异；暂停、关闭或超时会取消修改。", 0, 20, 52, 680, 24, 0)
		dialog.control("EDIT", diff, 0x00b108c4, 20, 88, 675, 380, 0)
		dialog.control("BUTTON", "允许本次修改", 0x10000, 20, 484, 320, 36, 201)
		dialog.control("BUTTON", "拒绝修改", 0x10000, 370, 484, 325, 36, 202)
		resolved := false
		resolve := func(value bool) {
			if !resolved {
				resolved = true
				done <- value
				assistCall("DestroyWindow", window)
			}
		}
		assistWindows[window] = func(m uint32, w, l uintptr) (uintptr, bool) {
			if m == 0x111 {
				switch w & 0xffff {
				case 201:
					resolve(ctx.Err() == nil)
					return 0, true
				case 202:
					resolve(false)
					return 0, true
				}
			}
			if m == 0x10 {
				resolve(false)
				return 0, true
			}
			if m == 2 {
				delete(assistWindows, window)
				return 0, true
			}
			return 0, false
		}
		assistCall("ShowWindow", window, 5)
		assistCall("SetForegroundWindow", window)
		u.note("等待客户确认差异：" + file)
	})
	select {
	case result := <-done:
		return result
	case <-ctx.Done():
		u.post(func() {
			if window != 0 {
				assistCall("SendMessageW", window, 0x10, 0, 0)
			}
		})
		return false
	}
}
