# Glad group-chat architecture

Group chat is a lightweight, durable index over independent provider sessions.
Its timeline is a dynamic read model over provider-native history, not another
copy of Codex or Claude history.

Like a single session, a group has an in-memory runtime identity and a saved
conversation identity. The lobby lists only runtime groups created in this
daemon. Saved conversations are listed separately in the Resume/Fork picker;
starting the daemon or creating an empty group does not activate old groups.
Resume binds the current runtime group to the selected saved conversation. Fork
copies the saved group, creates independent forked member sessions, and switches
the current runtime group to the copy. Its runtime identity remains stable.

## Ownership boundaries

- `RoomStore` owns room identity, membership, ordering, user-authored text,
  mentions, quotes, and provider-native source locators.
- `SessionManager` owns live provider processes and normalized in-memory events.
- Codex/Claude native history owns assistant text, reasoning, tools, and results.
- Session attachment storage owns temporary files. A room never owns attachment
  bytes or paths.

The boundary is intentional. If a source session cannot be resumed, a room
entry remains in the timeline but resolves to `unavailable`.

## Persistence

Rooms are stored separately from preferences:

```text
~/.glad/
  config.json
  rooms/
    <room-id>.json
```

Each room is written atomically using a same-directory temporary file and
rename. An update does not rewrite unrelated rooms; listing reports malformed
room data instead of silently hiding or replacing it.

Every document carries `schemaVersion`. `migrateRoom` is the single ordered
migration entry point. Glad refuses to load a future schema rather than
silently dropping fields and overwriting it with an older representation.

Version 2 persists:

- room metadata and monotonic `nextSequence`;
- stable member identity and avatar seed;
- enough provider configuration to recreate a session;
- native conversation and turn locators;
- user-authored room text, mentions, and quoted entry IDs;
- dispatch status and a small error string.
- the origin room ID for every group-dispatched provider turn;
- the draft flag retained for rooms created by older builds.

It persists stable source IDs when a room message quotes provider history, but
not the quoted text. History-only timeline entries use deterministic IDs derived
from member, native turn, and role, so they can be selected without being copied
into the room document.

It does not persist assistant response text, tool data, reasoning, or
attachments.

The v1-to-v2 migration removes internal group transport envelopes that older
provider histories could expose as direct user turns after resume. Migration is
atomic and preserves the original monotonic sequence counter, real user entries,
member identities, and provider-native locators.

## Message lifecycle

1. Persist the user entry and one pending entry for each mentioned member.
2. Resolve quoted entries from current session/native history.
3. Build private `AgentText` containing only the explicit references and the
   new group message. The transport envelope carries `originRoomId`; public
   `Text` remains the user's new message.
4. Dispatch to all mentioned sessions concurrently.
5. Bind each pending entry to its provider conversation/turn.
6. On root turn completion, persist status and the stable native locator.
7. On room reads, project every active member's full native conversation,
   including turns created before the member joined, then merge it by timestamp
   with room-owned entries.

Turns started from the full mini-session are visible through the same dynamic
projection. They are never copied into room persistence. Room-dispatched turns
are matched by client/turn ID and suppressed from the native projection because
their room-owned user entry and reply locator already represent them.

A session may belong to several rooms, but remains an ordinary independent
session. Its complete native history is projected into every room that adds it,
including turns previously initiated through another room. New transports
encode the origin room ID in both the client message ID and private envelope;
that provenance is used for attribution and de-duplication, never as a history
access boundary. Legacy transports without an origin remain readable by
extracting their visible group message.

Conversation context is loaded by stable turn locator. The initial context view
contains neighboring user/assistant turns; reasoning, tools, and subagent data
remain server-side until the browser asks for that turn's details. Merely viewing
neighbors does not add them to a reference sent to another member.

Unavailable references are not silently removed. The target receives an
explicit `Message unavailable` placeholder.

## Compatibility invariants

- Persisted entries retain monotonic sequence numbers. The dynamic timeline merges native and room entries by timestamp, using sequence to break ties.
- Member display names are not unique; member IDs are.
- Removing a member is a soft delete so historical authorship survives.
- Runtime session IDs are replaceable hints. Native conversation IDs are the
  durable resume/fork identity.
- New fields must be optional within a schema version. A breaking semantic or
  representation change requires a schema migration.
- Room deletion never deletes sessions or provider-native history.
- Group ServerChan notification preferences are persisted on `RoomRecord` and
  evaluated independently from every member Session's notification switch.
