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

### Persistent question decision policy

New ordinary HTTP/UI/public SDK/CLI answers and withdrawals serialize canonical
v2 question notices with explicit local-input parity: the scoped decision has
the same standing as typed chat. Identity remains `local-unverified`; this is
not authenticated ownership and does not bypass command approvals. Native
agent tools and `bb.experimental_questionResolution.resolve` closures retain v1
non-permission notices, including context-free/deferred plugin calls. A plugin
using the public HTTP client `bb.sdk.threads.questions` instead follows the same
local-input policy as CLI and raw HTTP; this soft boundary does not establish
human identity. Server entry points bind origin internally;
null invocation and request payloads cannot select parity. Unknown internal
origins default to v1. The common acceptance services receive origin separately
from the optional operation call, preserving legacy card retry semantics.

Notice parsing accepts canonical v1/v2 while preserving trusted row sender and
initiator checks. UI policy labels derive from explicit v2 notices, never old
local attribution. Receipt replay returns the original queued bytes and IDs;
upgrade does not relabel prior history or queued v1 input. Actor/SQL/public SDK
and daemon wire contracts remain unchanged. Old readers display v2 as ordinary
user text; exact-pair delivery/reader acceptance is required before integration.

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
that an ordinary queued row which will dispatch by itself takes priority:
one that is queued, scheduled, waiting, has a retry booked
(`failed_retrying`) or is claimed; these blocked service rows remain
untouched. Two kinds of row that only the user can move are not blockers,
because yielding to them held the service turn until the user sent or
deleted the row: an exhausted failure (`failed_exhausted`), which is never
claimed automatically again, and a Not sent (`superseded`) retry, which rests
in `waiting` on a wait nothing clears. A row waiting on `provisioning` is not
a blocker either: on a thread with no environment only its first dispatch
ends that wait, and on a pending plugin thread that dispatch is the queued
service turn (yielding to it left a replaced WProjects coordinator pending
forever). On a thread already provisioning the service turn waits on the
same condition, and readiness clears every provisioning wait before rows are
retried, so ordinary rows still go first. By-id readiness wakes still run
admission and convert a cleared plugin or host wait into an idle-drainable
thread-busy wait when ordinary work blocks delivery. This keeps
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
Ordinary supported native, semantic, embedded and contextual document activations
share `artifact-activation.ts` through the current `useLocalFileLinkOpener` and
semantic navigation paths; imperative calls remain panel intents unless they
carry the versioned restrictive artifact option. The existing modal supports
workspace, actual owning-thread storage and host targets; only storage attaches a
chat. In the native workspace, storage and host Markdown body an ordinary relative link
resolves from the document's own directory inside its namespace and replaces the same
popup with the linked file (owning thread and context follow). A host document stays on
its actual host and is contained to its own directory, so a link above that directory is
unavailable. The rendered anchor keeps its authored href. Modified clicks, line ranges, editor targets and
non-artifact files keep the plain anchor; an ordinary click on an artifact link that
cannot resolve shows the existing "Can't open this file here" toast with Copy path.
Fixed-tab and retained-host navigation are unchanged.

Markdown and absolute-path attachment leaves carry ephemeral ordinary-activation
metadata through the existing message and embedded ThreadChat callbacks. The
shared `file-activation.ts` predicate preserves modifier, button, Download and
prevented-event dispatch; absent metadata retains baseline programmatic behavior.
Explicit editor links retain native editor or embedded viewer fallback. Native
host PDFs use the existing host content URL and PDF blob frame, without a lease
or attached chat.

Native popup bodies reuse the existing rooted file routes, limits and dot assets.
Caller-scoped bodies use `ScopedArtifactBody`: an exact workspace/storage descriptor
or absolute host root requests `artifact-v1` with the original authoritative
`expectedSource {hostId,canonicalReadRoot}`. Both fields are required together;
the acknowledgement pins and echoes the expectation, rather than attesting the
current filesystem. Core checks that exact acknowledgement before consuming a URL.
Each application-controlled initial/Refresh/Retry/refetch/remount/nested attempt
re-admits its exact candidate, slash-relative path, root and original physical
source through the live consumer revalidation callback. Primary PDF/image renderer GET belongs
to that admitted attempt; subsequent browser reads and Download may reuse its
strict lease until expiry (default ten minutes). Membership removal, project
disable and logical source rebinding do not immediately revoke that lease.

