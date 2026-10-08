package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestUsageConfigSchemaVersionMatchesEngineAndDependency(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "package.json"))
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		DevDependencies map[string]string `json:"devDependencies"`
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	schemaVersion := stringValue(usageConfigSchema["ccusageVersion"])
	dependencyVersion := manifest.DevDependencies["ccusage"]
	if schemaVersion == "" || schemaVersion != usageVersion || schemaVersion != dependencyVersion {
		t.Fatalf("升级 ccusage 时请同步 ccusage_config_schema.json（schema=%q，usage.go=%q，package.json=%q）", schemaVersion, usageVersion, dependencyVersion)
	}
}
