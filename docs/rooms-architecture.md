# Glad group-chat architecture

Group chat is a lightweight, durable index over independent provider sessions.
Its timeline is a dynamic read model over provider-native history, not another
copy of Codex or Claude history.

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
- whether a newly-created empty room is still a disposable draft.

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

- Entry ordering uses persisted sequence numbers, never timestamps.
- Member display names are not unique; member IDs are.
- Removing a member is a soft delete so historical authorship survives.
- Runtime session IDs are replaceable hints. Native conversation IDs are the
  durable resume/fork identity.
- New fields must be optional within a schema version. A breaking semantic or
  representation change requires a schema migration.
- Room deletion never deletes sessions or provider-native history.
- Group ServerChan notification preferences are persisted on `RoomRecord` and
  evaluated independently from every member Session's notification switch.
- Opening a room automatically recreates missing runtime sessions from each
  member's durable provider conversation ID.
- Room resume and fork match the single-session semantics: member and room IDs
  stay stable while each provider conversation is resumed or forked and the
  live session switches to it. Provider-side forks cannot be rolled back
  transactionally, so per-member failures are reported and left unchanged.
- A newly created empty room is a draft. Adding a member, renaming it, or
  sending a message makes it durable; leaving an untouched draft deletes it.

## Attachments

The browser uploads a selected file independently to every mentioned session.
Only provider input attachment IDs cross the room-message API. Room documents
never contain attachment metadata or bytes. Existing session cleanup rules
remain authoritative.
