# werserk/bb fork

This is a maintained downstream fork of [get-bb/bb](https://github.com/get-bb/bb). `fork/main` started at the upstream release tag `desktop-v0.48.1`, now carries upstream `desktop-v0.50.1` merged in (after `desktop-v0.49.0`), and adds only downstream patches; it integrates upstream `desktop-v*` release tags, never upstream `main`. Architecture, branch model, release policy and the patch ledger live in the maintainer's repository: `docs/bb-fork/` in [werserk/bb-plugin-lab](https://github.com/werserk/bb-plugin-lab) (private).

`apps/app/src/lib/synchronized-spinners.ts`, installed before React mounts in `main.tsx`, aligns native `spin` animations and pure full-turn animations on `.animate-spin` or working `.wp-status-mark` targets, including scoped plugin names, to a 1000ms document-timeline phase. Existing animations and later animation starts share the same path; reduced-motion and paused animations are left to CSS. It adds no render loop or DOM observer.

The provider-independent visible plan tool lives in `apps/server/src/services/threads/thread-plan-tool.ts`: runtime configuration contributes `bb_update_plan` to every provider, and the authenticated tool-call route writes normalized `planSteps` into the existing timeline. The latest snapshot remains available after turn completion (including idle and error) until a new snapshot replaces it or an empty plan clears it. A context clear also hides a plan from before that boundary; the explicit includeClearedContextHistory view can still read it. Fully completed plans remain visible so the result of the last task stays inspectable; a new turn alone does not imply a new task. Optional single-line step `note` (1–1000 trimmed characters) and `actor` (1–100) round-trip through the same timeline JSON and pendingTodos response; legacy native plans omit them. This additive event-payload extension was owner-approved for item 1b; it rewrites no old events and adds no DB table, migration, or parallel store. The existing head-state query selects the latest plan through the partial plan index with LIMIT 1, even outside the visible page. The app consumes this response, not a timeline scan per render.

ThreadScreen renders the shared ThreadPlanCard in the top-right rail for page, panel and transcript chats, outside the composer. It reuses ThreadTodoCard and its accessible disclosure; each mounted card has unique control IDs. Expanded rows preserve plan order and display note and actor. Only fully completed plans older than the latest loaded turn (source sequence and timestamp) collapse automatically, with locale-formatted update time and neutral completed-plan copy; turn order never establishes a task boundary. Every non-empty plan shows its relative update age from the latest planSteps event, refreshed each minute and visible while collapsed. An unfinished plan becomes stale only when a different root turn that first started after that snapshot ends (completed, failed, or interrupted). The posting turn ending never makes its own plan stale. Variant A uses a quiet line and muted open steps; failed steps keep their failure mark. The stale line exposes its first qualifying end time as a tooltip. No new task boundary is inferred. Pending owner interactions mark an unfinished plan yellow. Narrow lists are capped at 10rem; wide lists at 24rem. Copy follows the browser locale (Russian and English), matching the app's existing browser-locale date formatting; the app has no central translation catalog. Archive/environment guards and the 1b data lifecycle are unchanged. The age/staleness projection adds only optional derived `pendingTodos.staleSince`; no stored fields, migration, CLI or SDK changes are required. `todo-snapshot-extraction.ts` derives it from normalized lifecycle events, independently of rendered work groups and provider. `packages/db/src/data/plan-staleness.ts` supplies at most one root start/end pair to the server head-state projection so empty turns and off-page evidence survive pagination without loading intervening conversation payloads. The latest-plan selector and context-clear boundary remain unchanged.

A35 preserves native failed plan steps through the domain snapshot, extraction, serialization and card rendering. Failed steps use the native failure mark/style and retain supplied note/actor; only completed steps count toward progress or the all-completed collapse predicate. No reason or task boundary is inferred from text.

Native plugin tool contexts preserve daemon caller identity in `apps/server/src/internal/tool-calls.ts`; the additive SDK fields and capability live in `packages/plugin-sdk/src/backend-contract.ts` and are implemented by `plugin-api.ts`. The internal request schema accepts absent turn identity for plugin tools, while built-in turn-scoped tools retain their required-identity boundary. Existing daemon payloads remain valid and unchanged; no protocol bump or database migration is needed. `callId` remains required on the wire. Plugins must check turn liveness independently.

Claude queries with native MCP tools bind each run to an origin. A new client turn after the previous run ended keeps the live query (and so the Claude process and its background tasks, such as `run_in_background` shells) and rotates the origin in place (`tool-origin-<serial>-c<n>`); only a turn that arrives before the run ended, or a pending restart (settings, permissions, auth, ended stream), replaces the query. Their MCP callbacks retain the origin after Stop/replacement; daemon turn mapping preserves it independently of the current turn. Steers share their existing run. Older bridges retain the null-turn fallback; the global exact-origin capability remains false while Pi/ACP paths lack origin stamps. `bridge.client-turn-reuse.test.ts` covers the reuse and the fallback. Known gap recorded before this reuse and not re-measured since: the per-turn replacement spawned a second Claude process, which single-process recordings cannot serve, so the claude-code `steer` and `compaction` parity replays failed at 69/77.

Per-call provenance is computed in `packages/agent-runtime/src/bridge-protocol-adapter.ts` and `runtime-provider-requests.ts`: only an assembler-mapped origin is `provider`; active-turn fallback and unmapped raw IDs are `arrival`. The optional `turnOrigin` travels through the domain request, daemon HTTP client and authenticated route into the SDK context; it is omitted without turn identity and never read from tool arguments. The host advertises `perCallTurnOrigin: true`. Protocol 258 is deliberately retained with old-daemon omission and old-server unknown-field compatibility tests; consumers fail closed on missing provenance.

Claude root query origins are aliases of the assembler's implicit current turn, established through `ensureTurnOpen`; they do not mint a parallel explicit turn. Repeated origin opens (including steer) are idempotent and completion clears that same current turn. When the SDK opens a new root turn in the same query without a client turn/start (a native resume, e.g. after a background task settles), the bridge rotates the origin (`tool-origin-<serial>-r<n>`) and stamps it on that turn's open, so later tool calls map to the live resumed turn instead of the completed one; `bridge.native-resume-origin.test.ts` covers it. Codex retains its existing explicit provider-turn path. The dynamic-tools bridge calibration exercises the full stream, MCP callback, real assembler and the runtime's active-turn rule (mirrored locally; the plugin stays forkable) so the tool origin cannot silently diverge from item/completion identity.

The Codex bridge reports a steer into a turn Codex has already ended as `NO_ACTIVE_TURN` with `staleTurn` recovery, the same shape ACP uses: Codex's `-32600 "no active turn to steer"` refusal, and a permission-changing steer whose expected turn is no longer open. The runtime then clears that turn and the daemon starts the input as a new turn instead of failing the command after the server has answered `sent`. Other steer failures remain `BRIDGE_ERROR`. `bridge.steer-stale.test.ts` covers both stale paths and the control.

A Codex turn error whose `codexErrorInfo` this bridge does not know (for example `modelNotFound`, newer than the generated schema) parses as `other` instead of invalidating the whole event; the original value stays visible to operators as the provider error's `errorInfo.providerCode`. Otherwise the failed `turn/completed` and its `error` notice were downgraded to `provider/unhandled`, and bb kept a stale running turn that the next steer hit. Other malformed events still surface as `provider/unhandled`.

The earlier item 1b/1c presentation paragraphs above are historical; the core-plan-needs-input renderer supersedes their age timer, counters and collapse rules. Implementation and compatibility details live in `docs/core-plan-needs-input.md`. The core-plan-needs-input slice adds optional bounded `planId` and stable step IDs plus public failed tool updates, without a table or history rewrite. `packages/thread-view/src/thread-plan.ts` owns the canonical plan/interaction projection; `thread-plans.ts` reads the latest 32 snapshots plus targeted lifecycle/nearest-plan anchors independently of pagination. Context and explicit empty clears bound history; up to three distinct previous identified plans are returned with truncation. The public `threads.plans` batch route, SDK and CLI use that projection. The app batch cache supplies both native ThreadPlanCard and optional experimental SDK hook/component, with revision/coverage, event invalidation and no polling. ThreadPlanSteps owns 340px overlay/panel presentation, four 32px compact rows, container <=640 disclosure, quiet history and native Answer/local Skip. Editor ownership and the existing interaction-keyed native drafts span surfaces; unsupported input retains native recovery. API audit and Plugin Guide document the shared callers. Daemon compatibility evidence and the scope of runtime verification are recorded with the candidate; no release authority is implied.

Persistent question markers survive hidden service turns through the same standalone conversation rows as ordinary questions; surrounding service replies stay hidden. Persistent cards inject the app voice textarea locally, so multiple cards do not register competing global shortcuts. HTML question materials use the shared document bootstrap in `packages/shared-ui/src/lib/html-frame.ts` and theme observer in `use-frame-theme.ts`, also consumed by inline-vis through reexports. Frozen HTML receives theme tokens and bounded content height messages without changing stored snapshots or adding same-origin sandbox access.

Open-question reads share `packages/db/src/data/conversation-questions.ts`'s public,
non-archived open selector. `readThreadPlan` emits `questionAttention` on every
read (including zero/null), using indexed count and oldest identity queries in
its transaction; the summary may change at the same timeline revision.
`GET /threads/:id/questions/open`, SDK `threads.questions.open` and
`bb thread questions list --open` traverse descending keyset pages. A fingerprint
of open identity/revision pairs and archive state fences completeness: changed
sets return 409 and invalid/cross-thread cursors 400. This read view never changes
stored question status; history listing keeps its existing cap and array shape.
The native navigator traverses that view in bounded windows, restarts once on
changed cursors and exposes incomplete/Retry instead of mixing revisions. It
refreshes while visible every five seconds; query counts expire after 30 seconds
without success. Known-card navigation re-reads the record, updates the native
card cache and bypasses historical event scanning. The owning ThreadScreen hosts
a native ConversationQuestionCard fallback at the timeline end, with pane-local
focus and removal when the original marker becomes loaded. The existing optional
focusThreadPlan capability accepts a separate questionId, with native interaction
precedence, through the same navigation controller. The plugin consumer and
installed acceptance remain pending; this branch is not released.

Initial managed spawn attribution flows through `thread-create.ts` into the shared
`dispatch-attempt.ts` admission and `thread-provisioning.ts` request event. The
persisted `client/turn/requested` retains the dispatch sender and existing
`dispatchProvenance`, matching later tell events; agent-created first turns no
longer masquerade as owner turns. Senderless owner starts retain user attribution.
This changes no daemon wire or schema and rewrites no historical events.

Durable owner question answers now try the shared claimed auto/steer dispatch
while a turn is running. Optional typed questionResponse metadata in stored turn
requests preserves card ownership when a non-steerable or stale turn refusal
requeues the answer. The replacement remains the existing questionResponse
payload for rollback compatibility; native rejected-request history prevents
repeated injections before idle. All dispatch guards and transactional claims
remain shared. See docs/system-overview.md and the instant-question-answer
OpenSpec delta for the acceptance and stored-data compatibility contract.

Claimed card answers alone set optional internal host turn.submit.injectOnly. The daemon protocol (260 when added, 266 since the 0.49.0 merge) requires the matching daemon through existing protocol self-update. The runtime checks bridge-negotiated steerMode; queue-mode ACP is refused before sending/cancelling. Legacy, system, agent and plugin commands omit the marker and keep their previous steering behavior. A withdrawn-before-refusal response is settled without requeueing or failing its active thread.

The approved UI A slice keeps sidebar New thread primary/split activation and
adds middle-button browser-tab activation through the existing Navigation action.
The host passes project/reused-environment context in a one-use composer URL;
RootComposeView consumes it into the existing selection and location-state path.
No SDK or stored-data contract changes.

Scrollbar metrics live in app.css: Chromium/WebKit use 8px native scrollbars,
with thin as the Firefox fallback. Reading visibility changes the per-element
--bb-scrollbar-thumb and --bb-scrollbar-thumb-hover colors without overriding
scrollbar-width or scrollbar-color. Sidebar, chat, metadata and file preview
scrollers share that policy, including persistent CSV scrollbars. Horizontal
navigation strips retain their explicit hidden-scrollbar policy.

Core reading surfaces reserve an external 8px desktop gutter (20px for coarse
pointers), using the shared --bb-panel-scrollbar-inset root token so plugin
reading surfaces can use the same metric. Shared chat viewports and native
right-panel reading slots reserve it without padding their inner content. File previews receive their gutter once from the host slot; their
Markdown, CSV and code bodies do not reserve a second gutter. Metadata owns its
own viewport gutter. Browser New Tab keeps inline gutters without a bottom
margin on its full-height body. Static PageShell surfaces outside panels keep
their own viewport and inset.
The sidebar reserves its gutter outside SidebarContent. Plugin-owned scrollers
keep their own external gutter and inherit the global scrollbar metrics; local
thin or WebKit non-auto color overrides must not replace those metrics.
Panel resize hit targets share panelTransitionTokens.ts for both split axes:
9px fine targets around the 1px seam and 32px coarse targets. Sidebar resizing
uses the same widths. Right-panel separators retain the upstream pointer-only
focus policy and remain outside the tab order. Seams are transparent at rest;
hover feedback waits 200ms and pointer dragging reveals the seam immediately.
The native right-panel aside and its loading placeholder have no duplicate left
border; resize handles own the boundary feedback. Framed inset chrome is unchanged.
The collapsed navigation rail includes its 1px body border only in framed mode
through --bb-sidebar-rail-border-width. Plain browser chrome reserves no removed
border, keeping the header body flush with the actual rail.

Chat Markdown tables use the existing contained renderer, keeping their outer
edges within the prose column and scrolling wide contents horizontally. Assistant
settled blocks and streaming tails share this policy, as do collapsed and expanded
generated messages. User messages already use contained tables. Shared
MarkdownPreview defaults remain unchanged for non-chat previews.

The owner-approved thin overlay replaces the reserved desktop scrollbar gutter on
sidebar, chat and secondary reading panes with the existing shared Radix ScrollArea.
Native viewport refs remain the scrolling and anchoring authority. The Radix content
wrapper uses a column layout instead of its intrinsic-width table so long prose
and bottom-anchored chat retain their containing width and content floor. App CSS
owns the shared 4px thumb / 8px hit policy, inset 1px from the right edge; visibility
follows pane hover, keyboard focus and captured drag, never a scroll timer. Fine
vertical resize targets are 6px, shifted 2px right of the divider's left edge,
touching the scrollbar lane at that edge minus 1px even for a 1px divider. Coarse
resize targets stay centered at 32px. Window pointer release and cancellation
clear overlay drag visibility even when Radix never captured the pointer. This is
an internal UI change, with no SDK, host, persistence or scrolling-physics change.

Overlay is explicitly opted into by the app-local ReadingScrollArea, preserving
ResourceCollection's existing scroll-triggered Radix policy. The unrelated plugin
category list retains its native transient CSS. Contained transcript panes also
use ReadingScrollArea. FilePreviewHostScrollContext makes the existing host slot
the sole Markdown scroll owner when it already scrolls; full-height slots let the
preview own scrolling. This avoids an unbounded nested Radix viewport observed
in the isolated candidate lab. No context or primitive is exported through SDK.

## Upstream sync: desktop-v0.50.1

The fork merged upstream `desktop-v0.50.1` on top of `fork/main` `6597674a8d`, by the same rule: where upstream ships an equivalent, take upstream's and drop the fork's. The per-patch table (kept, dropped, adapted, with evidence) is in the maintainer's repo, `docs/bb-fork/evidence/sync-0.50.1.md`.

- Daemon protocol: upstream 268, the fork 274 (six fork bumps).
- Database: `packages/db/drizzle/` takes upstream `0153`-`0158` unchanged (all additive: new tables, added columns, one settings copy). Fork migrations `drizzle/fork/0000`-`0007` are unchanged (`0007` came with the #7872 backport, merged from `fork/main` `fea0cbef99`; upstream `0162` is still not in 0.50.1, so the backport stage stays active); the fork snapshot was refreshed over the synced schema by the sync procedure above and is now `0007_snapshot.json`. Rollback: the new migrations drop nothing, so the previous build is expected to start on a migrated database (inferred, not rehearsed); restoring the pre-start database snapshot remains the safe path.
- Thread lifecycle: upstream's persisted lifecycle (`apps/server/src/services/threads/lifecycle/`, tables `thread_run_states` and `thread_turn_requests`) replaces the fork's lifecycle event appliers, `turn-completed-events.ts` and `lifecycle-outcome.ts`. The fork's rules now live on it: refused held-answer recovery in `thread-lifecycle.ts` (only while the tracked request is not yet accepted), no owner attention for hidden service turns in `lifecycle/run.ts` and `finish.ts` (except a move to error that is not a turn completion, such as a provider failure or daemon loss, which raises attention), and native-pool `release-idle` through `buildThreadStopCommand`. A stale-turn answer on a running thread follows upstream's single redelivery into the running turn instead of the fork's re-queue.
- Head state: upstream moved it to `thread-head-state.ts`; plan `staleSince`, context-clear hiding and `includeService` filtering are ported there and stay exposed through the route, SDK and CLI.
- Send intake keeps its own receipts; `sent` receipts carry upstream's required `messageSequence`, and receipts stored by older builds are read with it filled from the request or left empty.
- Dropped for upstream's version: the `resumeThreadsAfterRestart` experiment (now a General setting), the fork's event-loop lineage bound, the Codex exact stale-steer match, hand-kept bb-guide API indexes (now generated), the second compiled app Vitest run, the sidebar update chips (upstream's update button and card), and the provider-codex and provider-pi shared-worker Vitest configs.
- Upstream's new lint rules (`bb/no-comments`, `bb/forkable-plugin-imports`, `bb/no-raw-resize-observer`, React Compiler `all_errors`) now cover fork code; fork code satisfies them without rule changes, apart from five line-level disables in the app: three `react/set-state-in-effect` around one-shot plan focus tokens and two `bb/no-native-title-with-aria-label` (context banner, question navigator).

## Upstream sync: desktop-v0.49.0

The fork merged upstream `desktop-v0.49.0` on top of the daily build commit `53f5722472`. The owner's rule for the merge: where upstream now ships an equivalent, take upstream's and drop the fork's.

- Dropped for upstream's version: all fork child-thread notice work (holding, settle grace, caps, truncation, render snapshots, the periodic reconcile, `child-notice-policy.ts`, `child-notice-reconcile.ts`, `child-notice-queries.ts`), the idle-provider fast path edits, the prompt-area goal card, and both `thread-activity` modules. Upstream delivers notices through the dispatcher and merges them with `coalesce_key` / `coalesce_state`.
- Thread status glyphs come from upstream's single resolver (`packages/plugin-sdk/src/internal/thread-status.ts`). The fork's two rules live in one place, `toThreadStatusThread` in `apps/app/src/lib/plugin-sidebar-threads.ts`: an open question card counts as waiting for input, and a hidden service turn keeps its side work out of the glyph. An error after a hidden service turn shows as an error, in the plugin sidebar and in the server's list projection (`runtime.displayStatus`). `threadNeedsOwnerAttention` moved to `packages/client-core/src/thread/owner-attention.ts`. Plugin sidebar DTOs preserve raw native interaction state alongside the derived indicator; the shared resolver retains `waiting-for-input` from that indicator when resolving individual rows and hidden group members again, without changing unread-error priority.
- Daemon protocol: upstream is at 264, the fork at 266. The comparison is ordered, so the fork's number must stay above upstream's; each sync sets it to upstream's number plus the fork's own bumps.
- Database migrations. `packages/db/drizzle/` is byte-identical to upstream: journal, snapshots and SQL. The fork never adds or renumbers files there.
  - Fork migrations live in `packages/db/drizzle/fork/`, with their own journal, and are recorded in their own ledger table `__bb_fork_migrations`. Upstream's `__drizzle_migrations` holds only upstream migrations.
  - `migrate()` in `packages/db/src/migrate.ts` makes two fork ledger calls, both in `packages/db/src/fork-migrations.ts` (plus the backport stage below). First, before anything else, `adoptLegacyForkMigrationRows` moves fork rows that older builds wrote into `__drizzle_migrations` over to the fork ledger, matched by `when` and checked by hash. A hash mismatch throws and moves nothing. Last, after upstream's migrations and checks, `applyForkMigrations` applies pending fork migrations and throws if any fork migration is missing from the fork ledger or has a different hash.
  - The six fork migrations were `0148`-`0153` in the main journal at `53f5722472`. They are now `drizzle/fork/0000`-`0005` with the same SQL bytes and the same `when`, so their ledger identity is unchanged.
  - A new fork migration: change `packages/db/src/schema.ts`, then run `pnpm --filter @bb/db exec drizzle-kit generate --config drizzle.fork.config.ts`. Do not run `db:generate` (the default config) for a fork change: it would write the fork's schema into upstream's folder. Keep only the newest snapshot in `drizzle/fork/meta/`.
  - A sync: take `packages/db/drizzle/` from the upstream tag unchanged. Then refresh the fork snapshot: run the fork generate command once; it writes upstream's new schema changes as a fork migration. Delete that SQL file and its journal entry, keep its snapshot as the only one in `drizzle/fork/meta/`, and check that a second run reports nothing to generate.
  - A backported upstream migration: a fork migration may do what a not-yet-synced upstream migration does. List the pair in `forkBackportsOfUpstream` in `packages/db/src/fork-upstream-backports.ts`. Once a sync brings the upstream migration, the fork runner records the fork migration without running it on any database whose `__drizzle_migrations` already has the upstream one (a fresh database, or one that never ran the fork migration). A database that did run it needs a stage step, called around upstream's migrator in `migrate()`, so the upstream DDL does not meet the fork's column. The fork migration file and its journal entry stay forever; they are ledger identity.
  - `drizzle/fork/0007_queued_message_recheck_at` backports upstream `0162_queued_message_recheck_at` (get-bb/bb #7872) with the same SQL bytes. Before upstream's migrator, `stageForkRecheckAtForUpstream` copies `recheck_at`, `send_at` and `state` of the affected rows into `__bb_fork_stage_queued_message_recheck_at` and drops the column and index; upstream 0162 then adds them, and `restoreStagedForkRecheckAt` writes the copied values back by row id. That keeps 0162's data move off rows that are already in the new meaning. Both steps do nothing until a sync brings 0162. Guard: `packages/db/test/fork-upstream-backports.test.ts` runs that sync against today's databases.
  - Guard: `packages/db/test/fork-ledger.test.ts` builds the production shape forward (upstream to the fork base, then the fork six in the old ledger), migrates it, and compares the full schema with a fresh database. It fails if an upstream table rebuild drops a fork column.
  - Rollback: once the merged build has started on a database, the previous build does not run on it. The previous build's Drizzle sees upstream's `0152` as its newest ledger row and tries to re-apply the fork six; the first `ALTER TABLE ... ADD service_turn` fails on the existing column, Drizzle rolls back, `migrate()` throws and startup fails, with the database unchanged. Its Viewed marks code would also fail, because upstream `0151` dropped `diff_viewed_files`. The only rollback path is restoring the database snapshot taken before the merged build's first start.

Prompt Suggestion (formerly Autosay) uses the experimental scoped composer suggestion controller and the shipped Composer's placeholder/Tab/Enter integration. Its optional plugin selects a connected model through BB's shared AI-generation API. Host acceptance guards snapshot identity and preserves normal drafts, questions and sending. The optional AI Gateway plugin exposes the same generation path as a bounded OpenAI-compatible text endpoint. See `docs/system-overview.md`, `docs/api_to_audit.md` and `plugins/prompt-suggestion/PLUGIN_OVERVIEW.md`. Release evidence is recorded separately from source implementation.
