package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"
)

func (p *AntigravityProvider) UpdateSettings(ctx context.Context, settings map[string]any) error {
	p.opMu.Lock()
	defer p.opMu.Unlock()
	if err := p.start(ctx); err != nil {
		return err
	}
	return p.updateSettings(ctx, settings)
}
func (p *AntigravityProvider) updateSettings(ctx context.Context, settings map[string]any) error {
	if len(settings) == 0 {
		return errors.New("no Antigravity settings supplied")
	}
	p.mu.Lock()
	if p.closed || p.switching || p.stopping || p.turnID != "" {
		p.mu.Unlock()
		return errors.New("Antigravity settings can only change while idle")
	}
	type change struct {
		id       string
		value    any
		fallback bool
	}
	changes := []change{}
	// Validate the complete request before changing anything in the native CLI.
	for key, value := range settings {
		id := key
		if key == "effort" {
			id = "thought_level"
		}
		found := false
		for _, option := range p.configOptions {
			if option["id"] != id {
				continue
			}
			found = true
			if stringValue(option["type"]) == "boolean" {
				if _, ok := value.(bool); !ok {
					p.mu.Unlock()
					return fmt.Errorf("%s must be a boolean", key)
				}
			} else {
				text, ok := value.(string)
				if !ok || strings.TrimSpace(text) == "" || !antigravityOptionValue(option["options"], text) {
					p.mu.Unlock()
					return fmt.Errorf("unsupported Antigravity %s: %v", key, value)
				}
			}
			changes = append(changes, change{id: id, value: value})
			break
		}
		if !found && id == "mode" {
			for _, mode := range mapsFromAny(p.modes["availableModes"]) {
				if mode["id"] == value {
					found = true
					changes = append(changes, change{id: id, value: value, fallback: true})
					break
				}
			}
		}
		if !found {
			p.mu.Unlock()
			return fmt.Errorf("Antigravity CLI does not advertise setting %s", key)
		}
	}
	native := p.nativeID
	generation := p.generation
	p.mu.Unlock()
	for _, change := range changes {
		method := "session/set_config_option"
		params := map[string]any{"sessionId": native, "configId": change.id, "value": change.value}
		if change.fallback {
			method = "session/set_mode"
			params = map[string]any{"sessionId": native, "modeId": change.value}
		}
		result, err := p.rpc(ctx, method, params)
		if err != nil {
			return err
		}
		p.mu.Lock()
		if p.generation != generation || p.nativeID != native {
			p.mu.Unlock()
			return errors.New("Antigravity conversation changed while updating settings")
		}
		if result["configOptions"] != nil {
			p.configOptions = mapsFromAny(result["configOptions"])
		} else {
			p.configOptions = append([]map[string]any(nil), p.configOptions...)
			for index, option := range p.configOptions {
				if option["id"] == change.id {
					replacement := cloneMap(option)
					replacement["currentValue"] = change.value
					p.configOptions[index] = replacement
				}
			}
		}
		if change.id == "mode" {
			p.modes = cloneMap(p.modes)
			p.modes["currentModeId"] = change.value
		}
		key := change.id
		if key == "thought_level" {
			key = "effort"
		}
		p.options[key] = change.value
		if key == "mode" {
			p.modeInherited = false
		}
		p.publishStateLocked()
		p.mu.Unlock()
	}
	return nil
}
func antigravityOptionValue(raw any, value string) bool {
	for _, option := range mapsFromAny(raw) {
		if option["value"] == value {
			return true
		}
		if antigravityOptionValue(option["options"], value) {
			return true
		}
	}
	return false
}
func (p *AntigravityProvider) UpdateInstructions(ctx context.Context, instructions string) error {
	p.opMu.Lock()
	defer p.opMu.Unlock()
	p.mu.Lock()
	if p.closed || p.turnID != "" || p.switching || p.stopping {
		p.mu.Unlock()
		return errors.New("Antigravity instructions can only change while idle")
	}
	previous := p.options["developerInstructions"]
	p.options["developerInstructions"] = instructions
	generation := p.generation
	p.mu.Unlock()
	p.recycle(generation)
	err := p.start(ctx)
	if err != nil {
		p.mu.Lock()
		p.options["developerInstructions"] = previous
		p.mu.Unlock()
	}
	return err
}

