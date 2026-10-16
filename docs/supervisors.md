# Group Supervisors

Open a group and choose **Supervisor** in its top-right header. Create a task with a supervisor session, monitored members, an interval, and a prompt describing what the supervisor should check and do. Read, stop, and send permissions default to enabled for each selected target and can be changed individually.

The editor uses grouped settings. Tap a monitored member’s permission summary to open its three switches in the same panel; Back returns to the draft. Enabling Stop also enables Read so the supervisor can obtain the expected turn ID. Disabling Read also disables Stop. The API rejects Stop without Read; Read + Stop without Send remains supported.

The interval is the delay **after the supervisor's own check finishes**, not after a monitored session finishes. A worker can continue running throughout several checks. Monitoring waits when its executor is busy and does not queue overlapping checks.

## Task controls

| Control | Behavior |
| --- | --- |
| Save & start | Create a task and enable recurring monitoring |
| Monitoring switch off | Let the current check finish, then pause |
| Stop run | Interrupt the current check; keep the monitoring switch unchanged |
| Run once now | Expand ⋯, leave the message empty to use the configured prompt or enter a one-time message; queue one check without enabling a paused task |
| Save changes | Update configuration without changing the monitoring switch |

Each card’s ⋯ menu contains Edit, History, Delete, a message box, and Run once now at the bottom. Only one menu is expanded at a time. Messages are kept when switching cards, closing the menu, pausing monitoring, or retrying a failed submission. Enter adds a line; Ctrl/⌘+Enter submits, except while composing text with an input method. A successful submission clears only the submitted draft; text edited while the request was pending is retained.

A one-time custom message replaces only that check’s prompt. It does not change saved settings, the recurring failure count, or the recurring error message. Its result is recorded in check history. The next periodic check runs after the normal interval and is not skipped even if targets are unchanged. A second run-once request is rejected while a check is running or already queued; switching monitoring off cancels the queued check. Restarting Glad clears queued messages.

Changing only the prompt keeps the existing countdown. Changing the interval updates the next scheduled time. The list shows status and recent results; open task details for check history, and expand a check to load its tool calls. Prompt and usage details are collapsed by default.

Monitored sessions cannot include the executor. A session cannot simultaneously be an executor and another task's monitored target. These roles apply across groups sharing that session.

## Instructions and tools

Each wake supplies your prompt, its current invocation ID, and a fresh list of monitored session names, identities, states and permissions. Monitor content is read on demand. Glad supplies ten supervisor MCP tools:

| Tool | Purpose |
| --- | --- |
| `list_targets` | List target identities, permissions and located original transcript paths. |
| `read_session` | Read live output or paginated in-memory history. Pending questions are returned separately from the message page. |
| `session_turns` | Read summaries for arbitrary `turnIds`, `turnNumbers` such as `[1,3,9]`, or `fromTurn`/`toTurn`. `offset`/`limit` paginate the matching turns. |
| `session_turn_details` | Read selected complete turns as native JSONL plus labeled live snapshots, including tools and available reasoning. `offset`/`limit` count bytes; continue with `nextOffset` and `snapshotId` while `hasMore`. |
| `session_history` | Obtain the original transcript path and a Markdown index containing timestamps, previews and byte ranges. Index pagination uses row offsets. |
| `read_session_record` | Read original transcript chunks, following `nextOffset` while `hasMore` is true. Offsets and limits count bytes; default 32 KiB, maximum 128 KiB. |
| `answer_question` | Answer a pending Codex question using its question ID and answers keyed by question field IDs. Requires both Read and Send. |
| `stop_session` | Stop an expected target turn. |
| `send_to_session` | Send a new instruction to an idle target. |
| `end_supervision` | End the invocation or recurring task as described below. |

Transcript indexes are extracted without another model call, cached in memory within a 16 MiB cache budget, and updated as complete JSONL records are appended. Original transcripts are never copied or rewritten. Indexes contain short previews; follow byte ranges with `read_session_record` to read original content of any length. The index reports its file size and `indexedThrough` boundary. Use `read_session` for the latest live output and question state because native logs may lag behind the provider. Missing native files are reported explicitly and do not prevent live reading.

Turn summaries contain extracted input/output previews, timestamp, status, tool count and reference locators. They are not model-generated semantic summaries. Turn queries read the original history independently of the browser's bounded history buffers and merge live output. Turn indexes have a separate bounded 16 MiB cache. Prefer returned stable turn IDs over chronological numbers across calls. Claude live/native aliases remain selectable after native records arrive. If a running detail snapshot changes between pages, restart at byte offset zero.

