//go:build windows

package app

import (
	"os/exec"
	"strconv"
)

func configureProcess(command *exec.Cmd) {}
func killProcessTree(command *exec.Cmd) {
	if command == nil || command.Process == nil {
		return
	}
	_ = exec.Command("taskkill", "/PID", strconv.Itoa(command.Process.Pid), "/T", "/F").Run()
	_ = command.Process.Kill()
}
