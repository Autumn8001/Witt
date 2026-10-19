//go:build !windows

package main

import (
	"errors"
	"os/exec"
)

func configureAssistChild(cmd *exec.Cmd)  {}
func waitAssistProcess(int, string) error { return errors.New("Windows updates only") }
