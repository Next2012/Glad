# Glad group-chat architecture

Group chat is a lightweight, durable index over independent provider sessions.
It is not another copy of Codex or Claude history.

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

Version 1 persists:

- room metadata and monotonic `nextSequence`;
- stable member identity and avatar seed;
- enough provider configuration to recreate a session;
- native conversation and turn locators;
- user-authored room text, mentions, and quoted entry IDs;
- dispatch status and a small error string.

It does not persist assistant response text, tool data, reasoning, or
attachments.

## Message lifecycle

1. Persist the user entry and one pending entry for each mentioned member.
2. Resolve quoted entries from current session/native history.
3. Build private `AgentText` containing only the explicit references and the
   new group message. Public `Text` remains the user's new message.
4. Dispatch to all mentioned sessions concurrently.
5. Bind each pending entry to its provider conversation/turn.
6. On root turn completion, persist status and the stable native locator.
7. On room reads, resolve the final top-level assistant message in memory.

Turns started from the full mini-session are indexed too. The event subscriber
adds the direct user turn and a reply source entry to every room where that
session is currently an active member. A read-time reconciliation pass covers
subscriber overflow without importing turns created before the member joined.

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

## Attachments

The browser uploads a selected file independently to every mentioned session.
Only provider input attachment IDs cross the room-message API. Room documents
never contain attachment metadata or bytes. Existing session cleanup rules
remain authoritative.
