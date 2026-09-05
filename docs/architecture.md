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

Codex resume requests load only thread metadata plus an initial full-item page, follow `nextCursor` through the remaining turns, and build normalized history off-session. Glad swaps the completed history atomically and emits one `history-reset`; cancellation or page failure leaves the previous messages intact.

Resume and fork share a provider-owned single-flight boundary, so multiple browsers cannot switch the active Codex thread concurrently. The history picker lists metadata in cursor pages and loads a bounded recent-message preview only when requested.

Automatic Codex titles follow the CLI design: Glad starts an ephemeral, read-only thread through the existing app-server connection, disables tools and external integrations, requests bounded structured output, persists the result with `thread/name/set`, and unsubscribes the temporary thread. These events are routed separately and never enter the main transcript or lifecycle state. Manual names always win.

## Provider lifecycle

Each Glad session owns one provider process and a process group. Deleting a session or stopping Glad terminates the complete provider process tree.

Sessions also own a cancellation context used by timed inputs, while WebSocket provider commands inherit the connection context and a bounded command timeout. The scheduler derives its workers from the application context and waits for them during shutdown. Sessions are added to the public manager only after provider initialization succeeds.

Codex interruption is provider-owned state. Glad first requests `turn/interrupt`; if no interrupted completion arrives within five seconds, it stops the app-server process group, settles the active turn as cancelled, and restarts plus resumes the thread before the next message. Resume has no turn id, so stopping during resume cancels the request and recycles app-server immediately.

Codex uses newline-delimited JSON-RPC over `codex app-server --stdio`. Claude uses the same bidirectional stream protocol as the Agent SDK, including control requests for interactive tool approvals. Provider-specific events are tolerated as JSON maps so newer CLI fields do not break older Glad binaries.

## Persistence

- Provider conversation history remains owned by the official CLIs.
- Glad preferences stay in `~/.glad/config.json`.
- Session card ordering stays in browser local storage as a UI-only preference shared by the lobby and tiled workspace.
- Existing `~/.glad/schedules.json` jobs are imported for compatibility.
- Uploads and prepared SkillHub sessions use private temporary directories and are removed with their Glad session.
- SkillHub tokens remain AES-256-GCM encrypted. Glad automatically creates a private
  `~/.glad/skillhub.key` when `GLAD_SKILLHUB_KEY_FILE` is not set; deployments can still
  provide that environment variable to manage the key externally.

## Distribution

Frontend assets are compiled into the native binary. The npm package is a small launcher with OS/CPU-specific optional packages; it does not publish the Go backend source. Direct GitHub release binaries do not require Node.js.

See [development.md](development.md) for local commands and [releasing.md](releasing.md) for the release sequence.
