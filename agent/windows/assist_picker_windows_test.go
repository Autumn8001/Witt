//go:build windows

package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

// Explicit interactive acceptance only: drive this process's own shell dialog,
// using a dedicated test root. Ordinary go test never opens a system dialog.
func TestAssistRealFolderDialog(t *testing.T) {
	root := os.Getenv("ASSIST_PICKER_TEST_ROOT")
	if root == "" {
		t.Skip("explicit native picker acceptance only")
	}
	root, err := filepath.Abs(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, accept := range []bool{false, true} {
		ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
		driver := make(chan bool, 1)
		go func() {
			callback := syscall.NewCallback(func(hwnd, unused uintptr) uintptr {
				var pid uint32
				assistCall("GetWindowThreadProcessId", hwnd, uintptr(unsafe.Pointer(&pid)))
				if pid != uint32(os.Getpid()) {
					return 1
				}
				class := make([]uint16, 128)
				assistCall("GetClassNameW", hwnd, uintptr(unsafe.Pointer(&class[0])), 128)
				if syscall.UTF16ToString(class) != "#32770" {
					return 1
				}
				// The browser may own foreground focus. A real dialog must
				// still be visible above it, not merely exist behind it.
				if assistCall("GetWindowLongPtrW", hwnd, ^uintptr(19))&0x8 == 0 {
					return 1
				}
				if accept {
					assistCall("SendMessageW", hwnd, 0x467, 1, uintptr(unsafe.Pointer(assistStr(root))))
					assistCall("PostMessageW", hwnd, 0x111, 1, 0)
				} else {
					assistCall("PostMessageW", hwnd, 0x10, 0, 0)
				}
				select {
				case driver <- true:
				default:
				}
				return 0
			})
			for ctx.Err() == nil {
				assistCall("EnumWindows", callback, 0)
				select {
				case <-driver:
					return
				default:
				}
				time.Sleep(50 * time.Millisecond)
			}
		}()
		selected, e := pickAssistFolder(ctx)
		cancel()
		if accept && (e != nil || !strings.EqualFold(filepath.Clean(selected), root)) {
			t.Fatalf("selection: %q %v", selected, e)
		}
		if !accept && e == nil {
			t.Fatal("cancelled dialog returned a directory")
		}
	}
}
