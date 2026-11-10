# System Overview

## The runtime pieces

| Component       | Role                                                                                                                                                                                                                                                                                                            |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Server**      | Central hub. Stores all state in a SQLite database, exposes an HTTP API, and pushes change notifications over WebSocket. Stateless itself; the DB is the source of truth. Routes work to hosts over the active daemon WebSocket.                                                                                |
| **Host daemon** | Runs on each enrolled execution machine. Connects to the server, handles host RPC requests, provisions workspaces, runs agent provider processes, and posts events back. Exposes a local HTTP API for co-located app and CLI operations such as opening an editor, picking folders, and checking daemon status. |
| **App**         | Web UI for inspecting projects and threads, following progress, and steering work.                                                                                                                                                                                                                              |
| **CLI** (`bb`)  | First-class interface for both users and agents. Same capabilities as the app, scriptable.                                                                                                                                                                                                                      |

## Data model

The core entities and how they relate:

**Project**: the top-level container, usually mapped to a repository. A project has one or more **sources** that say where its code lives. Each local-path source belongs to a specific enrolled host, so one project can map to paths on multiple machines.

**Thread**: the unit of work. Each thread tracks a conversation with an agent provider, has lifecycle state, and produces an append-only stream of **events** (messages, tool calls, file changes, etc.). Threads can be **standard** (does work directly) or **manager** (coordinates other threads). Threads can own child threads for delegation.

**Environment**: the execution context for a thread. It binds a workspace (a directory on disk) to a host. An environment can be **unmanaged** (point at an existing directory), or **managed**. Environments managed by bb will be cleaned up when there are no longer any unarchived threads using it. Multiple threads can share an environment.

**Host**: a long-lived daemon identity for a machine that runs work. A server runs on one host (the server machine, `primaryHostId` in the API) and can enroll additional remote hosts; project sources and environments retain the host boundary.

**Commands and events**: the server talks to daemons over the active daemon WebSocket with host RPC requests. Lifecycle work such as provisioning an environment, starting a thread, or stopping a thread can run asynchronously from the API caller's perspective, and the server settles command side effects when the daemon returns an RPC result. Daemons separately post provider and thread progress as event batches.

## Contracts and boundaries

### Thread lifecycle ownership

`lifecycleOwnerThreadId` is an optional relationship set only at creation and
never changed. It is independent of sidebar `parentThreadId`, fork
`sourceThreadId`, visibility, and attribution. Spawn and fork accept a live
owner across projects, hosts, and environments. Side chats are owned by their
source, and every workflow worker attempt by its origin.

- Archiving an owner recursively archives its dependents and stops their
  execution; unarchiving the owner does not restore them (restore them
  explicitly, owner first).
- Deleting a thread recursively deletes its sidebar children and lifecycle
  dependents, following both relationships at every level, including hidden and
  archived threads. Fork sources alone do not imply deletion. The owner row
  remains until every lifecycle dependent finishes storage cleanup on its own
  host; failures are retried.
- Dependents can be archived or deleted independently of their owner. Deleting
  an owning project also deletes cross-project dependents; deleting only a
  dependent's project leaves its external owner intact.
- Stop affects only the requested turn or runtime.

An archived thread keeps its terminals and any running turn for a short grace
period (`ARCHIVE_UNDO_GRACE_MS`) so Undo restores it intact; after that bb stops
it. During the grace it still counts as live, so its environment and machine
are not retired under it. A thread start still in flight is stopped as soon as
it is archived.

### Queued child notifications

Child outcome notices carry optional render snapshots in the existing
`system_notice` JSON. The server captures the child label, output, workflow
count and failure/interruption context before queueing; captured output is
trimmed and bounded to 4000 characters. At drain it filters snapshots against
each child's current parent and notification policy. If all survive, the
stored content is delivered unchanged, including edits. Otherwise it uses
the flush builder for both text and taxonomy. One survivor becomes a
single-child notice; no survivors consumes the row without delivery. This
preserves the captured outcome even if the child has since run another turn.
Legacy rows without snapshots keep the all-or-nothing policy check and log
that fallback at debug level for outcome notices. Needs-attention notices use
their subject directly without a missing-snapshots log. The SQL schema and daemon
protocol are unchanged.

