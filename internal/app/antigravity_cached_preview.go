package app

import (
	"context"
	"path/filepath"
)

// Only an already active conversation, or one discovered by this process's
// authenticated native session/list, may use the fast filesystem projection.
// Unknown IDs keep using ACP's original preview/authorization path.
func (p *AntigravityProvider) cachedPreview(ctx context.Context, id string) (map[string]any, bool, error) {
	if !agySubagentUUID.MatchString(id) {
		return nil, false, nil
	}
	p.mu.Lock()
	generation := p.generation
	allowed := p.ready && !p.closed && (id == p.nativeID || p.previewIDs[id] == generation && generation > 0)
	p.mu.Unlock()
	if !allowed {
		return nil, false, nil
	}
	root, err := agySubagentOpenBrain(p.subagentReader().directory)
	if err != nil {
		return nil, false, nil
	}
	defer root.Close()
	file, err := agySubagentOpen(root, filepath.Join(id, ".system_generated", "logs", "transcript_full.jsonl"))
	if err != nil {
		return nil, false, nil
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return nil, false, nil
	}
	rows, before, warnings, err := agySubagentReadRows(ctx, file, info.Size(), 40, 512<<10)
	if err != nil {
		return nil, false, err
	}
	messages := agySubagentMessages(id, rows)
	for _, message := range messages {
		message["isRootTurn"] = true
	}
	p.mu.Lock()
	valid := p.generation == generation && !p.closed
	p.mu.Unlock()
	if !valid {
		return nil, false, nil
	}
	return map[string]any{"success": true, "messages": messages, "historySource": "native-log-tail", "partial": before > 0 || len(warnings) > 0, "warnings": warnings, "historyOnly": true}, true, nil
}
