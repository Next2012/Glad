//go:build !windows

package app

import (
	"os/exec"
	"syscall"
)

func configureProcess(command *exec.Cmd) { command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} }
func killProcessTree(command *exec.Cmd) {
	if command == nil || command.Process == nil {
		return
	}
	if pgid, err := syscall.Getpgid(command.Process.Pid); err == nil {
		_ = syscall.Kill(-pgid, syscall.SIGKILL)
		return
	}
	_ = command.Process.Kill()
}
