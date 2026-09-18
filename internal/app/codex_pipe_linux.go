//go:build linux

package app

import (
	"io"
	"os"
	"syscall"
)

const codexOutputPipeSize = 1 << 20
const fSetPipeSize = 1031

func enlargeCodexOutputPipe(reader io.ReadCloser) error {
	file, ok := reader.(*os.File)
	if !ok {
		return nil
	}
	// Codex app-server 使用非阻塞 stdout；扩大管道可以容纳单个较大的历史 turn。
	_, _, errno := syscall.Syscall(syscall.SYS_FCNTL, file.Fd(), fSetPipeSize, codexOutputPipeSize)
	if errno != 0 {
		return errno
	}
	return nil
}