## Group history MCP

Every current group member can use these read-only tools without a supervisor invocation:

| Tool | Purpose |
| --- | --- |
| `list_rooms` | Discover active groups the calling session belongs to. |
| `room_members` | Read member IDs and session-owned names. |
| `room_turns` | Query chronological group turn summaries, including history before joining. Filter by exact `sessionName` or `memberId`, and select arbitrary turn IDs/numbers or ranges. Duplicate names match all corresponding members. |
| `room_turn_details` | Read selected turns, at most 20 per request. Each result has an independent byte cursor and snapshot ID; continue only the turn IDs with `hasMore`. |
| `room_references` | Follow direct references and reply-to-command links recursively. Supply the current command's `entryId` or a summary's `commandEntryId`/`replyEntryId`. Missing nodes are explicit. Depth is bounded at eight; truncated graphs can be expanded from a returned node. |

Group turn IDs include member identity. One command dispatched to two members produces two execution turns linked to the same command. Internal supervisor checks stay hidden from group queries. Membership is checked before and after reads; leaving a group revokes access. Saved history IDs and active runtime IDs both resolve only to groups the caller currently belongs to. Departed members' turns remain readable up to their departure time.

Group membership grants shared-history read access independently of the supervisor's per-monitor Read switch. That switch controls supervisor monitor tools; Stop and Send permissions remain separate. Group inputs carry structured command/reference metadata so a recipient can discover that a quoted reply itself depended on earlier references. Existing persisted dispatch batches also recover their reply-to-command link; unavailable legacy sources remain explicit.

Codex async questions can be answered while the worker continues running through `turn/steer`. Blocking questions are answered through their pending RPC. A still-pending async question from a completed main turn can receive its answer as a new user turn. Answers are audited and retries are deduplicated. Pending questions remain discoverable even after later output pushes them out of the recent message page.

A new pending question advances an enabled supervisor's next check. If the executor is already checking, notifications coalesce into an early follow-up after its current turn settles. Glad never interrupts the executor, overlaps checks, or restarts paused monitoring. A model already checking can call `read_session` again to discover questions in its current turn.

For periodic and configured run-once checks, `end_supervision` disables future monitoring and returns `scope: task`. For custom checks it revokes only the current invocation’s tool access and returns `scope: invocation`; the monitoring switch stays unchanged. The executor must still finish its turn before another check can start.

For example:

> Check the worker against the agreed development plan. Read its latest output and inspect the results. If more work is needed, send a specific next instruction. Stop it only if its current work is off track. End supervision when the acceptance criteria are met.

A stop request being accepted does not immediately make a session ready for another prompt. The supervisor should read its state again before sending. Periodic checks can observe several worker turns together; they are not triggered after every worker response.

Internal checks remain in the executor's own conversation and the Supervisor history rather than the group timeline. Commands sent to workers appear in the group with the supervisor author. Routine automated completions are quiet, while failures and requests requiring attention retain notification behavior.

## Manual member operations

Choose **Members → Controls** for an individual session. Read live output or history, stop its current run, and send its next instruction from the same panel. The send button becomes available after the provider is ready. Other members running do not block group messages sent to idle targets.

On touch or pen devices, hold a group message to select references. On mouse devices, hover over a message or focus it with the keyboard and click the circle; mouse dragging continues to select text. In selection mode, tap messages to toggle them and use **Cancel** or **Preview** at the top. Enter/Space selects a focused message; Esc exits selection.

## Persistence and access

Closing the browser does not stop monitoring in the daemon. Explicitly closing a group pauses its tasks and closes its idle member sessions that are not used by another open group. Busy sessions, pending questions or approvals, and active supervisor reservations are preserved; saved histories remain available. Returning to the lobby only leaves the page. Restarting Glad preserves configuration and bounded audit history but pauses monitoring until you restore members and resume it. Unreadable task files are retained and reported without preventing startup.

Credentials and invocation checks apply to the Glad Supervisor tools. They do not isolate the session's existing filesystem, shell, or ordinary HTTP access. Glad preapproves its local MCP tools in Codex and supplies its tool allowlist to Claude. The daemon still checks the current invocation and per-target permissions on every call. Provider policies continue to govern shell commands and other tools; managed restrictions or Claude deny rules can still block execution. Newly started provider processes receive the Glad MCP configuration, so running processes must be restarted to pick up a configuration update.

Monitoring consumes model usage on every invocation and extends the supervisor conversation. The default interval is two minutes, with a one-minute minimum. **Skip unchanged idle sessions** is optional and off by default because file changes or time-based conditions may need checks even when conversation output does not change.
