//go:build !windows

package main

import "errors"

func showAssist(options assistOptions) error {
	return errors.New("Chloe Assist requires Windows 10/11")
}
func openAssistBrowser(address string) error {
	return errors.New("Chloe Assist requires Windows 10/11")
}
func pickAssistFolder() (string, error) { return "", errors.New("Chloe Assist requires Windows 10/11") }
