package app

import (
	"net"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestAntigravitySubagentRejectsFIFOAndSocketBeforeOpen(t *testing.T) {
	directory := t.TempDir()
	root, err := os.OpenRoot(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	pipe := filepath.Join(directory, "native-pipe")
	if err := syscall.Mkfifo(pipe, 0600); err != nil {
		t.Fatal(err)
	}
	socket, err := net.Listen("unix", filepath.Join(directory, "native-socket"))
	if err != nil {
		t.Fatal(err)
	}
	defer socket.Close()
	for _, name := range []string{"native-pipe", "native-socket"} {
		done := make(chan error, 1)
		go func() {
			file, err := agySubagentOpen(root, name)
			if file != nil {
				file.Close()
			}
			done <- err
		}()
		select {
		case err := <-done:
			if err == nil {
				t.Fatalf("opened non-regular %s", name)
			}
		case <-time.After(500 * time.Millisecond):
			if name == "native-pipe" {
				fd, err := syscall.Open(pipe, syscall.O_RDWR|syscall.O_NONBLOCK, 0600)
				if err == nil {
					syscall.Close(fd)
				}
			}
			t.Fatalf("native %s blocked before regular-file validation", name)
		}
	}
}
