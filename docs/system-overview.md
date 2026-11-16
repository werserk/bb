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

### Plugin candidate disposal

Failed or timed-out factories retain the previous running instance. The rejected
candidate's API is invalidated before cleanup waits, preventing late factory
continuations from registering more resources through that API. Registered dispose
hooks are invoked in reverse order and awaited together for at most the service
stop timeout (5 seconds by default); failures are logged without skipping other
hooks, and owned databases are then closed. A cleanup timeout reports that work
may still be running. JavaScript promises and synchronous blocking code cannot be
cancelled by this mechanism; plugins remain responsible for direct external work.
Candidate attention-policy writes are staged until activation so discarded
candidates cannot clear the previous instance's policies.

### Queue readiness scheduling

The server coalesces concurrent queue-readiness wakes per thread with
`createAsyncRerunner` in `lifecycle-dedupers.ts`. A wake received during an
in-flight drain schedules a fresh pass after it settles instead of joining and
losing the new readiness signal. Queue claims and dispatch admission remain the
authority for exactly-once delivery, manual-stop pauses and plugin waits.
Answer acceptance and native idle transitions request this same drain; the
existing periodic idle recovery remains a fallback for missed process-local
signals. Idle service drains and idle discovery share the admission rule
that any ordinary queued row takes priority, including an exhausted failure
and a claimed row; these blocked service rows remain untouched. By-id readiness
wakes still run admission and convert a cleared plugin or host wait into an
idle-drainable thread-busy wait when ordinary work blocks delivery. This keeps
one-shot readiness signals effective after the blocker leaves. Native queue
removal requests a readiness wake immediately. A claim carries its pre-claim
public wait facts only in memory, so requeueing to the same state, wait and
schedule does not emit `message.queued`; creation and changed waits still do.
This prevents bookkeeping retries from driving project-state rebuilds without
changing message priority, queue storage or public contracts.



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
`turn_not_steerable` under daemon protocol 260; it does not start another run.
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

### Questions in chat

`packages/domain/src/conversation-questions.ts` owns ordinary question publication,
explicit answers, immutable material manifests and the exact inline marker parser.
`conversation_questions` stores publications independently of provider callbacks.
`apps/server/src/services/threads/conversation-questions.ts` is the common service
for the injected `bb_ask_question` tool, HTTP, SDK and CLI. Publication snapshots
all declared files before committing the question and its assistant-message marker
in one transaction. A source turn/call identifies retries; changed content under
the same source conflicts. Fresh publication requires a live source turn.

`question-materials.ts` uses existing rooted host read/write primitives, verifies
content hashes, and records snapshot transport revisions separately. The manifest
retains the original host and storage root. The scoped question-file route serves
only declared snapshots, checks revision/size before streaming, and supports range
requests. HTML dependencies retain their relative paths. Missing or changing files
prevent publication; preview loading remains a separate observable outcome.

Answer acceptance normalizes explicit choices and atomically writes the response
and a `questionResponse` row into the existing queue. Identical retries return the
same receipt; conflicting answers fail. The original publication and manifest
travel with the response. Accepted queue content cannot be edited or grouped with
ordinary messages. Final queue consumption rechecks question ownership, revision,
withdrawal and thread eligibility inside the dispatch transaction. It records
submission time with consumption; submission does not assert model consumption.
Held/removed responses remain distinguishable from submitted responses.

