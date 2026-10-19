//go:build windows

package main

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

var approvalWindowOnce sync.Once
var approvalWindowErr error
var approvalWindows sync.Map
var approvalWindowProc = syscall.NewCallback(func(hwnd uintptr, msg uint32, w, l uintptr) uintptr {
	if callback, ok := approvalWindows.Load(hwnd); ok {
		if result, handled := callback.(func(uint32, uintptr, uintptr) (uintptr, bool))(msg, w, l); handled {
			return result
		}
	}
	return assistCall("DefWindowProcW", hwnd, uintptr(msg), w, l)
})

// A browser tab cannot surface itself reliably when the customer is using
// Chloe in another tab. This temporary native window belongs to this approval
// only, shows the full intent, and closes when that same request is resolved.
func notifyAssistApproval(ctx context.Context, file, diff string, decide func(bool)) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if ctx.Err() != nil {
		return nil
	}
	instance, _, _ := assistKernel.NewProc("GetModuleHandleW").Call(0)
	approvalWindowOnce.Do(func() {
		class := assistClass{Proc: approvalWindowProc, Instance: instance,
			Cursor: assistCall("LoadCursorW", 0, 32512), Background: 16, Name: assistStr("ChloeAssistApproval")}
		class.Size = uint32(unsafe.Sizeof(class))
		if assistCall("RegisterClassExW", uintptr(unsafe.Pointer(&class))) == 0 {
			approvalWindowErr = errors.New("cannot register approval window")
		}
	})
	if approvalWindowErr != nil {
		return approvalWindowErr
	}
	width, height := uintptr(730), uintptr(590)
	screenW, screenH := assistCall("GetSystemMetrics", 0), assistCall("GetSystemMetrics", 1)
	if screenW < 400 || screenH < 400 {
		return errors.New("interactive desktop unavailable")
	}
	if screenH < height+80 {
		height = screenH - 80
	}
	if screenW < width+40 {
		width = screenW - 40
	}
	hwnd := assistCall("CreateWindowExW", 0x40008, uintptr(unsafe.Pointer(assistStr("ChloeAssistApproval"))),
		uintptr(unsafe.Pointer(assistStr("Chloe Assist · 待确认操作"))), 0x00c80000,
		(screenW-width)/2, (screenH-height)/2, width, height, 0, 0, instance, 0)
	if hwnd == 0 {
		return errors.New("cannot create approval window")
	}
	defer approvalWindows.Delete(hwnd)
	font, _, _ := assistGDI.NewProc("CreateFontW").Call(17, 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 5, 0,
		uintptr(unsafe.Pointer(assistStr("Microsoft YaHei UI"))))
	defer assistGDI.NewProc("DeleteObject").Call(font)
	u := &assistUI{hwnd: hwnd, font: font}
	u.control("STATIC", file, 0, 20, 18, int(width)-60, 30, 0)
	countdown := u.control("STATIC", "未确认前不会执行。请核对完整操作内容。", 0, 20, 54, int(width)-60, 32, 301)
	details := u.control("EDIT", diff, 0x00a10844, 20, 94, int(width)-60, int(height)-205, 302)
	u.control("BUTTON", "允许本次操作", 0x10000, 20, int(height)-95, (int(width)-70)/2, 42, 303)
	u.control("BUTTON", "拒绝本次操作", 0x10000, (int(width)-70)/2+35, int(height)-95, (int(width)-70)/2, 42, 304)
	resolved := false
	resolve := func(allow bool) {
		if resolved {
			return
		}
		resolved = true
		decide(allow && ctx.Err() == nil)
		assistCall("DestroyWindow", hwnd)
	}
	approvalWindows.Store(hwnd, func(msg uint32, w, l uintptr) (uintptr, bool) {
		switch msg {
		case 0x111:
			switch w & 0xffff {
			case 303:
				resolve(true)
			case 304:
				resolve(false)
			}
			return 0, true
		case 0x10:
			resolve(false)
			return 0, true
		case 0x113:
			if ctx.Err() != nil {
				resolve(false)
			} else if deadline, ok := ctx.Deadline(); ok {
				assistText(countdown, fmt.Sprintf("剩余 %d 秒 · 未确认不会执行；关闭此窗口即拒绝。", int(time.Until(deadline).Seconds())+1))
			}
			return 0, true
		case 2:
			assistCall("PostQuitMessage", 0)
			return 0, true
		}
		return 0, false
	})
	if assistCall("SetTimer", hwnd, 1, 200, 0) == 0 {
		assistCall("DestroyWindow", hwnd)
		// Drain WM_QUIT before releasing this OS thread back to the runtime.
		var msg assistMessage
		assistCall("PeekMessageW", uintptr(unsafe.Pointer(&msg)), 0, 0x12, 0x12, 1)
		return errors.New("cannot initialize approval timer")
	}
	assistCall("ShowWindow", hwnd, 5)
	assistCall("SetForegroundWindow", hwnd)
	assistCall("SetFocus", details)
	var msg assistMessage
	for {
		result := assistCall("GetMessageW", uintptr(unsafe.Pointer(&msg)), 0, 0, 0)
		if result == 0 {
			break
		}
		if int32(result) == -1 {
			resolve(false)
			assistCall("PeekMessageW", uintptr(unsafe.Pointer(&msg)), 0, 0x12, 0x12, 1)
			return errors.New("approval message loop failed")
		}
		if msg.Message == 0x100 && msg.WParam == 27 {
			resolve(false)
			continue
		}
		// Tab navigation is enabled, but Enter never implicitly approves.
		if msg.Message == 0x100 && msg.WParam == 9 && assistCall("IsDialogMessageW", hwnd, uintptr(unsafe.Pointer(&msg))) != 0 {
			continue
		}
		assistCall("TranslateMessage", uintptr(unsafe.Pointer(&msg)))
		assistCall("DispatchMessageW", uintptr(unsafe.Pointer(&msg)))
	}
	return nil
}
