# Group Supervisor

Each group can have one Supervisor. Turn on **Supervisor** beside an agent message or in **Members**; a member does not need to have spoken first. Enabling a different member asks you to confirm replacing the current Supervisor. Click the active switch to remove the role. Changes synchronize across connected browsers.

The Supervisor coordinates other active members during ordinary conversation. There are no scheduled checks, tasks, invocation leases or per-member permission matrices. Give the Supervisor a normal instruction describing the work you want coordinated. A worker must be idle before receiving a new task; to change its direction, stop its current turn, wait until it is idle, then send the new task.

## Tools

All members retain shared history access through `list_rooms`, `room_members`, `room_turns`, `room_turn_details` and `room_references`. Membership includes history from before joining. Turn details are paginated original JSONL plus labeled live snapshots; follow `nextOffset` and `snapshotId` while `hasMore` is true. Codex, Claude and Antigravity native history remains owned by each CLI, including when a member is offline.

Only the current Supervisor can use these controls:

| Tool | Purpose |
| --- | --- |
| `room_read_member` | Live output, status, current turn, pending permissions and questions. Supports `after` for incremental reads and `history`, `offset`, `limit` for in-memory pages. Use turn details for full native records. Offline members return `available: false`. |
| `room_start_member` | Dispatch a task to another idle member, optionally quoting group entries. The instruction appears in the group as a Supervisor message. |
| `room_stop_member` | Interrupt `expectedTurnId`. Read again to confirm the member is idle. |
| `room_approve_member` | Allow or deny a pending request. No session-wide grants, persistent rules or permission-mode changes. Some Codex grants last the current turn. Antigravity accepts only matching `allow_once` or `reject_once` native options. |
| `room_answer_member` | Answer a pending question by question ID and field IDs, using the provider's existing validation. |

Tools identify their group and target by `roomId` and `memberId`. The daemon authenticates the calling session, checks current membership and role, and checks again after acquiring the target control lock. A Supervisor cannot control itself. Disabling or replacing the role rejects queued actions that have not been accepted; previously accepted effects cannot be undone. Starts, stops, approvals and answers use connection-scoped, content-bound operation IDs to avoid duplicate retries. Stops, approvals and answers are recorded in the group's existing store (the latest 200 actions) and labeled in the target session.

Removing the Supervisor from the group clears the role. Resume and Fork preserve it when its member is successfully restored and included. The role is independent in each group. Closing the browser leaves the group running; closing the group revokes group tool access. Existing filesystem, shell and ordinary HTTP access are still governed by the provider and host, not by this group role.

Glad configures its local MCP tools at provider startup. Codex and Claude use their existing preapproval configuration. Antigravity receives a private runtime `mcp(glad/*)` Allow rule; explicit Ask/Deny and Strict still take precedence. For ACP versions that still forward a Glad tool as an external-tool approval, the adapter resolves only known Glad tools using this private rule, honoring Strict, Ask and Deny. User global settings are not rewritten when a member becomes Supervisor.

## Context and storage

Long-press a completed message to enter the existing reference selection mode. With one message selected, **Context** opens its surrounding session turns. **Preview** retains **View context** for individual quoted messages.

This redesign uses group schema version 4. Older Glad group records and obsolete `~/.glad/supervisors/` state are removed on startup; there is no migration of old groups or periodic tasks. Native Codex, Claude and Antigravity conversations are preserved. Files written by a newer Glad version are rejected and retained.
