//go:build !linux

package app

import "io"

func enlargeCodexOutputPipe(io.ReadCloser) error { return nil }
