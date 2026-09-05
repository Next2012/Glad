# Glad architecture

Glad is a local Go daemon with an embedded browser UI. The daemon does not implement an AI model or agent loop; it coordinates the official Codex and Claude CLIs already installed and authenticated on the host.

## Runtime layers

```text
Browser UI (lib/web)
        │ HTTP + WebSocket
        ▼
Go application (internal/app)
  ├─ application composition and use cases
  ├─ HTTP and WebSocket adapters
  ├─ session state and provider event normalization
  ├─ attachments, workspace and Git
  ├─ schedules, notifications and usage
  ├─ SkillHub session preparation
  ├─ Codex provider ── codex app-server --stdio
  └─ Claude provider ─ claude --print --input-format stream-json

Session contracts (internal/session)
  └─ bounded, transport-independent event fan-out
```

The repository root contains only the native entrypoint and its `go:embed` declaration. `internal/app` is the composition root and currently owns the application use cases and adapters. `internal/session` defines the first transport-independent core boundary; additional runtime code should move out of `internal/app` only when a concrete dependency boundary is needed. Browser assets remain under `lib/web` so the UI can evolve independently of the daemon.

## Browser contract

The HTTP and WebSocket contracts are implemented entirely by the Go daemon. Structured sessions receive a `codex-snapshot` or `claude-snapshot` on connection and incremental provider events afterward.

Structured user inputs carry a `clientMessageId`. The daemon serializes commands per session, validates every attachment, and replies with `send-result`; repeated IDs return the cached result without starting a second provider turn. The browser keeps its draft and attachments until the daemon accepts the message.

Provider output is published through a bounded session event hub. WebSocket clients and background consumers have independent queues, so a slow browser or notification transport cannot block provider stdout processing. Falling-behind subscribers are disconnected and recover from a fresh session snapshot.

Provider output is normalized into a small set of message kinds:

- `user` and `assistant`
- `reasoning`
- `tool` and `tool-result`
- `permission-request` and `permission-updated`
- `turn-start` and `turn-end`
- provider-specific status, usage, context and compaction cards

Large Codex tool and subagent details remain server-side until the browser requests them. Browser data is display state, never an authority for filesystem access or provider permissions.

Codex text and tool-output deltas are accumulated in provider-owned builders instead of repeatedly copying the complete message. Stream lookups cache the Glad message ID, completed or abandoned streams are released with their provider lifecycle, and retained tool output is capped at 8 MiB before lazy detail delivery.

## Provider lifecycle

Each Glad session owns one provider process and a process group. Deleting a session or stopping Glad terminates the complete provider process tree.

Sessions also own a cancellation context used by timed inputs, while WebSocket provider commands inherit the connection context and a bounded command timeout. The scheduler derives its workers from the application context and waits for them during shutdown. Sessions are added to the public manager only after provider initialization succeeds.

Codex uses newline-delimited JSON-RPC over `codex app-server --stdio`. Claude uses the same bidirectional stream protocol as the Agent SDK, including control requests for interactive tool approvals. Provider-specific events are tolerated as JSON maps so newer CLI fields do not break older Glad binaries.

## Persistence

- Provider conversation history remains owned by the official CLIs.
- Glad preferences stay in `~/.glad/config.json`.
- Existing `~/.glad/schedules.json` jobs are imported for compatibility.
- Uploads and prepared SkillHub sessions use private temporary directories and are removed with their Glad session.
- SkillHub tokens remain AES-256-GCM encrypted. Glad automatically creates a private
  `~/.glad/skillhub.key` when `GLAD_SKILLHUB_KEY_FILE` is not set; deployments can still
  provide that environment variable to manage the key externally.

## Distribution

Frontend assets are compiled into the native binary. The npm package is a small launcher with OS/CPU-specific optional packages; it does not publish the Go backend source. Direct GitHub release binaries do not require Node.js.

See [development.md](development.md) for local commands and [releasing.md](releasing.md) for the release sequence.
