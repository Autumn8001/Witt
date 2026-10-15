//go:build !windows

package main

import "errors"

func showAssist(options assistOptions) error {
	return errors.New("Chloe Assist requires Windows 10/11")
}