The server caches plugin agent selections and skill roots per thread; see the
[`configure` contract](../packages/plugin-sdk/src/backend-contract.ts).

### Transport contracts

Two contract packages define the boundaries between components:

**`@bb/server-contract`**: the HTTP + WebSocket API between clients (app, CLI) and the server. Route schemas, request/response types, WebSocket notification types.

**`@bb/host-daemon-contract`**: the protocol between the server and host daemons. Command types, event types, session lifecycle, the local API for app/CLI.

Implementation packages never import across these boundaries. The server doesn't know how workspaces are provisioned. The daemon doesn't know about threads or projects beyond what commands tell it.

### Local file viewer

The app registers `core/local-file-viewer` at startup in `apps/app/src/main.tsx`.
Embedded file links use the shared modal host, with a validated JSON file target.
The modal reuses the secondary-panel preview and embeds `PluginThreadChat` for
thread-storage files; workspace files stay alone because cached thread lists do
not prove unique environment membership. Compact layouts retain both panes behind
Artifact and Chat tabs. Thread-storage PDFs use the existing preview query update
timestamp to reload their blob after realtime invalidation.

### Service turn presentation

The server dispatch checkpoint honors owner send modes during service turns;
agent and system senders retain forced queue isolation. The host uses its existing
provider steer path; queue remains a native queued message. Upstream idle-main-run
delivery into turns held open by background agents is unchanged. The thread-view service projection hides service inputs
and replies, preserves owner input including pending steers, and exposes unfinished
service work as normal work rows alongside a native pending turn timer (with the
original start time, bounded to the current root turn; nested agent turns do not
add timers). The timeline omits the
extra Working indicator while a pending turn timer exists and suppresses service
reasoning text. After an owner steer, active owner thinking remains visible
alongside the timer. In-flight reasoning whose item started in the hidden
service range stays hidden across an owner steer, including after acceptance.
Completed service history stays hidden; owner replies after a steer stay visible.

### Deferred owner steers

A provider `turnBusy` rejection keeps the active turn alive. The host reports
`turn_not_steerable` under daemon protocol 259; it does not start another run.
Server settlement fences accepted/rejected request IDs, then atomically transfers
an eligible owner request into a native `deferredSteer` queue row and records the
rejection's `deferredToQueuedMessageId`. This linkage hides the failed-copy
presentation while the native queue owns delivery.

`services/threads/deferred-steer.ts` resolves the immutable source request for both
queue drains, including reprovision. The source stores admitted provenance,
groups, visibility and execution; drains preserve owner authority and avoid
re-expansion, sticky override changes and duplicate prompt history. The queue row
uses the existing source-request column with a separate payload discriminator;
retry detection excludes it, and request-suffix edits cancel both referenced kinds.
Manual stop still pauses automatic delivery. Periodic idle recovery supplies the
wake if post-commit work was interrupted.

A deferred dispatch that the daemon refuses with `competing_turn` before input
acceptance returns to durable queue custody in the same settlement transaction.
Only a server-linked deferred request whose owner provenance, ordered input/groups
and execution match its original eligible source qualifies. It keeps that source
reference, records the rejection's new queue link, and waits for the current turn
without an immediate retry. Accepted/rejected request fences also cover this
transfer. Ordinary competing starts retain their existing failure behavior. This
does not repair review lifecycle-ID mismatches; when such a mismatch leaves a
stale active turn, the queued input remains visible until stop or completion
allows it to drain.

Only explicit review/compact refusals of proven owner inputs qualify. Ordinary
review turn-ID mismatches, automatic compaction, permission-changing provider
branches, non-owner inputs and legacy in-flight requests without provenance are
outside this recovery. Persisted JSON and public union types change without a SQL
migration. A .68 downgrade with deferred rows is prohibited; release must prove
remaining-history compatibility or require the stopped pre-upgrade snapshot.

### Pending questions in chat

Pending input keeps the normal composer visible. Owner sends use the existing
durable queue and do not resolve questions or approve actions. In-flow native
questions offer Cancel through the existing stop-turn action; cancellation errors
remain visible and retryable. Pending native questions and plugin forms keep
their background segment visible. Completed reasoning details use the assistant
message renderer with their original row/thread/turn and workspace context, so
already-emitted links, images, directives and code-fence previews remain usable.
This rendering cannot supply material the provider has not emitted.