`question_resolution_events` adds immutable accepted actor/reason/answer snapshots
without rewriting legacy cards. Local HTTP/UI/CLI actions are explicitly
`local-unverified`; claimed client thread identities cannot supply runtime
attribution. Native `bb_resolve_question` uses a live source turn and the common
answer/withdraw transactions, binding retries to the actor and normalized operation content.
The scope service runs the acceptance callback synchronously while its current
policy grant is held. Scope also gates target reads, revision conflicts and
answer-validation errors before asynchronous execution preparation; acceptance
rechecks fresh caller liveness/project after that preparation. An
absent managed policy permits self only. Withdrawal atomically appends a separate
resolution-bound cancellation queue row without changing an accepted answer's
custody. Consuming either native row records its submission receipt in the same
transaction as the turn request; it does not claim model consumption. The app
joins accepted history before showing trusted attribution, keeps old snapshots
readable without invented authors, and displays closure separately from delivery.
The response renderer verifies and unwraps the existing inter-thread envelope;
claimed qst drains preserve self agent provenance through checkpoint and final send.
Timeline projection does not recover agent attribution from a user-pasted typed
resolution envelope. Legacy ordinary inter-thread envelope recovery is unchanged.
Recorded actor links use the native thread query; a confirmed 404 removes navigation
without rewriting frozen identity, while read failures do not imply deletion.
Both pint agent actions return unsupported without changing their original local
controls. Native tools, the backend SDK resolver and local SDK/HTTP/CLI routes
share the resolver. Only a live native invocation carries verified agent identity.
The host stages the managed scope policy until plugin activation and revokes it
on disposal or failed loading. `experimental_questionResolution?.version === 1`
binds the qst actions to the existing complete-open read and notification contract.
Thread subscriptions can use `experimental_onReady` to confirm server registration
through existing ordered ping/pong before certifying a read; reconnect repeats
the barrier. No new event or provider wire arm is required. Exact-pair acceptance
remains incomplete; these primitives are not full-path release evidence.
A fresh durable answer can use the existing claimed `auto` dispatch while a turn
is active; that path carries the existing `expectedTurnId` and all dispatch
policy, interaction, compaction, host and manual-stop guards. Only the claimed response sets optional
`turn.submit.injectOnly`; legacy/system/agent/plugin commands omit it and retain
their previous behavior. The daemon defaults omission to false. The adapter exposes
the negotiated bridge `steerMode`; a non-inject mode returns the existing busy
result before a provider command or cancellation, reusing refused-steer recovery.
Explicit user steer retains its existing queue/cancel behavior. Only a claimed
question response adds optional typed `questionResponse` identity to its stored
`client/turn/requested` event. Provider refusal (`turn_not_steerable`), stale
turn rejection or a first/repeated `competing_turn` restores a `questionResponse` queue row and relinks the card while
clearing its submission receipt in the same rejection transaction. Recovery uses
that typed history identity, never the rendered answer text. The native rejection
event links the replacement queue ID to its source request; later wakes wait for
the current turn to end instead of repeating the refused inject. The fallback
card reads `Queued · will be sent after this turn`. Existing runtimes ignore the
additive history field and can consume the unchanged question-response queue
payload after rollback, preserving the native card receipt. A response withdrawn
before refusal is settled without requeueing; the false submission receipt is
cleared and the active turn remains live. No database column or SDK/CLI changes.

Internal host protocol 260 adds optional `turn.submit.injectOnly`, set only from
claimed response identity. Protocol259 is rejected before dispatch; the existing
protocol mismatch/self-update path installs the matching daemon and reconnects.
Old commands without the marker parse unchanged on the new daemon, while old
strict parsers reject marked commands and therefore must update before receiving
them. This wire change does not add persisted history fields beyond questionResponse.

The app replaces only a complete marker message with `ConversationQuestionCard`.
The shared thread-view grouping rule keeps that message outside completed work
summaries. Cards reuse the question form without composer focus or global keyboard
ownership. Body and materials precede answer controls; answer/dismiss changes are
read through the same SDK path. Existing interaction-change notifications invalidate
question data. Multiple cards do not create a provider wait or gate ordinary chat.

`toThreadStatusThread` normalizes open persistent questions into owner attention.
`toPluginSidebarThread` keeps raw native interaction state and the derived
indicator as separate facts. The common SDK thread-status resolver accepts the
optional existing indicator and retains its `waiting-for-input` attention when
individual plugin rows or collapsed groups resolve the DTO again. Unread errors
keep their higher priority; other indicators are recomputed from the input facts.
This preserves question attention without redefining the native interaction field.

Claude aliases native AskUserQuestion to the injected common tool and excludes the
native tool only when the common tool is present. Codex native question calls receive
an explicit redirect in those sessions; no answer or permission is manufactured.
Already pending native interactions, command approvals and generic plugin secret
forms retain their existing lifecycle. Their composer remains available; cancelling
an old native question still uses the old stop-turn action. Completed reasoning
uses the assistant renderer for already-emitted material, but cannot supply files
that were never published.

### Persistent question publication budget

New `bb_ask_question` cards, HTTP/SDK publication and CLI publication use one
policy in `packages/domain/src/conversation-question-limits.ts`. The server
publication service enforces it before material snapshots, persistence and
notifications; the CLI uses the same publication parser before outgoing requests.
Stored question decoding remains separate and permissive so old large cards
remain readable and answerable without migration.

The authored text total is 1,000 Unicode code points: body 400, each prompt 200,
header 48, option label 80, description 120 and material label 80. Russian letters
and astral emoji count one; joined emoji count their constituent code points.
The total includes every question, option and material label; metadata IDs/values
have a separate 128 cap. Existing collection maxima remain 10 questions, 4 options,
20 materials and 100 dependencies per material. Excess returns one actual/limit
error directing the agent to shorten the question and put the full report in
materials. Material file content stays outside this prose budget.
Frozen material previews are closed initially and fetched only after Open;
closing a preview removes its content while retaining download access. No truncation
or answer selection occurs.

### Combined local answer delivery custody

