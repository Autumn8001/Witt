package main

import (
	"errors"
	"os/exec"
	"strings"
	"syscall"
	"unsafe"
)

func configureAssistChild(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true} }

func waitAssistProcess(pid int, target string) error {
	kernel := syscall.NewLazyDLL("kernel32.dll")
	h, _, err := kernel.NewProc("OpenProcess").Call(0x100000|0x1000, 0, uintptr(pid))
	if h == 0 {
		if err == syscall.Errno(87) {
			return nil
		}
		return errors.New("cannot wait for old connector")
	}
	defer kernel.NewProc("CloseHandle").Call(h)
	var path [32768]uint16
	size := uint32(len(path))
	ok, _, _ := kernel.NewProc("QueryFullProcessImageNameW").Call(h, 0, uintptr(unsafe.Pointer(&path[0])), uintptr(unsafe.Pointer(&size)))
	if ok == 0 || !strings.EqualFold(syscall.UTF16ToString(path[:size]), target) {
		return errors.New("old process identity mismatch")
	}
	result, _, _ := kernel.NewProc("WaitForSingleObject").Call(h, 30000)
	if result != 0 {
		return errors.New("old connector did not exit")
	}
	return nil
}
