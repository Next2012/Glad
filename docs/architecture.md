# Glad architecture

Glad is a local Go daemon with an embedded browser UI. The daemon coordinates the official Codex, Claude and Antigravity CLIs already installed and authenticated on the host. Provider CLIs own model execution; optional group Supervisors schedule checks and authorize inter-session operations through Glad MCP tools.

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
  ├─ Claude provider ─ claude --print --input-format stream-json
  └─ Antigravity provider ─ agy acp

Session contracts (internal/session)
  └─ bounded, transport-independent event fan-out
```

The repository root contains only the native entrypoint and its `go:embed` declaration. `internal/app` is the composition root and currently owns the application use cases and adapters. `internal/session` defines the first transport-independent core boundary; additional runtime code should move out of `internal/app` only when a concrete dependency boundary is needed. Browser assets remain under `lib/web` so the UI can evolve independently of the daemon.

## Browser contract

The HTTP and WebSocket contracts are implemented entirely by the Go daemon. Structured sessions receive a `codex-snapshot`, `claude-snapshot`, or `antigravity-snapshot` on connection and incremental provider events afterward.

Structured user inputs carry a `clientMessageId`. The daemon serializes commands per session, validates every attachment, and replies with `send-result`; repeated IDs return the cached result without starting a second provider turn. The browser keeps its draft and attachments until it receives that correlated acceptance. A disconnect before the acknowledgement leaves the delivery result unconfirmed; the browser preserves the draft and does not automatically resend it.

The direct session WebSocket keeps network reads active while a bounded serial
worker executes commands, so a slow provider operation cannot prevent Ping/Pong
control frames from being consumed. Incoming frames have an explicit 8 MiB limit;
the per-connection command queue allows at most 32 commands and 8 MiB of accounted
payload, including the command in progress. Queue pressure produces a rejection
rather than waiting inside the network reader. Non-input errors retain bounded
request correlation so pending detail and status requests can settle. Transport
close diagnostics record only stages, codes and normalized causes, never prompts,
attachments or authentication data. Reconnecting browsers wait for a fresh
conversation snapshot before enabling Send again.

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

## Group conversation pages and supervision

Group HTTP reads and initial WebSocket snapshots contain at most 48 entries. Later WebSocket frames carry changed entries and the ordered IDs of the current page. The browser retains one page plus selected references and bounded preview/detail caches; historical pages stay fixed while current metadata changes. Long message bodies have a byte-paginated endpoint. Closing a group removes only idle, unshared runtime sessions after checking the session command lock, provider readiness, pending interactions, and Supervisor reservations.

Supervisor history reads resolve the provider-owned JSONL path from the current conversation identity. Markdown indexes cache only offsets and short previews, update on completed appended records, and fall back to streaming pages if the index exceeds the cache budget. Raw byte reads provide continuation offsets and preserve UTF-8 boundaries. Neither path copies or rewrites the original transcript. Live output includes pending questions independently of its message page. Authorized Codex answers reuse the provider's RPC or `turn/steer` path, and new questions coalesce into an early check after the executor settles.

## Effective output speed

Native Codex, Claude and Antigravity sessions collect live root-turn observations in `session_speed.go`; the browser never times WebSocket chunks. The header badge sits before History and retains the last completed turn while another turn runs. Tiles share the same indicator. Its integer value carries `≈`; replies under 50 tokens keep their latest-turn value but are dimmed, with a `Short reply` tooltip and a visible explanation in the panel; the panel shows tok/s with decimals, recent 10/50/100-turn arithmetic means, and 24 hourly bins grouped by completion time in the browser’s timezone. Same-model scope also matches provider, routing profile, effort and Fast mode where supported.

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

## Antigravity provider and running-turn instructions

Antigravity has an independent ACP transport, reducer, native settings catalog,
interaction handling and lifecycle under `antigravity*.go`. It does not inherit
Codex state or route ACP through another CLI. The browser has its own
`antigravity.js` controller and reuses existing Markdown, plan/context rendering,
attachments, session event fan-out, and layout primitives. Existing Codex and
Claude wire contracts remain available.

Antigravity sessions use tool key `antigravity`, command `agy`, and kind
`antigravity-structured`. Native identity is exposed as `nativeConversationId`
and `antigravitySessionId`; group, name and workbench identity helpers recognize
it explicitly. Model, thinking level and execution mode come from ACP's session
configuration catalog. Unsupported Fork and Fast operations are not presented
as equivalent Codex features. Instructions use the advertised Antigravity system
prompt append capability and MCP servers are supplied per session without
rewriting global CLI configuration.

ACP `session/prompt` normally remains pending during inference; steering can
acknowledge an earlier prompt while the root turn continues. Sending a prompt
does not hold the session command lock until completion: the session context owns the
reader and result worker, so browser disconnection does not cancel inference.
Native permissions retain the original option IDs; elicitation forms are
questions with their own lifecycle. Native updates normalize to existing Glad
message kinds. Large tool/reasoning details use the existing lazy-detail path.
The adapter tracks outstanding prompt requests and running non-daemon tools
before concluding a root turn, and cancels with bounded process-tree recovery.

Codex and Antigravity implement the optional `SteeringProvider` contract.
Running-turn inputs explicitly carry `delivery: "steer"`, `expectedTurnId` and a
client message ID through HTTP or WebSocket. Providers recheck the active turn
under their own lock. A stale turn never falls back to a new user turn; a
rejection preserves the browser draft and attachments. Input deduplication
includes delivery and target identity. New-turn readiness stays idle-only for
schedules and supervisor dispatch. Blocking interactions, recovery and stopping
keep steering unavailable. Steering source metadata belongs to the appended
message and does not replace the source of the original invocation.

Antigravity history loading stages replay away from the visible conversation,
then swaps it atomically. Preview uses an isolated ACP reader and never switches
the active process. The original history stays owned by agy. ACP history does
not claim to be Codex/Claude JSONL: native byte-record APIs may be unavailable,
while live normalized output and turn detail remain readable by authorized
supervisors. Quota status uses a cached, separate `agy -p /usage --output-format
json` query. Context occupancy, quota, output-token speed and historical cost
reports remain distinct; unknown token counts never become invented speed data.

Message metadata shares the existing conversation styles: sent times for user
messages, completion times for live replies, and one context snapshot under the
last reply in each root turn. Context occupancy is not kept in the input toolbar.
ACP replay omits timestamps, so `antigravity_times.go` reads native
`brain/<session>/.system_generated/logs/transcript_full.jsonl` without modifying
it. Unique exact content matches restore `created_at`; file modification and
replay times are never substituted. Historical replies with only a creation
time identify it as their start time. Missing or ambiguous times remain unknown.

Antigravity's final ACP usage is a snapshot of the active root turn. An early
steering acknowledgement can omit usage; later snapshots replace earlier ones
instead of being added. Native output includes thinking tokens. The provider
feeds these counts and observed stream/tool/human boundaries to the shared speed
tracker through a small independent adapter in `antigravity_metrics.go`.

`AntigravityUsageStore` persists compact token records in daily ledgers separately
from speed history, with stable root IDs, 90-day retention, restart deduplication,
and interrupted-tail recovery. Speed log rotation cannot remove dashboard
totals. `usage_antigravity.go` aggregates this store by model and local day/week/
month without depending on ccusage or private agy SQLite/protobuf formats.
Dashboard coverage begins with recorded live usage; incomplete records and
unknown pricing are explicit, and native history is not backfilled.

## Document previews and remote loading

Conversation resource links share an independent, lazily loaded preview dialog;
provider controllers do not own file viewers. Markdown uses the existing
[markdown-it](https://github.com/markdown-it/markdown-it) pipeline, with nested
links and images resolved from the document's directory. PDF rendering uses
[Mozilla PDF.js](https://github.com/mozilla/pdf.js), image interaction uses
[ViewerJS](https://github.com/fengyuanchen/viewerjs), and code highlighting uses
[Highlight.js](https://github.com/highlightjs/highlight.js). These libraries are
pinned, bundled with the binary, and requested only for the corresponding
preview. No CDN connection is needed at runtime. Plain text needs no renderer.

The workspace resource route retains the session cwd and symlink boundary.
Local file URLs, encoded paths, and source line suffixes are normalized without
searching unrelated directories. Missing files and directories produce explicit
preview errors. File responses support attachment downloads and HTTP byte
ranges, and stream from disk with a separate 256 MiB resource limit; the editor's
4 MiB read/modify limit is unchanged. Preview text and canvas memory have smaller
client limits. Closing or replacing a preview cancels its outstanding work.

Application scripts use ordered `defer` loading. Terminal assets load on demand
alongside the document viewers. Embedded text assets use gzip and representation
ETags through a bounded cache. Unversioned assets must revalidate, so a new binary
cannot leave clients on indefinitely cached scripts; dynamic APIs remain
`no-store`.

The workbench bridge remains a bounded base64 protocol, rather than an end to
end byte stream. Its optional `request_headers` forwards only conditional and
range headers; GET and HEAD retain the same owned-session authorization.
Resource size, range, cache, and disposition response headers are allowlisted.
The 8 MiB per-response bridge limit is enforced during copying. Older workbench
clients which do not forward range headers still cannot transfer a resource
larger than that limit in one response.

MCP resources retain the originating session's credentials and safe MIME
metadata, including Markdown and SVG. Their upstream `resources/read` operation
still returns the entire resource: the existing 4 MiB decoded / 8 MiB envelope
limits remain explicit, and this path does not advertise byte-range streaming.

## Windowed conversations

New browser connections request `history=tail`; legacy HTTP and socket consumers
retain their full snapshot contract. The shared view protocol returns recent
root turns, limited to 128 messages and a 256 KiB history-message budget. Oversized
turns can continue across pages. Pending permissions and questions are retained
independently, so their interaction payloads are an explicit exception to the
history-message budget. A single record whose public non-text metadata exceeds
that budget has a separate, explicit `oversizedMetadata` page exception when its
provider has no existing lazy metadata reader. It occupies that page alone;
public fields are retained rather than silently discarded. Codex and Antigravity
tool metadata continues using their existing on-demand detail readers. These
exceptions remain subject to the existing provider and transport limits.
Earlier pages use a session/native-identity/reset-epoch cursor. Message revisions
prevent an older page from replacing newer live data;
completion revisions keep their separate acknowledgement semantics.

Large message bodies, including event/error text, reasoning and tool results,
use previews and version-checked UTF-8 text chunks with explicit read-full
actions. The browser bounds its expanded-body cache and restores evicted bodies
to previews.
Live user/assistant updates retain the provider's existing stream limits, so a
reply keeps progressing beyond the historical preview boundary. Reopening that
reply as history uses the bounded preview again.
Completed Markdown has a byte-bounded render cache, and distant Mermaid diagrams
wait until the reader approaches them. Private HTTP JSON responses use negotiated
gzip, while direct sockets and the workbench transport negotiate WebSocket
compression without retaining compression dictionaries. Apple browsers and
embedded WebViews use an uncompressed direct-session compatibility path; HTTP
gzip and bounded history pages remain available. The pinned WebSocket library
sends each `Conn.Write` message in one frame, including compressed messages and
small replies. Raw-frame tests cover that wire shape. The separate Linux WebKit
transport job complements Chromium coverage; it does not replace verification on
Apple's system WebSocket implementation. Workbench peers which omit the optional
history query continue receiving their legacy snapshots.

Antigravity can preview a bounded native transcript tail without a new ACP load
after its identity has been established by the active process or an authenticated
native session listing. Unknown IDs use the original ACP authorization path.
This projection is read-only; native recovery still determines when sending is
ready. Replayed text updates keep a direct message reference rather than scanning
the retained history for every chunk, and replay identities remain unique after
the retained window trims older records.

## Antigravity subagent projection

The Antigravity adapter discovers children only through verified native
parent-to-child indexes. A bounded graph reader validates every edge again before
reading a transcript, rejects symlinks and special files, and binds native history
cursors to the root identity and file epoch. Child histories have independent
IDs and remain separate from the root transcript. They never produce a second
usage-ledger entry. Cached `ALIVE` states are shown as activity unknown.

The browser fetches child bodies only for open cards, polls visible native
metadata, and cancels work when the view or parent changes. It preserves child
message DOM and disclosure state as records append. This is a local, read-only
native-log projection; sending, cancellation and permissions are not exposed as
child controls without verified native protocol support.
