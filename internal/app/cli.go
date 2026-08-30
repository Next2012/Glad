package app

import (
	"context"
	"fmt"
	"io/fs"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
)

var buildVersion = "dev"

// Run executes the Glad command line interface against the supplied embedded
// frontend. It returns errors to the thin main package so tests and embedders
// do not need to intercept os.Exit.
func Run(args []string, version string, assets fs.FS) error {
	buildVersion = version
	if len(args) > 0 {
		switch args[0] {
		case "-v", "--version", "version":
			fmt.Printf("glad %s\n", version)
			return nil
		case "tools":
			return runTools(args[1:])
		case "config":
			return runConfig(args[1:])
		case "web":
			args = args[1:]
		}
	}

	directory, port, err := parseWebArgs(args)
	if err != nil {
		return err
	}
	baseDir, err := filepath.Abs(directory)
	if err != nil {
		return fmt.Errorf("resolve project directory: %w", err)
	}
	info, err := os.Stat(baseDir)
	if err != nil || !info.IsDir() {
		return fmt.Errorf("project directory does not exist: %s", baseDir)
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	server, err := NewServer(baseDir, port, assets)
	if err != nil {
		return fmt.Errorf("initialize server: %w", err)
	}
	if err := server.Run(ctx); err != nil {
		return fmt.Errorf("server failed: %w", err)
	}
	return nil
}

func parseWebArgs(args []string) (string, int, error) {
	directory, port := ".", 3000
	for index := 0; index < len(args); index++ {
		switch args[index] {
		case "-p", "--port":
			if index+1 >= len(args) {
				return "", 0, fmt.Errorf("%s requires a port", args[index])
			}
			index++
			port = atoiDefault(args[index], 0)
			if port < 1 || port > 65535 {
				return "", 0, fmt.Errorf("invalid port: %s", args[index])
			}
		default:
			if strings.HasPrefix(args[index], "--port=") {
				port = atoiDefault(strings.TrimPrefix(args[index], "--port="), 0)
				continue
			}
			if strings.HasPrefix(args[index], "-") {
				return "", 0, fmt.Errorf("unknown option: %s", args[index])
			}
			directory = args[index]
		}
	}
	return directory, port, nil
}

func runTools(args []string) error {
	action := "list"
	if len(args) > 0 {
		action = args[0]
	}
	if action != "list" && action != "detect" {
		return fmt.Errorf("unknown tools action: %s", action)
	}
	for _, tool := range detectTools(context.Background()) {
		installed := "not installed"
		if tool.Installed {
			installed = tool.Version
		}
		fmt.Printf("%-8s %-16s %s\n", tool.DisplayName, tool.Command, installed)
	}
	return nil
}

func runConfig(args []string) error {
	store, err := OpenConfigStore()
	if err != nil {
		return fmt.Errorf("open configuration: %w", err)
	}
	if len(args) == 0 || args[0] == "get" {
		key := ""
		if len(args) > 1 {
			key = args[1]
		}
		writeJSON(os.Stdout, store.Get(key))
		return nil
	}
	if args[0] == "set" && len(args) >= 3 {
		if err := store.Set(args[1], args[2]); err != nil {
			return fmt.Errorf("save configuration: %w", err)
		}
		return nil
	}
	return fmt.Errorf("usage: glad config [get [key] | set key value]")
}
