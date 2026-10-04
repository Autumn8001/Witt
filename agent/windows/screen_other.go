//go:build !windows

package main

import (
	"context"
	"errors"
)

func captureScreen(ctx context.Context) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return nil, errors.New("COMMAND_TIMEOUT")
		}
		return nil, errors.New("SCREEN_CAPTURE_UNSUPPORTED")
	}
	return nil, errors.New("SCREEN_CAPTURE_UNSUPPORTED")
}
