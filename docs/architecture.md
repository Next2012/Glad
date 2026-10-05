# Glad architecture

Glad is a local Go daemon with an embedded browser UI. The daemon coordinates the official Codex and Claude CLIs already installed and authenticated on the host. Provider CLIs own model execution; optional group Supervisors schedule checks and authorize inter-session operations through Glad MCP tools.

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
  ├─ SessionControl readiness, output revisions and input deduplication
  ├─ group Supervisor scheduling, invocation provenance and JSONL audits
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

New Codex asynchronous question cards emit `question-request` events. ServerChan sends a pending-answer reminder when the integration is configured and notifications are enabled for that session. Deduplication uses the question card ID, allowing separate questions and turn completion to notify independently. Card updates, submitted answers, and restored history do not emit new question notifications.

Provider output is normalized into a small set of message kinds:

- `user` and `assistant`
- `reasoning`
- `tool` and `tool-result`
- `permission-request` and `permission-updated`
- `turn-start` and `turn-end`
- provider-specific status, usage, context and compaction cards

Large Codex tool and subagent details remain server-side until the browser requests them. Browser data is display state, never an authority for filesystem access or provider permissions.

Codex text and tool-output deltas are accumulated in provider-owned builders instead of repeatedly copying the complete message. Stream lookups cache the Glad message ID, completed or abandoned streams are released with their provider lifecycle, and retained tool output is capped at 8 MiB before lazy detail delivery.

Claude's stream-json adapter uses the same normalized browser contract through a
set of focused reducers. Partial assistant events patch one durable message,
`AskUserQuestion` requests use a question lifecycle that is separate from tool
approvals, Todo/Task calls update task-plan snapshots, and forwarded subagent
messages retain their `parent_tool_use_id` relationship. Permission suggestions
from Claude are returned verbatim when the user chooses “Allow & remember”;
Glad does not synthesize broader persistent rules. Usage plus context commands
are combined into one status card, while manual and automatic compaction events
use the shared compaction presentation.

Codex resume requests load only thread metadata plus an initial full-item page, follow `nextCursor` through the remaining turns, and build normalized history off-session. Glad swaps the completed history atomically and emits one `history-reset`; cancellation or page failure leaves the previous messages intact.

Resume and fork share a provider-owned single-flight boundary, so multiple browsers cannot switch the active Codex thread concurrently. The history picker lists metadata in cursor pages and loads a bounded recent-message preview only when requested.

Automatic Codex titles follow the CLI design: Glad starts an ephemeral, read-only thread through the existing app-server connection, disables tools and external integrations, requests bounded structured output, persists the result with `thread/name/set`, and unsubscribes the temporary thread. These events are routed separately and never enter the main transcript or lifecycle state. Manual names always win.

## Provider lifecycle

Each Glad session owns one provider process and a process group. Deleting a session or stopping Glad terminates the complete provider process tree.

Sessions also own a cancellation context used by timed inputs, while WebSocket provider commands inherit the connection context and a bounded command timeout. The scheduler derives its workers from the application context and waits for them during shutdown. Sessions are added to the public manager only after provider initialization succeeds.

Explicit Codex interruption is provider-owned state. Glad first requests `turn/interrupt`; if no interrupted completion arrives within five seconds, it stops the app-server process group, settles the active turn as cancelled, and restarts plus resumes the thread before the next message. Resume has no turn id, so stopping during resume cancels the request and recycles app-server immediately.

Codex controls retries for upstream model connections, including fallback from WebSocket to HTTP. Glad displays retry errors and keeps the active turn running until Codex reports `turn/completed`, allowing recovery to finish without an automatic interruption based on reconnect counts.

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

## Effective output speed

Native Codex and Claude sessions collect live root-turn observations in `session_speed.go`; the browser never times WebSocket chunks. The header badge sits before History and retains the last completed turn while another turn runs. Tiles share the same indicator. Its integer value carries `≈`; replies under 50 tokens keep their latest-turn value but are dimmed, with a `Short reply` tooltip and a visible explanation in the panel; the panel shows tok/s with decimals, recent 10/50/100-turn arithmetic means, and 24 hourly bins grouped by completion time in the browser’s timezone. Same-model scope also matches provider, routing profile, effort and Fast mode.

