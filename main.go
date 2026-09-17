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
//go:embed lib/web/* assets/glad-app-icon.png node_modules/@xterm/xterm/lib/xterm.js node_modules/@xterm/xterm/css/xterm.css node_modules/@xterm/addon-fit/lib/addon-fit.js
//go:embed node_modules/mermaid/dist/mermaid.min.js node_modules/mermaid/LICENSE node_modules/katex/dist/katex.min.js node_modules/katex/dist/katex.min.css node_modules/katex/dist/fonts node_modules/katex/LICENSE
//go:embed node_modules/markdown-it/dist/browser/markdown-it.umd.min.js node_modules/markdown-it/LICENSE node_modules/markdown-it-task-lists/dist/markdown-it-task-lists.min.js node_modules/markdown-it-task-lists/LICENSE node_modules/markdown-it-texmath/texmath.js node_modules/markdown-it-texmath/license.txt
var assets embed.FS

var version = "dev"

func main() {
	if err := app.Run(os.Args[1:], version, assets); err != nil {
		fmt.Fprintf(os.Stderr, "glad: %v\n", err)
		os.Exit(1)
	}
}
