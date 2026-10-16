//go:build !windows

package main

import "context"

func notifyAssistApproval(context.Context, string, string, func(bool)) error { return nil }