`artifact-admission.ts` owns the 10,000 ms admission deadline, races callbacks
that ignore cancellation and never claims to cancel underlying consumer work.
Existing modal tokens bind private records outside JSON/public modal props;
queued replacement/close/Back/unbind/caller abort retire custody. Dead scoped
history is stripped; native Forward is unchanged. Query generations discard late
bytes. Unsuccessful admission creates no lease/fetch. After positive admission a
root mismatch may leave an unused TTL lease but returns zero substituted bytes.
A stale descriptor still resolving original physical A may read A after a logical
rebind to B; continuous database freshness is not promised.

Every strict metadata/chunk carries `artifactPolicy` and `expectedCanonicalRoot`.
The daemon validates the original canonical root before open, after open and
post-read before returning bytes, comparing the file with its canonical-root
relative path. Ancestor aliases reaching the same canonical root work; root and
inside-root symlinks, denied names, inode replacement and strict fstat caps refuse.
Protocol 267 rejects older daemon wire semantics; native/legacy payloads stay
unchanged. No queue/session schema or persistent metadata is added.

Scoped HTML reads bounded original bytes once with `redirect:"error"`, decodes
BOM-first (UTF-16LE/BE or UTF-8; otherwise the route's forced UTF-8), then renders
`ScopedHtmlFrame`: an opaque static outer srcdoc guard around escaped inner srcdoc.
The shared `@bb/domain/artifact-preview` CSP forbids document-frame network loads
and limits scripts/styles/images to the lease (plus inline scripts/styles/data
images). Same-document fragments retain hash/scroll; other document links stay
inert with a persistent note. Script/meta attempts can replace the inner document
with an error page. Strict routes emit no 3xx; injected proxy/asset redirects are
outside that guarantee because CSP paths alone do not constrain redirect targets.
Fonts/media stay unsupported. UTF-16 document.characterSet differs after decoding;
text/title/script output parity is checked only in Chromium, not all engines.
The host reader tests pin the denial fixture digest in
`packages/host-daemon-contract/fixtures/artifact-denied.json`. Consumers must
supply their own admission callback; this core capability does not install or
change a Library consumer.

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

Prompt Suggestion (`plugins/prompt-suggestion`, formerly Autosay) owns bounded conversation selection, explicit connected-model selection and tool-free inference through the shared AI-generation API. The app host supplies a current root-turn/context snapshot independent of timeline presentation, and the SDK composer controller keeps a candidate outside the persisted draft. The shipped Composer renders the candidate through the existing placeholder decoration. Tab accepts into the draft; plain Enter or the native Send button accepts and immediately uses the ordinary host submission path. Both retain snapshot and submission guards. Eligibility fails closed on input, queue, command/permission approvals, connection/focus changes or unsupported renderers. Open conversation questions do not block generation or display; their status is not a suggestion admission dependency. Runtime requests/counters are memory-only; no transcript corpus or daemon/schema change is introduced.

### Shared AI generation

The existing AI-service registry also exposes experimental model discovery and text generation. The SDK's shared dispatcher validates model/host/profile identity, requested capabilities, cancellation, concurrency and bounded input/output. Provider plugins advertise only their own invocable catalog and keep credentials on the execution host. Native title/commit generation shares dispatch admission while retaining legacy task selection and answer cleaning outside the explicit-model API. Explicit model requests never enter automatic service/model fallback. Reasoning and processing-speed capabilities come from each native catalog; requested Fast is translated by the provider, while the result reports only the tier actually returned upstream. Codex generation reads its raw catalog separately from agent-picker normalization and retains fresh route and authorization checks.

AI Gateway is an optional plugin over that API, with GET models and non-streaming text Chat Completions under its native plugin HTTP base. Core validates its ordinary per-plugin token, including Bearer authorization. No second listener or credential store exists. Unsupported tools, nontext content, streaming and generation controls are rejected before provider execution. Prompt Suggestion calls the native API directly and receives no provider credentials. No new transcript store is created.

### Suggestion request visibility

Prompt Suggestion reports its scoped RPC lifecycle through the shared suggestion controller. Pending/error changes preserve composer snapshot identity so rendering cannot restart inference. Core Composer renders a loading placeholder and spinner, clears it on none/cancellation, and exposes failure/timeout details without blocking input. Request IDs and snapshots prevent stale completions from replacing a newer state. Settings show enabled status, model, reasoning and requested speed; requested speed is not proof of upstream service tier.

### Goal-oriented Prompt Suggestion

The server plugin owns preparation, a bounded foreground-interest cache, a foreground inference queue, an independent post-completion memory lane and one shared process-local one-hour admission ledger. UI, CLI and RPC use that coordinator; browser focus does not own leased background generation. Native lifecycle events wake authoritative eligibility reads, and tagged RPC invalidation delivers state without polling. Foreground generation returns only a short suggestion/none. After settlement, a separately admitted memory request refreshes source-linked task state, visible only through inspect. Memory never blocks the foreground promise, reserves the final hourly request for foreground work, and cancels on new demand or invalidated context. Both roles use the same model/effort/tier and full owner instructions; role-specific contracts and output caps differ. No permanent agent or transcript database is added. Thread history remains authoritative, explicit context resets invalidate memory, and unknown goal context stays incomplete.

Owner principles come from the same raw instruction reader as core thread composition. Instruction/configuration revisions and source snapshots fence generation and delivery. The native composer still owns editable Tab acceptance and ordinary Enter/Send. Explicit dismissal causes distinguish a user decision from focus cleanup. There is no new atomic server context predicate at Send; this version promises fresh delivery checks and the existing local snapshot fence.

Prompt Helper reuses this coordinator and shared AI dispatcher for explicit draft assistance. Its toolbar action opens an `experimental_inlinePanels` contribution inside the native composer; one mount-scoped suspension lease pauses automatic ghost suggestions. The helper treats the captured draft as an unsent proposal, preserves protected mention tokens, and returns primary text plus separate optional advice. It uses full owner instructions and source-linked task memory without writing the draft into that memory. A shared hourly admission ledger counts helper requests even when automatic suggestions are disabled. Immutable draft identity and mounted composer scope fence edits locally; server semantic context revisions fence generation and explicit application. Core and plugins share the same composer replacement adapter. No submission is performed, and attachments stay owned by the composer. See [the implementation plan](superpowers/plans/2026-11-17-prompt-helper-implementation.md) for the accepted scope and verification.

Pi performs provider translation and credential access on the host. Generic session affinity and exact reasoning are capability-checked in the shared dispatcher; OpenRouter latency routing belongs to Pi's server-side native-generation settings and is translated on the host. Host protocol 269 includes those options, capabilities and applied-routing receipt, plus the ACP plugin's direct OpenRouter host commands. AI Gateway and Prompt Suggestion use the same native generation path; neither stores provider keys.

The ACP plugin also owns `opencode-openrouter`, a stateless shared text service.
Its server registration selects lowest-latency routing and exposes exact model
identity to both AI Gateway and Prompt Suggestion through the common dispatcher.
The host alone exports the existing OpenCode OpenRouter key, validates a single
active credential, and calls fixed OpenRouter endpoints with redirects disabled.
It caches public catalog metadata for one minute, never credentials; generation
rereads the key. Metadata defines capabilities, including whether reasoning can
be disabled. The bounded, cancellable transport rejects tools, refusals and
unknown finish reasons, does not retry or run an agent loop, and reports only
upstream model/usage evidence. No additional SDK surface or credential store is
introduced; host protocol 269 gates the new commands on enrolled machines.

### Composer context previews

ComposerContextDock displays the existing source registrations as compact accessible counters. Each counter toggles only its section in a flat panel with a named header and close action; arrow/Home/End navigation and Escape retain pane-local focus. Questions navigate to their native chat card. The public experimental_ComposerContextStrip moves a plugin-owned inline preview between strip and panel without remounting or regenerating it. The host routes Tab/Escape to the active preview. ComposerRoot's experimental_onContextPreview callback exposes that same native strip by collapsing the expanded editor when a plugin preview appears. Core sources share a flat icon/title/action/subline row; queued messages expose their full controls on Edit, and plans show step segments with completed steps collapsed. A persistent portal container moves the same mounted form above app stacking contexts only while expanded, retaining focus/selection and shared plugin portal scope. The composer caps long drafts at five lines on narrow/coarse screens or 40dvh on desktop; Expand preserves its editor, attachments and send controls in a full-screen mobile or tall desktop form. Prompt Suggestion generates from a captured conversation snapshot and validates only cancellation, output and protected mentions on completion; application protects draft and composer identity. Conversation and memory changes do not invalidate a manual proposal. Empty-draft helper activation accepts an existing ghost through the shared suggestion controller.

### Conditional native runtime release

Thread idle release is serialized with retained start/submit/rewind work by the
runtime manager's thread control lane across environments. The runtime refuses
active, pending or background work and orders new operations after asynchronous
release. The idle reaper uses the same conditional runtime primitive with its
additional age policy. `release-idle` has no manual Stop settlement side effects;
ordinary Stop may still interrupt and cancel interactions. Protocol 270 requires
updated daemons for these strengthened semantics.

Claude SDK input waits for the captured Query initialization before entering the
prompt iterator; closure rejects readiness waiters. Iterator consumption remains
a handoff, not proof that native execution accepted or completed the prompt.

Claude resident session replacement tracks the actual host child process on every
spawn, independently of optional I/O recording. A new query waits for the previous
child to close, rather than interpreting SDK abort or iterator completion as process
termination. Concurrent replacements share the same handoff; Stop invalidates it
before a successor can start. Termination timeouts retain closing ownership and
reject new work until a later close proves the previous child has exited. This
keeps inherited native account locks authoritative during same-session continuation.

### Pending owner sends

[Pending send overlay](pending-send-overlay.md) documents the app-lifetime
presentation owner, per-action submission identity, per-group requested-event
associations, queue lineage and bounded membership snapshots. Local sends compose
after authoritative timeline merging and queue reads; they do not enter those
caches. Legacy handoff requires a joint post-receipt timeline/queue read. Optional
session recovery uses exclusive Web Locks with cancellable reload acquisition.
No database migration, index, daemon protocol or dependency change is introduced.

### Pending-send identity boundary

The production app query client binds `pending-send-identity.ts` before render.
The built-in account plugin remains the identity authority: its existing status
RPC initializes journal scope and its account realtime signals clear custody on
logout, pairing/account changes and credential revocation. Reconnect checks status;
network loss preserves pending sends. Unknown identity disables journal restoration.
The pending owner fences old reads and mutation receipts by scope generation and
keeps account identity in the journal key. See [pending send overlay](pending-send-overlay.md)
for causal legacy handoff, lock ownership and review dispositions.


### Durable send intake (Subpart A, unreleased)

`openspec/changes/core-pending-send-intake/` records the typed owner-approved exception to the overlay's no-schema contract. One generated `thread_send_intakes` table retains raw envelope custody, immutable replay hash/order anchors, revision, bounded worker claim/lease, command correlations and native handoff evidence. Terminal payloads compact; identity/hash/receipt/order rows survive until thread deletion. This source is not enabled by a release receipt; UI/SDK/CLI integration and the separately owned rollback barrier remain gated subparts B/C.

The whole path is gated by the `sendIntake` experiment (default off). Off, `/threads/:id/send` keeps the legacy in-memory submission guard and writes no row, except that a thread with open rows from an earlier on period keeps using the lane so order holds; `send-admission` answers 404 `intake_disabled`, while read and action routes stay up and stored rows still recover at startup. The legacy-deferred startup sweep bypasses the lane. The fork migration is `drizzle/fork/0006`. With it on, the existing `/threads/:id/send`, its no-ID callers and legacy deferred sends enter the same service/worker lane. `/threads/:id/send-admission` explicitly negotiates `admissionVersion:1` with a real client UUID and returns a truthful `accepted` receipt after custody commit. The additive endpoint preserves the old route's strict sent/queued response type while B is separate. `/threads/:id/send-intakes` supplies bounded typed canonical pages and the capability version; `/threads/:id/send-intakes/action` uses revision CAS. No intake is represented as a resolved native queue tuple.

Ready same-project assets pin in the admission transaction. Cross-project/uninventoried inputs first reserve unacknowledged staging order, then copy/inventory before acknowledgement; private deterministic target paths prevent same-name substitution and support recovery from an already ready copy. Attachment inventory/ready-rename commits check local authority after I/O. Host paths remain path references.

The worker serialises preparation per thread through committed native queue/request/start custody or standalone clear completion, rather than HTTP/provider completion. CompactFirst's compact checkpoint alone does not release its parent. Native scheduling, group, priority and steer rules govern after handoff. Transaction authority reaches requested append/history, queue insertion, first-start/reprovision custody, clear completion, compact correlation and recovered model mutation. Seal precedes mention or command effects; a hook pass is not an effect (an interrupted unsealed row is resent once, then abandoned as `intake_abandoned`, so hooks may run twice). A post-seal 409 preserves custody; uncertain sealed failures retain content and block the lane, without an exactly-once guarantee.

Recovery starts explicitly after actual plugin startup settles (including its logged failure path), scanning all thread statuses with a bounded cursor. Shutdown closes intake permanently before other server teardown; server move stops it before stop-work/snapshot and resumes only on the native cancellation/resume path. Revoked slots cannot clear successor slots. Late commands and attachment commits are fenced. These lifecycle changes still require the exact runtime regressions, build and independent review; source tracing alone is not live proof. The C storage/runtime handshake must use the eventual checked frozen implementation, not this design paragraph.

Failed intake heads retain custody and block their lane. The same-row revisioned `reconcile` action searches committed native queue/request/start/clear evidence; it never resends. Missing proof keeps failed content plus typed effectStage visible. CompactFirst compact-only proof does not settle its parent. Effect-stage metadata lives in the intake's own current-envelope JSON and is stripped before native validation; original replay hash is unchanged. Pre-effect deterministic 4xx retains its original replayable rejection and releases the lane; post-seal errors retain uncertainty. Known originating 4xx errors replay their original status/code/message with retained-custody/recovery details; they do not release a failed head. Typed guard collisions use one-shot release wakes with bounded fallback/retries. Legacy waits report 409 intake_blocked with retained-custody details for followers behind an actually failed head or unknown failed outcomes. Healthy preparation, healthy predecessors and active inline tails preserve the old awaited receipt without an independent HTTP wait deadline; worker failure/stop still settles them. The separate five-minute worker attempt cap retains failed custody on expiry.

Dedicated clear/compact, native drain and thread creation retain native entrypoints, outside the intake arrival order. Like a native queued message, an admitted send can deliver after an independent clear; pure intake preparation does not block native drain. Selected commands through send ingress remain in the intake lane. Addenda13/14 explain this minimum and its required real-DB regressions; the moving A source has no runtime/review PASS yet.

Provider-registry readiness has a bounded timeout; it does not start intake recovery. runServer explicitly starts the app intake lifecycle after startServerPlugins settles. Early admitted custody remains pending until this signal. Permanent stop fences late startup completion; server-move pause removes readiness before stopping workers. Test harness startup uses the same app lifecycle method and can defer it for a real-DB cold-start regression.

Deleted-thread intake waiters retire from the existing `thread-deleted` notification after the actual database commit; rollback cannot reject live custody. Empty-head recovery also settles vanished-row waiters. Invalid stored native receipt JSON/schema rejects all current listeners with retained-custody `intake_blocked`, unregisters them and reports a content-free diagnostic; it does not alter the row, release its lane or resend. Healthy unrelated threads and active inline tails retain their awaited result.
