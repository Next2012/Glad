package main

import (
	"embed"
	"fmt"
	"os"

	"glad-web/internal/app"
)

// Frontend assets are compiled into the native binary. Keeping this directive
// at the module root lets the Web UI remain in its existing lib/web location.
//
//go:embed lib/web/* assets/logo.svg node_modules/@xterm/xterm/lib/xterm.js node_modules/@xterm/xterm/css/xterm.css node_modules/@xterm/addon-fit/lib/addon-fit.js
var assets embed.FS

var version = "dev"

func main() {
	if err := app.Run(os.Args[1:], version, assets); err != nil {
		fmt.Fprintf(os.Stderr, "glad: %v\n", err)
		os.Exit(1)
	}
}