The panel is named **Effective output speed** and explicitly states that the estimate includes waiting for the first output and thinking. The common metric is reported root output tokens divided by the monotonic turn duration after observed blocking tool and human-wait intervals. Intervals are clipped and unioned, and confirmed overlap with root-model stream activity is retained. Asynchronous agent work, service queuing and hidden activity cannot be fully separated by CLI events, so this is an observed estimate rather than a pure decoding benchmark. Codex thread-wide cumulative counters are differenced per root turn, including the inferred pre-turn baseline after Resume; child-thread events are ignored. Claude root response usage is deduplicated by provider message ID across streamed and final assistant messages. Root tool calls and thinking can contribute output tokens. Codex collaboration operations (including spawn, wait and resume) remove only the root invocation’s own interval, never the background child’s full lifetime. Claude repeated usage for one reply retains the maximum value. `result.usage` is retained only as a diagnostic scope comparison: a difference does not make the root sample incomplete. Automatic compaction is recorded as an annotation without silently changing the counting window.

Short samples under 50 reported tokens are marked but included by default. An optional **Exclude samples under 50 tokens** switch starts off, applies consistently to both turn and hourly means, and reports included and excluded counts. It changes neither the latest-turn badge nor the raw recent list. The recent-N window remains the latest N completed turns, not N older long replies selected to fill a quota. Incomplete observations and unsuccessful turns do not enter averages. Old native histories are not backfilled with invented timings. JSONL storage under `~/.glad/speed` contains token/timing/model metadata, not prompts or transcripts. Each conversation keeps a bounded current and previous log, observations older than 90 days are ignored, and the in-memory index is capped at 50,000 samples. Corrupt lines are reported internally and skipped; a broken tail cannot swallow the next append. Statistics follow native conversation identity across Resume; Fork uses its new identity without copying the parent’s statistics.

The read-only API is `GET /api/sessions/{id}/speed?scope=session|model&limit=10|50|100&timezone=...&excludeShort=true|false`. All retained per-turn rows remain available in the returned recent list, including interrupted and incomplete observations; only valid completed turns contribute to mean values.

### Native comparison (2026-10-05)

These are individual observations, not a cross-model performance ranking. Codex 0.159.2 and Claude Code 2.1.287 ran isolated plain-text, one `sleep 2` tool call, reasoning, and interrupted workloads. Claude used Haiku except the Sonnet reasoning task. This validation table preserves each observed output count and the different denominators; it is not mixed into production statistics.

| Provider | Task | Output tokens | Turn seconds | Blocked seconds | Visible stream tok/s | Message stream tok/s | Adjusted turn tok/s | Claude API tok/s |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| codex | plain | 171 | 12.7 | 0.0 | 34.2 | — | 13.5 | — |
| codex | tool | 228 | 19.7 | 1.9 | 42.1 | — | 12.8 | — |
| codex | thinking | 153 | 12.3 | 0.0 | 56.5 | — | 12.4 | — |
| codex | interrupted | — | 1.5 | 0.0 | — | — | — | — |
| claude-code | plain | 244 | 5.4 | 0.0 | 110.1 | 92.0 | 44.8 | 55.5 |
| claude-code | tool | 2995 | 21.6 | 2.0 | 215.8 | 205.4 | 153.0 | 159.9 |
| claude-code | thinking | 704 | 8.1 | 0.0 | 170.7 | 156.2 | 86.5 | 109.2 |
| claude-code | interrupted | — | 1.5 | 0.0 | — | — | — | — |

The Codex reasoning sample illustrates why visible-event timing must not be presented as complete generation time. Raw native usage also reported reasoning output as a subset of output tokens (`input + output = total`); it is not added twice. Claude root message usage was successfully collected from streamed and final messages. Both interrupted workloads lacked a complete output count and are excluded from averages. This data informed the conservative common adjusted-turn estimate; partial-message stream and Claude API timing remain diagnostics with separate denominators.