- Opening a room or previewing saved history does not resume member sessions.
  Resume/Fork requires an explicit selection and runs only while the current
  group is idle. Closing its lobby entry preserves saved history and does not
  terminate independently reusable member sessions.
- Resume/Fork keeps the runtime group ID stable. Resume continues the selected
  saved group; Fork preserves the original group and member conversations.
  Operations report per-member failures. If every attempted member fails, the
  current group remains unchanged; provider-side partial success cannot be
  rolled back transactionally.
- A newly created room is durable immediately, even without members or messages.
  Returning to the lobby, reloading, or closing the page preserves it. Only
  explicitly closing the group removes its runtime entry. Saved history remains
  available for Resume/Fork after closing or restarting the daemon.

## Attachments

The browser uploads a selected file independently to every mentioned session.
Only provider input attachment IDs cross the room-message API. Room documents
never contain attachment metadata or bytes. Existing session cleanup rules
remain authoritative.

## Runtime controls

Group controls follow single-session behavior while membership stays independent:

- Each submitted message carries a browser `clientMessageId`. The room persists
  that ID and a request hash before dispatching any member. Retrying the same
  request returns its accepted state without creating another entry or turn;
  reusing an ID with different content is rejected. The browser retains the
  message and ID after an uncertain network result until acceptance is confirmed.
  If every mentioned member rejects dispatch, the response rejects the send and
  the editor keeps its draft. An explicit corrected retry receives a new ID.
  Enter inserts a new line and Shift+Enter sends; disconnected or running groups
  retain the draft and reject keyboard sends just like the disabled send button.
- Group views, the lobby and desktop tiles subscribe to `/ws/rooms`. Bounded
  event streams push member messages, approvals, state, timers and completions.
  Updates are coalesced and carry snapshot revisions so delayed HTTP responses
  cannot replace newer state. Reconnecting starts with a complete snapshot.
- Stop interrupts all running members. During Resume/Fork it also cancels the
  recovery context and any newly created member providers. Cancellation leaves
  the current runtime group bound to its previous history.
- Root-turn completions increment a runtime completion revision. Child turns and
  repeated completions do not increment it. A visible group or tile acknowledges
  the revision; an older acknowledgement cannot clear a newer completion.
- Saved history is listed in metadata-only pages, sorted by creation or update
  time. The default page contains 20 groups; transcript projection is requested
  only when previewing or connecting.
- Scheduled text messages snapshot the selected member IDs and quoted entry IDs.
  Timers support creation, editing, deletion, countdowns and failure reporting.
  Timer revisions prevent replaced or deleted tasks from sending. Like session
  timers, group timers belong to the running daemon and are cancelled when the
  group closes or the daemon stops. Attachments use immediate sends.
- Desktop groups share the tiled workspace with sessions, including live,
  read-only previews and a focused group editor. Group tiles do not participate
  in drag reordering.

## Supervisors and selection

SessionControl checks readiness per target and serializes accepted inputs. Other
members running do not block sends to an idle member; plain group notes can be
saved without dispatch. Members → Controls provides current output, paginated
history, interruption, and the next prompt.

Supervisors bind a saved room and stable members to a scheduled executor. A
persisted runOnce flag queues a single check without enabling recurring work.
Pause cancels future checks; Stop run preserves the monitoring switch and waits
for provider settlement. The interval starts after the supervisor's own invocation
settles. Updating a prompt preserves nextAt; changing the interval recalculates it.

The daemon injects Glad MCP into provider processes. Session credentials and the
current invocation authorize each call against current membership and per-target
permissions. Versioned top-level envelopes preserve invocation provenance in native
history and Codex capacity retries. Internal checks are hidden from group
projection; commands remain visible with their supervisor author. Successful
automated completions do not mark session or group unread or send routine
completion notifications. These permissions constrain the Supervisor channel,
not a session's pre-existing shell or network access.

Supervisor schema 2 configurations reside in ~/.glad/supervisors/<task-id>.json.
Audit events append to task-specific JSONL logs with bounded rotation. Startup
pauses tasks, repairs incomplete audit tails, and reports unreadable or future
configuration files while retaining their originals. List, configuration, history,
and invocation-detail HTTP endpoints are separate; list responses include serverNow
for browser countdown calibration.

Message references use long-press selection and a left gutter in the focused group.
Cancel and Preview replace the header controls while selecting. Empty selection
keeps the mode open; running replies cannot be selected. Reference IDs and native
history ownership are unchanged; read-only tiles do not expose selection controls.