`classifyLocalQuestionAnswer` in the DB question module is the shared singleton
verdict for active queue eligibility, the idle provider fast-path bypass, manual
Send now dispatch identity, the consumption transaction recheck, and refusal
recovery. It joins typed queue identity with the current question revision and
queue ID and the resolution event's action, actor and delivery ID. Text and null
sender never establish authority. The local actor remains unverified. Dispatch
rechecks the verdict after asynchronous preparation, before consuming rows; the
same admitted identity supplies stored history and the daemon injection marker.
Agent answers and every owed withdrawal retain legacy routing, including active
main-run-idle delivery, their original sender, groups and one existing envelope.

Refusal recovery CAS updates question custody and the exact answer audit delivery
ID, attribution delivery ID and both submission receipts in one transaction. It
preserves operation/event/principal/request identity; fresh SDK/backend reads and
operation replay follow mutable delivery custody, so a cached old delivery ID may
change. Inconsistent receipts abort. Obsolete submitted answers after withdrawal
clear only their answer submission receipt and retain a removed old-ID tombstone;
the distinct withdrawal event and queue remain owed. No schema or SDK repin is
introduced. Existing idle/start/reprovision and bounded recovery limitations remain;
queue submission is not evidence of model consumption. Protocol 260 rollback needs
matching old server and daemon, and installed acceptance is an integrator gate.

### Reading pane scrolling

`packages/shared-ui/src/components/ui/scroll-area.tsx` retains Radix native viewport
ownership for overlay scrolling. The app-local `reading-scroll-area.tsx` bridges
that existing internal primitive into sidebar, bottom-anchored chat and secondary
reading slots without a new package or SDK export. `app.css` owns hover/focus/drag
visibility and the 4px painted / 8px interactive scrollbar metric; fine vertical
resize metrics live in `panelTransitionTokens.ts` and `SidebarChrome.tsx`. The
panel target follows the divider's left edge so 0px and 1px seams keep the same
scrollbar adjacency; coarse targets remain centered. Window pointerup/cancel
clears the shared primitive's drag visibility when capture was never acquired. This
removes the old reserved gutter and scroll-activity visibility timer. Terminal,
iframe, CSV and code viewports keep their specialized scroll ownership; Markdown
file preview uses the common primitive at its existing scroll-owner boundary.

ReadingScrollArea opts into that overlay policy; other shared ScrollArea consumers
retain their previous defaults. The internal FilePreviewHostScrollContext shares
existing host-slot ownership with FilePreview so a Markdown preview does not add
a second viewport when its host already owns scrolling.

### Prepared thread plan reads

Canonical `readThreadPlan` keeps its per-thread SQLite transaction and fresh
projection. Event revision, context-clear boundaries, bounded plan history,
plan staleness and open-question summary queries reuse `prepareCachedQuery`'s
connection-scoped statements with bound values. The queue-count singleton and
pending/resolving interaction selectors use the same mechanism; general batch
queue reads and other interaction status sets retain their existing paths.
No plan result is cached, and no schema, public API or plugin change is required.

The synthetic microbenchmark is `apps/server/scripts/benchmark-thread-plans.mjs`:
run `node --conditions=source --import tsx apps/server/scripts/benchmark-thread-plans.mjs`
after the server dependency build. It creates a migrated in-memory database with
1400 idle threads, 15,120 completed snapshots, eight steps per snapshot and no
pending interactions, performs five warmups and 30 measured passes through the
server reader, and reports nearest-rank p50/p95 plus a projection checksum.
Each pass refuses load1 >=16. It measures plan reading only, not the complete
WProjects project-state build or HTTP/SDK overhead.

### Next-message suggestions

Prompt Suggestion (`plugins/prompt-suggestion`, formerly Autosay) owns bounded conversation selection, explicit connected-model selection and tool-free inference through the shared AI-generation API. The app host supplies a current root-turn/context snapshot independent of timeline presentation, and the SDK composer controller keeps a candidate outside the persisted draft. The shipped Composer renders the candidate through the existing placeholder decoration. Tab accepts into the draft; plain Enter or the native Send button accepts and immediately uses the ordinary host submission path. Both retain snapshot and submission guards. Eligibility fails closed on input, queue, questions, connection/focus changes or unsupported renderers. Runtime requests/counters are memory-only; no transcript corpus or daemon/schema change is introduced.

### Shared AI generation

The existing AI-service registry also exposes experimental model discovery and text generation. The SDK's shared dispatcher validates model/host/profile identity, requested capabilities, cancellation, concurrency and bounded input/output. Provider plugins advertise only their own invocable catalog and keep credentials on the execution host. Native title/commit generation shares dispatch admission while retaining legacy task selection and answer cleaning outside the explicit-model API. Explicit model requests never enter automatic service/model fallback.

AI Gateway is an optional plugin over that API, with GET models and non-streaming text Chat Completions under its native plugin HTTP base. Core validates its ordinary per-plugin token, including Bearer authorization. No second listener or credential store exists. Unsupported tools, nontext content, streaming and generation controls are rejected before provider execution. Prompt Suggestion calls the native API directly and receives no provider credentials. No new transcript store is created.