// Status uses the CLI's documented local /usage command in a separate process.
// It neither submits a model prompt nor modifies the ACP conversation.
func (p *AntigravityProvider) Status(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return errors.New("Antigravity session is closed")
	}
	if p.quotaPending {
		p.mu.Unlock()
		return nil
	}
	if p.quota != nil && time.Since(p.quotaTime) < time.Minute {
		p.appendStatusLocked()
		p.mu.Unlock()
		return nil
	}
	p.quotaPending = true
	p.mu.Unlock()
	go func() {
		quota, err := p.fetchQuota(p.session.ctx)
		p.mu.Lock()
		defer p.mu.Unlock()
		p.quotaPending = false
		if p.closed {
			return
		}
		if err != nil {
			quota = map[string]any{"available": false, "error": err.Error()}
		}
		p.quota = quota
		p.quotaTime = time.Now()
		p.publishStateLocked()
		p.appendStatusLocked()
	}()
	return nil
}
func (p *AntigravityProvider) appendStatusLocked() {
	data := map[string]any{"context": p.usage, "quota": p.quota}
	encoded, _ := json.MarshalIndent(data, "", "  ")
	p.appendLocked(map[string]any{"kind": "status", "title": "Antigravity status", "text": string(encoded), "statusData": data, "context": antigravityContext(p.usage)})
}
func antigravityContext(usage map[string]any) map[string]any {
	total, used := antigravityNumber(usage["size"]), antigravityNumber(usage["used"])
	if total <= 0 {
		return nil
	}
	remaining := total - used
	if remaining < 0 {
		remaining = 0
	}
	return map[string]any{"contextWindow": total, "maxTokens": total, "usedTokens": used, "remainingTokens": remaining, "remainingPercent": remaining / total * 100}
}

type antigravityLimitedBuffer struct {
	bytes.Buffer
	remaining int
}

func (buffer *antigravityLimitedBuffer) Write(data []byte) (int, error) {
	if len(data) > buffer.remaining {
		return 0, errors.New("Antigravity usage response exceeds 1 MiB")
	}
	buffer.remaining -= len(data)
	return buffer.Buffer.Write(data)
}
func (p *AntigravityProvider) fetchQuota(ctx context.Context) (map[string]any, error) {
	command := exec.Command(p.session.Tool.Command, "-p", "/usage", "--output-format", "json")
	configureProcess(command)
	command.Dir = p.session.WorkingDirectory
	command.Env = append(os.Environ(), p.session.environment...)
	output := &antigravityLimitedBuffer{remaining: 1 << 20}
	command.Stdout = output
	command.Stderr = io.Discard
	if err := command.Start(); err != nil {
		return nil, err
	}
	finished := make(chan error, 1)
	go func() { finished <- command.Wait() }()
	timer := time.NewTimer(18 * time.Second)
	defer timer.Stop()
	select {
	case err := <-finished:
		if err != nil {
			return nil, fmt.Errorf("Antigravity usage command failed: %w", err)
		}
	case <-ctx.Done():
		killProcessTree(command)
		<-finished
		return nil, ctx.Err()
	case <-timer.C:
		killProcessTree(command)
		<-finished
		return nil, errors.New("Antigravity usage command timed out")
	}
	var result map[string]any
	if err := json.Unmarshal(output.Bytes(), &result); err != nil {
		return nil, errors.New("Antigravity usage command returned invalid JSON")
	}
	if stringValue(result["status"]) != "SUCCESS" {
		return nil, errors.New(firstNonEmpty(stringValue(result["error"]), stringValue(result["response"]), "Antigravity usage unavailable"))
	}
	groups := mapsFromAny(mapValue(mapValue(result["command"])["data"])["groups"])
	if len(groups) == 0 {
		return nil, errors.New("Antigravity usage command returned no quota groups")
	}
	return map[string]any{"available": true, "groups": groups, "fetchedAt": millis()}, nil
}

func (p *AntigravityProvider) hasCommandLocked(name string) bool {
	for _, command := range p.commands {
		if strings.TrimPrefix(stringValue(command["name"]), "/") == name {
			return true
		}
	}
	return false
}
func (p *AntigravityProvider) Compact(ctx context.Context) error {
	p.mu.Lock()
	supported := p.hasCommandLocked("compact")
	idle := p.turnID == "" && !p.switching && !p.stopping && !p.closed
	p.mu.Unlock()
	if !supported {
		return errors.New("Antigravity ACP does not advertise /compact")
	}
	if !idle {
		return errors.New("Antigravity conversation can only be compacted while idle")
	}
	return p.Send(ctx, ProviderInput{Text: "/compact", AgentText: "/compact", Internal: true})
}

// supportsModeLocked checks both ACP representations before changing a mode.
func (p *AntigravityProvider) supportsModeLocked(mode string) bool {
	for _, option := range p.configOptions {
		if option["id"] == "mode" && antigravityOptionValue(option["options"], mode) {
			return true
		}
	}
	for _, option := range mapsFromAny(p.modes["availableModes"]) {
		if option["id"] == mode {
			return true
		}
	}
	return false
}
