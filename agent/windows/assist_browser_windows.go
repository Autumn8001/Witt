//go:build windows

package main

import (
	"errors"
	"runtime"
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
func pickAssistFolder() (string, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	assistOLE.NewProc("CoInitializeEx").Call(0, 2)
	defer assistOLE.NewProc("CoUninitialize").Call()
	buffer := make([]uint16, 32768)
	b := assistBrowse{Display: &buffer[0], Title: assistStr("选择本次允许访问的工作区目录"), Flags: 0x41}
	id, _, _ := assistShell.NewProc("SHBrowseForFolderW").Call(uintptr(unsafe.Pointer(&b)))
	if id == 0 {
		return "", errors.New("未选择目录")
	}
	defer assistOLE.NewProc("CoTaskMemFree").Call(id)
	if v, _, _ := assistShell.NewProc("SHGetPathFromIDListW").Call(id, uintptr(unsafe.Pointer(&buffer[0]))); v != 0 {
		return syscall.UTF16ToString(buffer), nil
	}
	return "", errors.New("无法读取所选目录")
}
