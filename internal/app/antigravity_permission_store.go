package app

// Private policy profiles share native authentication and conversation storage.
import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

const agyPermissionSettingsLimit = 1 << 20

var agyPolicyDiskMu sync.Mutex
var agyPolicyDefaults = map[string]any{"toolPermission": "request-review", "enableTerminalSandbox": false, "allowNonWorkspaceAccess": false, "artifactReviewPolicy": "asks-for-review"}
var agyPolicyEnums = map[string][]string{"toolPermission": {"request-review", "proceed-in-sandbox", "strict", "always-proceed"}, "artifactReviewPolicy": {"asks-for-review", "agent-decides", "always-proceed"}}

type agyRuleDocument struct {
	Allow    []string `json:"allow"`
	Ask      []string `json:"ask"`
	Deny     []string `json:"deny"`
	Revision string   `json:"revision,omitempty"`
}

func (p *AntigravityProvider) permissionHome() string {
	home, _ := os.UserHomeDir()
	for _, item := range p.session.environment {
		if strings.HasPrefix(item, "HOME=") {
			home = strings.TrimPrefix(item, "HOME=")
		}
	}
	return home
}
func (p *AntigravityProvider) permissionRoot() string {
	return filepath.Join(p.permissionHome(), ".gemini", "antigravity-cli")
}
func (p *AntigravityProvider) rulePath(scope string) (string, error) {
	switch scope {
	case "global":
		return filepath.Join(p.permissionRoot(), "settings.json"), nil
	case "shared":
		return filepath.Join(p.permissionHome(), ".glad", "antigravity-permissions", "shared.json"), nil
	case "project":
		root, err := filepath.Abs(p.session.WorkingDirectory)
		if err != nil {
			return "", err
		}
		if resolved, e := filepath.EvalSymlinks(root); e == nil {
			root = resolved
		}
		hash := sha256.Sum256([]byte(root))
		return filepath.Join(p.permissionHome(), ".glad", "antigravity-permissions", "projects", hex.EncodeToString(hash[:])+".json"), nil
	case "session":
		if p.permissionDir == "" {
			return "", nil
		}
		return filepath.Join(p.permissionRoot(), p.permissionDir, "settings.json"), nil
	}
	return "", errors.New("unknown permission rule scope")
}
func agyReadSettings(path string) (map[string]any, error) {
	if path == "" {
		return map[string]any{}, nil
	}
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return map[string]any{}, nil
	}
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > agyPermissionSettingsLimit {
		return nil, errors.New("permission settings must be a regular JSON file smaller than 1 MiB")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	result := map[string]any{}
	if err = json.Unmarshal(data, &result); err != nil || result == nil {
		return nil, fmt.Errorf("invalid permission settings in %s", path)
	}
	return result, nil
}
func agyRevision(value any) string {
	data, _ := json.Marshal(value)
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}
func agyRules(settings map[string]any) (agyRuleDocument, error) {
	doc := agyRuleDocument{Allow: []string{}, Ask: []string{}, Deny: []string{}}
	raw, exists := settings["permissions"]
	if !exists {
		doc.Revision = agyRevision(doc)
		return doc, nil
	}
	object, ok := raw.(map[string]any)
	if !ok {
		return doc, errors.New("permissions must be an object")
	}
	for _, entry := range []struct {
		key    string
		target *[]string
	}{{"allow", &doc.Allow}, {"ask", &doc.Ask}, {"deny", &doc.Deny}} {
		if value, ok := object[entry.key]; ok {
			array, ok := value.([]any)
			if list, typed := value.([]string); typed {
				array = make([]any, len(list))
				for i, s := range list {
					array[i] = s
				}
				ok = true
			}
			if !ok {
				return doc, fmt.Errorf("permissions.%s must be an array", entry.key)
			}
			for _, item := range array {
				text, ok := item.(string)
				if !ok {
					return doc, errors.New("permission rules must be strings")
				}
				*entry.target = append(*entry.target, text)
			}
		}
	}
	if err := agyValidateRules(doc); err != nil {
		return doc, err
	}
	doc.Revision = agyRevision(doc)
	return doc, nil
}
func agyValidateRules(doc agyRuleDocument) error {
	actions := map[string]bool{"command": true, "unsandboxed": true, "read_file": true, "write_file": true, "read_url": true, "execute_url": true, "download_url": true, "mcp": true}
	for _, list := range [][]string{doc.Allow, doc.Ask, doc.Deny} {
		if len(list) > 512 {
			return errors.New("too many permission rules")
		}
		for _, rule := range list {
			i := strings.IndexByte(rule, '(')
			if len(rule) > 4096 || i < 1 || !strings.HasSuffix(rule, ")") || !actions[rule[:i]] || strings.ContainsAny(rule, "\x00\r\n") || strings.TrimSpace(rule[i+1:len(rule)-1]) == "" {
				return fmt.Errorf("invalid permission rule: %s", rule)
			}
			target := rule[i+1 : len(rule)-1]
			if strings.HasPrefix(target, "regex:") {
				if _, err := regexp.Compile(strings.TrimPrefix(target, "regex:")); err != nil {
					return fmt.Errorf("invalid permission regular expression: %w", err)
				}
			}
		}
	}
	return nil
}
func agySetRules(settings map[string]any, doc agyRuleDocument) {
	raw := cloneMap(mapValue(settings["permissions"]))
	raw["allow"], raw["ask"], raw["deny"] = append([]string{}, doc.Allow...), append([]string{}, doc.Ask...), append([]string{}, doc.Deny...)
	settings["permissions"] = raw
}
func agyValidatePolicy(policy map[string]any, inherit bool) error {
	for key, value := range policy {
		if _, ok := agyPolicyDefaults[key]; !ok {
			return fmt.Errorf("unknown permission setting %s", key)
		}
		if inherit && value == "inherit" {
			continue
		}
		if choices, ok := agyPolicyEnums[key]; ok {
			found := false
			for _, choice := range choices {
				if value == choice {
					found = true
				}
			}
			if !found {
				return fmt.Errorf("unsupported %s", key)
			}
		} else if _, ok := value.(bool); !ok {
			return fmt.Errorf("%s must be a boolean or inherit", key)
		}
	}
	return nil
}
func agyValidateSettings(settings map[string]any) error {
	policy := map[string]any{}
	for key := range agyPolicyDefaults {
		if value, ok := settings[key]; ok {
			policy[key] = value
		}
	}
	if err := agyValidatePolicy(policy, false); err != nil {
		return err
	}
	_, err := agyRules(settings)
	return err
}
func agyWriteSettings(path string, value map[string]any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	if len(data)+1 > agyPermissionSettingsLimit {
		return errors.New("permission settings must be smaller than 1 MiB")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	if info, err := os.Lstat(path); err == nil && !info.Mode().IsRegular() {
		return errors.New("refusing to replace a non-regular settings file")
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".glad-policy-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if err = file.Chmod(0600); err == nil {
		_, err = file.Write(append(data, '\n'))
	}
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(file.Name(), path)
}

func agyMergeRules(docs ...agyRuleDocument) agyRuleDocument {
	out := agyRuleDocument{Allow: []string{}, Ask: []string{}, Deny: []string{}}
	for _, entry := range []struct {
		dst   *[]string
		which func(agyRuleDocument) []string
	}{{&out.Allow, func(d agyRuleDocument) []string { return d.Allow }}, {&out.Ask, func(d agyRuleDocument) []string { return d.Ask }}, {&out.Deny, func(d agyRuleDocument) []string { return d.Deny }}} {
		seen := map[string]bool{}
		for _, doc := range docs {
			for _, rule := range entry.which(doc) {
				if !seen[rule] {
					seen[rule] = true
					*entry.dst = append(*entry.dst, rule)
				}
			}
		}
		sort.Strings(*entry.dst)
	}
	return out
}

func agySubtractRules(current, base agyRuleDocument) agyRuleDocument {
	out := agyRuleDocument{Allow: []string{}, Ask: []string{}, Deny: []string{}}
	for _, entry := range []struct {
		current, base []string
		out           *[]string
	}{{current.Allow, base.Allow, &out.Allow}, {current.Ask, base.Ask, &out.Ask}, {current.Deny, base.Deny, &out.Deny}} {
		seen := map[string]bool{}
		for _, s := range entry.base {
			seen[s] = true
		}
		for _, s := range entry.current {
			if !seen[s] {
				*entry.out = append(*entry.out, s)
			}
		}
	}
	return out
}

// newPermissionProfile removes incomplete profiles on any write failure.
func (p *AntigravityProvider) newPermissionProfile(settings map[string]any) (string, error) {
	dir := "glad-session-" + p.session.ID + "-" + newUUID()
	profile := filepath.Join(p.permissionRoot(), dir)
	owner := map[string]any{
		"sessionId": p.session.ID,
		"createdAt": time.Now().UTC().Format(time.RFC3339),
		"ownerPid":  os.Getpid(),
	}
	if err := agyWriteSettings(filepath.Join(profile, "settings.json"), settings); err != nil {
		_ = os.RemoveAll(profile)
		return "", err
	}
	if err := agyWriteSettings(filepath.Join(profile, "glad-owner.json"), owner); err != nil {
		_ = os.RemoveAll(profile)
		return "", err
	}
	return dir, nil
}

// A crash may leave a profile behind. Only collect old Glad-owned directories
// whose Linux daemon PID no longer exists; never touch another running server.
func cleanupAbandonedAgyProfiles(home string) {
	if _, err := os.Stat("/proc/self"); err != nil {
		return
	}
	root := filepath.Join(home, ".gemini", "antigravity-cli")
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if !entry.IsDir() || !strings.HasPrefix(entry.Name(), "glad-session-") {
			continue
		}
		path := filepath.Join(root, entry.Name())
		owner, err := agyReadSettings(filepath.Join(path, "glad-owner.json"))
		if err != nil {
			continue
		}
		created, err := time.Parse(time.RFC3339, stringValue(owner["createdAt"]))
		if err != nil || time.Since(created) < 7*24*time.Hour {
			continue
		}
		pid := int(numberInt64(owner["ownerPid"]))
		if pid < 1 {
			continue
		}
		if _, err := os.Stat(filepath.Join("/proc", fmt.Sprint(pid))); errors.Is(err, os.ErrNotExist) {
			_ = os.RemoveAll(path)
		}
	}
}
