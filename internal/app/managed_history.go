package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
)

// A320仅允许原生恢复设置事件追加；原封存前缀不修改，不复制或裁剪历史。
const managedResumeMetadataLimit = 2 << 20

type managedResumeMetadata struct {
	NativeResumed   bool  `json:"native_resumed"`
	OriginalBytes   int64 `json:"original_bytes"`
	AppendedBytes   int64 `json:"appended_bytes"`
	AppendedRecords int   `json:"appended_records"`
	PrefixPreserved bool  `json:"prefix_preserved"`
}

type managedHistorySeal struct {
	path   string
	info   os.FileInfo
	prefix [32]byte
}

func openManagedHistory(path string) (*os.File, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return nil, errors.New("original history path differs")
	}
	for current := path; ; current = filepath.Dir(current) {
		info, err := os.Lstat(current)
		if err != nil || info.Mode()&os.ModeSymlink != 0 {
			return nil, errors.New("original history path unavailable")
		}
		if filepath.Dir(current) == current {
			break
		}
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		file.Close()
		return nil, errors.New("original history is not regular")
	}
	return file, nil
}

func managedPrefix(ctx context.Context, file *os.File, size int64) ([32]byte, error) {
	hash := sha256.New()
	buffer := make([]byte, 64<<10)
	for left := size; left > 0; {
		if err := ctx.Err(); err != nil {
			return [32]byte{}, err
		}
		count := min(int64(len(buffer)), left)
		n, err := io.ReadFull(file, buffer[:count])
		if err != nil {
			return [32]byte{}, err
		}
		hash.Write(buffer[:n])
		left -= int64(n)
	}
	var result [32]byte
	copy(result[:], hash.Sum(nil))
	return result, ctx.Err()
}

func sealManagedHistory(ctx context.Context, path string) (*managedHistorySeal, error) {
	file, err := openManagedHistory(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	prefix, err := managedPrefix(ctx, file, info.Size())
	if err != nil {
		return nil, err
	}
	return &managedHistorySeal{path: path, info: info, prefix: prefix}, nil
}

func (seal *managedHistorySeal) observe(ctx context.Context, native string) (managedResumeMetadata, error) {
	metrics := managedResumeMetadata{OriginalBytes: seal.info.Size(), NativeResumed: true}
	file, err := openManagedHistory(seal.path)
	if err != nil {
		return metrics, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !os.SameFile(seal.info, info) || info.Mode() != seal.info.Mode() || info.Size() < seal.info.Size() || info.Size()-seal.info.Size() > managedResumeMetadataLimit {
		return metrics, errors.New("original history identity or size changed")
	}
	prefix, err := managedPrefix(ctx, file, seal.info.Size())
	if err != nil || prefix != seal.prefix {
		return metrics, errors.New("original history prefix changed")
	}
	metrics.PrefixPreserved = true
	tail, err := io.ReadAll(io.LimitReader(file, managedResumeMetadataLimit+1))
	if err != nil || len(tail) > managedResumeMetadataLimit || ctx.Err() != nil {
		return metrics, errors.New("original history append is unbounded or expired")
	}
	metrics.AppendedBytes = int64(len(tail))
	if len(tail) > 0 {
		if tail[len(tail)-1] != '\n' {
			return metrics, errors.New("original history append is truncated")
		}
		for _, line := range bytes.Split(bytes.TrimSuffix(tail, []byte{'\n'}), []byte{'\n'}) {
			var row struct {
				Type    string `json:"type"`
				Payload struct {
					Type     string `json:"type"`
					ThreadID string `json:"thread_id"`
				} `json:"payload"`
			}
			if json.Unmarshal(line, &row) != nil || row.Type != "event_msg" || row.Payload.Type != "thread_settings_applied" || (row.Payload.ThreadID != "" && row.Payload.ThreadID != native) {
				return metrics, errors.New("original history contains an unauthorized append")
			}
			metrics.AppendedRecords++
		}
		if metrics.AppendedRecords != 1 {
			return metrics, errors.New("original history restore settings count differs")
		}
	}
	final, err := file.Stat()
	if err != nil || final.Size() != info.Size() || final.ModTime() != info.ModTime() {
		return metrics, errors.New("original history changed during observation")
	}
	return metrics, ctx.Err()
}

func validateManagedSettings(expected, actual map[string]any, cwd string) error {
	for input, output := range map[string]string{"model": "model", "effort": "reasoningEffort", "permissionMode": "approvalPolicy"} {
		value := stringValue(expected[input])
		if value != "" && value != "default" && stringValue(actual[output]) != value {
			return errors.New("original native settings changed")
		}
	}
	if stringValue(actual["cwd"]) != cwd {
		return errors.New("original native working directory changed")
	}
	if mode := stringValue(expected["sandboxMode"]); mode != "" && mode != "default" {
		wanted := mapValue(codexSandboxPolicy(mode, cwd))
		if wanted["type"] == nil || mapValue(actual["sandbox"])["type"] != wanted["type"] {
			return errors.New("original native sandbox changed")
		}
	}
	if tier := stringValue(expected["serviceTier"]); tier != "" && tier != "default" && stringValue(actual["serviceTier"]) != tier {
		return errors.New("original native service tier changed")
	}
	return nil
}
