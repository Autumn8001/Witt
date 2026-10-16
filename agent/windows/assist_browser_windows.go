//go:build windows

package main

import (
	"context"
	"errors"
	"runtime"
	"sync"
	"syscall"
	"unsafe"
)

func openAssistBrowser(address string) error {
	result, _, _ := assistShell.NewProc("ShellExecuteW").Call(0, uintptr(unsafe.Pointer(assistStr("open"))), uintptr(unsafe.Pointer(assistStr(address))), 0, 0, 1)
	if result <= 32 {
		return errors.New("无法打开默认浏览器，请检查 Windows 默认浏览器设置")
	}
	return nil
}

var assistPickerWindows sync.Map
var assistPickerCallback = syscall.NewCallback(func(hwnd uintptr, message uint32, unused, key uintptr) uintptr {
	if message == 1 {
		if ready, ok := assistPickerWindows.Load(key); ok {
			ready.(chan uintptr) <- hwnd
		}
		assistCall("ShowWindow", hwnd, 5)
		// Windows can refuse foreground activation for a browser-launched
		// background thread. Keep only the explicit folder dialog topmost
		// until it is dismissed; never make the browser or connector topmost.
		assistCall("SetWindowPos", hwnd, ^uintptr(0), 0, 0, 0, 0, 0x43)
		assistCall("BringWindowToTop", hwnd)
		assistCall("SetForegroundWindow", hwnd)
	}
	return 0
})

func pickAssistFolder(ctx context.Context) (string, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	assistOLE.NewProc("CoInitializeEx").Call(0, 2)
	defer assistOLE.NewProc("CoUninitialize").Call()
	buffer := make([]uint16, 32768)
	key, _, _ := assistKernel.NewProc("GetCurrentThreadId").Call()
	ready := make(chan uintptr, 1)
	assistPickerWindows.Store(key, ready)
	defer assistPickerWindows.Delete(key)
	finished := make(chan struct{})
	defer close(finished)
	go func() {
		select {
		case window := <-ready:
			select {
			case <-ctx.Done():
				assistCall("PostMessageW", window, 0x10, 0, 0)
			case <-finished:
			}
		case <-finished:
		}
	}()
	// A modal shell picker must not disable the customer's browser window:
	// cancellation and manual entry on the webpage must remain usable.
	owner := assistCall("CreateWindowExW", 0x80, uintptr(unsafe.Pointer(assistStr("STATIC"))), uintptr(unsafe.Pointer(assistStr("Chloe Assist"))), 0x80000000, 0, 0, 0, 0, 0, 0, 0, 0)
	if owner == 0 {
		return "", errors.New("无法打开目录选择窗口，请手动粘贴目录路径")
	}
	defer assistCall("DestroyWindow", owner)
	b := assistBrowse{Owner: owner, Callback: assistPickerCallback, Param: key, Display: &buffer[0], Title: assistStr("选择本次允许访问的工作区目录"), Flags: 0x41}
	id, _, _ := assistShell.NewProc("SHBrowseForFolderW").Call(uintptr(unsafe.Pointer(&b)))
	if id == 0 {
		if ctx.Err() != nil {
			return "", errors.New("目录选择已取消或超时，请重试或粘贴目录路径")
		}
		return "", errors.New("未选择目录")
	}
	defer assistOLE.NewProc("CoTaskMemFree").Call(id)
	if v, _, _ := assistShell.NewProc("SHGetPathFromIDListW").Call(id, uintptr(unsafe.Pointer(&buffer[0]))); v != 0 {
		return syscall.UTF16ToString(buffer), nil
	}
	return "", errors.New("无法读取所选目录")
}
