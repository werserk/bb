# Prompt Suggestion companion — proposed design

Status: owner approved the design with a goal-oriented proactivity amendment. This revision records that amendment; no production activation or release is authorized here.
Date: 2026-11-16. Source baseline: `1c00891a1896e0a515e5536cd3c91f20e36d7fdf`.

## Review contract

- **goal:** Help the owner direct the working agent toward the current accepted goal and its acceptance criteria through a useful, grounded next-message suggestion, with a measured target below one second after an eligible completed answer.
- **in_scope:** Server-owned preparation and result reuse in Prompt Suggestion; reusable provider session affinity; OpenRouter through the existing Pi connection owner; exact reasoning controls; latency and quality evidence.
- **non_goals:** A permanent agent/GPU per thread, speculative candidates from unfinished answers, autonomous sends, separate summarizer calls, tools or skill-catalog injection in the inference request, a new gateway or credential store, a release in this task.
- **claim_1:** Preparing or serving one completed-turn result never needs a visible composer. Probe: finish a tracked thread with its composer unmounted, then open it and attach the already prepared result without another inference.
- **claim_2:** Every result attachment rechecks current server eligibility/context and matches the latest known local composer turn/context/configuration/draft snapshot. Invalidation clears known-obsolete results; the design does not claim an atomic server-context condition on a later Send. Probe: a table of late completions, new user inputs, queued work, questions, approvals, disconnects and multiple clients, run against the native composer and server coordinator.
- **claim_3:** Within one plugin process and its one-hour admission window, at most one inference is admitted per thread/turn/context/configuration key, including concurrent CLI/UI/event consumers; terminal none/error results do not trigger timer-driven retries. A later foreground registration after that window, or a plugin restart, may admit a fresh attempt. Probe: concurrent and duplicate-event tests with a counted generator.
- **claim_4:** The actual OpenRouter request uses the selected exact model, reasoning none, latency routing and a stable opaque per-conversation session key. Unsupported settings fail before dispatch. Probe: inspect the real adapter-produced request with synthetic context; then perform a separately authorized bounded API pilot.
- **claim_5:** Speed is reported until complete valid suggestion and visible attachment, with queue, context preparation and model-call timing separated. None, errors and timeouts are not counted as fast useful suggestions. Probe: instrumented synthetic pilot and browser receipts.
- **claim_6:** The implementation is usable and inspectable from the SDK, CLI and native UI through one coordinator. Probe: identical job identity and results across manual CLI generation, automatic events and UI attachment; document the plugin command/settings surfaces.
- **claim_7:** Suggestions advance the latest owner-supported goal and preserve its acceptance criteria and constraints across conversational drift. Probe: owner goal replacement versus agent-only detour, owner side question, claimed completion without verification, missing initial context, paused goal and an actually completed task. Evaluate natural Russian wording and grounded action selection, not just JSON validity.
- **invariant_1:** No product code, production setting, provider credential or release changes are authorized by this design-writing step. Enforcement: reviewed diff and runtime readback before implementation.
- **invariant_2:** Existing project allowlist, per-plugin-process rolling hourly limit of 60 admitted inference calls, explicit model selection and no automatic fallback or timer-driven retry remain effective. No paid keepalive or summary calls are introduced. Enforcement: coordinator admission and transport tests.
- **invariant_3:** Conversation-derived input (source excerpts, compact task state and recent messages combined) remains bounded by the existing context setting, default 24,000 characters. No raw tool output, hidden reasoning, workspace files or other threads are added. Current user instructions including BIBLE are a separate versioned static prefix, not conversation data. Original messages remain the evidence source. Enforcement: context assembly and source-reference tests.
- **decision_1:** Extend Prompt Suggestion instead of creating a companion plugin. It is the same next-message policy, scheduling and composer result, with one owner and one job cache.
- **decision_2:** Reuse Pi's authenticated model runtime for OpenRouter. Reject a second HTTP client/key store; the installed Pi runtime already exposes OpenRouter routing, reasoning-off translation and session affinity, while BB's current wrapper omits those controls.
- **decision_3:** Separate background generation eligibility from composer display eligibility. Reject browser-owned inference and focus-based cancellation of shared server work.
- **decision_4:** Keep preparation and candidates in bounded process memory. Reject a new database or transcript store; native thread history is the source of truth and reconstructs state after restart.
- **deferred_1:** Independent summarizer calls and pre-answer speculation. Compact task-state extraction now belongs in the same suggestion call under the owner's amendment; there is no extra model call per turn.
- **deferred_2:** Winner selection and the subsecond quality verdict. Public benchmarks are screening evidence; an exact-route/mode pilot must establish this before the provider is recommended for production.
- **affected_paths:** `plugins/prompt-suggestion/`, `plugins/provider-pi/src/ai/`, `packages/plugin-sdk/src/ai-generation.ts`, native AI dispatcher and affected host RPC contracts, `plugins/ai-gateway/`, Plugin Guide and API audit, plugin skills/configuration documentation, `docs/system-overview.md`.
- **affected_resources:** Selected BB threads and the configured primary-host Pi/OpenRouter connection. Current production Terra selection remains untouched during design and pilot preparation.

## Source observations

Prompt Suggestion currently starts from its mounted composer effect. Its server reads context only for an idle successfully completed root turn, then calls shared native generation. A single active request is allowed. Closing or changing the composer cancels that request. `lastLatencyMs` measures the native generation call, not all UI-to-display time.

The SDK already has `thread.active`, `thread.idle`, failure/archive/delete and pending-interaction events. `experimental_thread.events` is coalesced at most once per second: use it for invalidation/preparation, not as the only latency-sensitive completion trigger. `thread.idle` is a wake to check committed root-turn success, not proof by itself.

Typed RPC query invalidation is available through `bb.rpc.experimental_invalidate`; no result polling is needed. The native composer already fences draft/context changes and owns Tab/Enter/native Send.

Pi's installed `ModelRuntime` supports sessionId and the underlying OpenRouter adapter emits `x-session-id`; its model compatibility supports `openRouterRouting`. BB's wrapper currently advertises no reasoning efforts and rejects an explicit effort. This omission is a wrapper extension, not evidence that OpenRouter inference is unavailable in principle.

## Product behavior

Opening a supported thread composer registers an interest lease. The server retains interest for 10 minutes after the last foreground registration, including a subsequent switch to another thread. Renew on actual foreground entry, not periodic keepalive. Keep at most eight recently tracked threads; evict least-recent background entries. Expiry ends new background scheduling and removes the prepared context. This bounds background spending and does not silently subscribe every project thread.

Lease expiry removes prefixes and stops scheduling, but does not evict the separate one-hour admission record or its small terminal result. A plugin restart discards both; cross-restart exactly-once generation and a durable billing cap are not promised. A lease may expire during a long main turn, in which case reopening the thread supplies fresh interest; this can require a cold preparation.

The plugin settings retain the existing master switch and project allowlist, and add one `Background preparation` switch. It starts off for an existing installation; enabling the new behavior requires the owner's rollout decision. Status explains tracked threads, preparation, pending, ready, none, rate-limited, unavailable and error states without claiming generation is always occurring.

While the main agent works, assemble the conversation input locally from public messages and the current source-linked task state. Do not invoke another model to read each token. When the root turn completes successfully, append its complete final answer, check server admission and schedule one native generation request. Stable instructions and unchanged source excerpts precede changing task state and the latest messages, allowing prefix reuse where supported. The context selector preserves source excerpts for the goal and active constraints alongside recent complete messages within the existing bound. If essential evidence cannot fit, mark the state incomplete and prefer a reconstruction question over inventing the missing goal.

## Owner amendment: goal-oriented proactivity

The role is a goal-oriented conversation companion. Its normative instruction source is [the companion role](2026-11-16-prompt-companion-instructions.md). This replaces prediction of the most likely next message with selection of the most useful next direction within the owner's accepted scope. The original scheduling, native composer actions, no-auto-send and no-release boundaries continue.

The companion distinguishes a user goal change from an agent detour and a temporary side question. Explicit owner changes supersede earlier goals; supporting constraints continue unless changed or made inapplicable by that instruction. Ambiguous drift remains uncertain. In such cases the useful next message can ask the working agent to reconcile the current goal and remaining criteria instead of guessing or automatically returning to the original goal.

The same inference returns a bounded task state and either a suggestion or none. The task state contains current goal, acceptance criteria, agent-reported progress, evidence visible in the supplied conversation, remaining work, blockers/choices and changed-goal provenance. Each nonempty factual item carries supplied source message IDs; inferred criteria are labelled proposed, never silently accepted. The server validates source IDs, lengths and source revisions; it does not claim this validation proves the model's semantic interpretation. No hidden chain of thought is requested or retained.

A compact state is derived memory, not new authority. Retain source excerpts for its live goal/constraints so successive calls can re-ground and revise it. An unsent candidate never becomes an owner decision or part of goal evidence. Assistant claims are labelled reported unless the supplied material itself contains evidence; the companion has no tools to independently verify a build, commit or deployment.

Task state is process-memory only, keyed by the conversation and instruction/configuration revisions. On cold start, reconstruct from bounded authoritative conversation and any source excerpts that remain available; never promise perfect recall of arbitrarily long history. Respect an explicit thread context-reset/compaction boundary: invalidate incompatible derived state and do not silently retrieve excluded prior material. If the goal cannot be grounded in the available context, suggest asking for a short task recap. State updates commit only for the current completed-turn revision, including valid none outcomes; stale generations cannot update memory.

The first implementation keeps one inference per admitted job. Reserve a compact output budget for state as well as the suggestion; record actual output tokens and end-to-end latency. This extra output may affect the subsecond target and must be measured against the earlier text-only baseline. The role and state are inspectable through the native settings/CLI/SDK; content stays out of ordinary diagnostics logs. A compact expandable explanation may show the goal and the gap behind a suggestion, using the same returned state rather than another call. It does not require the owner to read a second report before accepting.

### Base instruction composition

At request assembly, use the owner's configured base-instruction source, preserving the BIBLE section verbatim. Read it through the existing instruction ownership path; do not maintain a second manually copied or abridged Bible in this repository. The current installation's source is the BIBLE section of the assembled user instructions, not all provider scaffolding around it. This design change edits neither that source nor the main agent's instructions.

Compose the request as: the companion role and output contract, the applicable owner principles and communication preferences, then explicitly delimited conversation data and derived task state. Resolve the role's scope clearly: the authorized task is to recommend a direction; general execution/review principles guide what it recommends. It has no tools, cannot run review pipelines or ask native cards, and cannot execute the working agent's task. An unresolved decision can yield a suggested clarification but never an invented selection or approval. Native pending questions/approvals still suppress composer suggestions under the existing gate.

Use a stable prefix and fingerprint the instruction content in job/configuration identity. Missing required base instructions produce an inspectable unavailable reason; never silently claim BIBLE is active when it was not supplied. Cache reuse is measured rather than assumed. Full BIBLE adds input tokens even with no tools; benchmark quality and complete-response latency with this actual instruction bundle before selecting the production model.

When the owner opens the composer, attach a ready current candidate immediately, attach to a pending job, or request the same coordinator to prepare a missing eligible result. Attachment performs a fresh server eligibility/context check and uses the existing local composer snapshot. A pending job still shows Preparing suggestion. A valid none restores the ordinary placeholder; timeout/failure preserves the existing error disclosure. Tab inserts editable text; Enter/native Send submits through the existing host action.

This removes repeated local context work and allows inference to finish while the owner reads or views another recently tracked thread. It does not claim a response will exist at the exact instant the main answer ends: the final model call starts only after that answer is complete.

## Coordinator and lifecycle

One server coordinator owns tracked threads, prepared prefixes, a bounded work queue, single-flight jobs, terminal results and diagnostics. A job key binds thread ID, completed root-turn ID, a hash of selected conversation text/context boundary and configuration revision. It excludes browser focus, component identity and draft identity. Generation keys change when inference input changes; eligibility-only changes invalidate delivery without automatically causing a second call. Record admission before dispatch in a separate one-hour ledger, with its eventual ready/none/error outcome; neither prefix eviction, lease expiry, UI detach nor cache-clear resets that record. The existing rolling rate limit bounds it to at most 60 admitted entries. On expiry no timer dispatches a replacement: a later foreground registration can admit one fresh attempt under the same limits. Explicit cache clearing is not a regeneration capability. Counters and this ledger restart with the plugin process; do not describe them as durable spend enforcement.

States are `prepared`, `queued`, `pending`, `ready`, `none`, `error` and `unavailable`. Keep at most one current result per tracked thread. The queue holds at most one latest job per tracked thread, with a foreground request ahead of background work and one inference in flight. Dropped, expired or superseded jobs never resume. Count waiting time separately from model time.

New active work cancels the obsolete generation and drops its terminal result. Settings/model/connection changes invalidate prepared state and jobs. Archive/delete/disable removes the thread state. Pending questions, approvals and queued user work block generation and display. Committed question/queue changes wake the ordinary admission check; reappearance of eligibility reuses a current terminal job or admits its first call, not a retry. Before every dispatch and result delivery re-read the authoritative facts. There is a remaining interval between this read and a later client action in which another client can change server state before invalidation arrives. Existing ordinary submission admission remains authoritative, but is not a newly added atomic suggestion-context precondition. Stronger linearizable context-bound Send would require a separate core submission contract and is outside this version.

Browser subscriptions do not own inference. Unmount/draft input releases that browser's wait and clears its display without aborting a server job still owned by a valid interest lease. Existing cancel commands must document and implement the distinction between cancelling a wait and cancelling a sole-owned generation. No accepted-but-ignored capability fields remain. Disposal and expiry cancel owned work and ignore late resolutions.

Use an invalidatable typed RPC read for per-thread job state; the server invalidates that tag on meaningful transitions. UI, CLI and lifecycle handlers call the same coordinator. Manual suggest remains an explicit operation and coalesces with an identical current job; it never inserts or sends text. Add CLI inspection/tracking/cache-clear operations and corresponding SDK/RPC methods, with bounded lease durations and no text contents in diagnostics.

## Shared generation and provider boundary

Add an experimental optional opaque session-affinity hint to the shared generation request and a corresponding advertised capability, normalized at the dispatcher. Unset means no preference; requesting it from an unsupported adapter fails before dispatch. Namespace the opaque key by plugin, conversation and selected connection/configuration, without transmitting BB thread names or raw IDs. Model changes begin a different session key.

Pi maps the hint to its runtime sessionId only for verified compatible model routes. Advertise exact reasoning capabilities conservatively, and validate before invoking Pi so its effort clamping cannot silently replace an unsupported request. An explicit none must become the provider's actual off/none setting; a default request retains the adapter's documented existing behavior.

OpenRouter generation uses a native Pi connection-owner routing setting, `Provider default` or `Lowest latency`, exposed in its UI/CLI/SDK. The pilot selects Lowest latency, exact DeepSeek1017 none or Qwen3.8 27B none, requires supported parameters and disables provider fallback for attributable measurements. Credentials remain in the existing Pi host-local credential mechanism; neither Prompt Suggestion nor Gateway receives or stores them.

The affinity capability and hint flow through native dispatch and Gateway's documented compatible field rather than a Prompt-only route. Update the SDK audit and Plugin Guide. New server/daemon wire fields require the daemon protocol version bump and compatibility verification mandated by AGENTS.md; a shared TypeScript build alone is not sufficient.

Stable input/session identity is a cache opportunity, not a guaranteed cache hit or dedicated model instance. Measure reported cached tokens; unreported cache use and upstream provider identity stay unknown. Do not infer a served Fast tier or a pinned upstream route from the request settings.

## Verification and release boundary

Deterministic tests cover duplicate events/multiple consumers, committed completion, input after pending, late stale results, question/approval and queue transitions, out-of-order invalidation, lease expiry, bounded eviction, background versus foreground priority, settings/disposal, one-call admission and none/error reuse. Real database checks use migrated SQLite; no mocked database.

A real isolated BB browser verifies ready-on-return, pending attachment, none/error, multiple mounted composers and compact/mobile Chromium layout, plus unchanged Tab/Enter behavior. Do not claim iOS device verification without running it. Focus and input changes must not restart or invalidate a still useful shared generation for other clients.

Transport verification inspects exact synthetic outgoing model/reasoning/session/routing/output-limit fields and cancellation with no secrets in logs. Build/typecheck/test through Turbo for the affected packages, then independent change review before integration.

The separately approved paid pilot compares DeepSeek1017 none with Qwen3.8 27B none using identical synthetic Russian conversations and short/long contexts, including task completion, unresolved choices and contradictory final failures. Keep routes/modes/cache conditions separate. Measure full valid JSON and visible candidate p50/p90, useful-result coverage, correct abstention, invalid/error rate, input/output/reasoning tokens and reported cache use. Never treat timeout or none as a successful fast suggestion. No model is selected for production solely from published TTFT.

The implementation proposal retains the existing session hourly cap and one admitted inference per generation key within its one-hour admission window. No benchmark spending cap or credential use is approved by this draft. Resolve those only when preparing a concrete pilot. Releasing remains a separate owner action; the standing instruction is do not release.

## Evidence

- Local sources: `plugins/prompt-suggestion/{app.tsx,server.ts,src/context.ts,src/controller.ts,src/contracts.ts}`, SDK lifecycle/RPC/composer contracts, `plugins/provider-pi/src/ai/`, and installed Pi 0.84.4 types/OpenRouter translation.
- Source architecture: `docs/system-overview.md`, Next-message suggestions and Shared AI generation.
- Public model research: thread-storage `suggestion-latency-quality-research.md` and `suggestion-public-ttft.json`; these do not establish mode-matched Russian quality.
- [OpenRouter caching/session behavior](https://openrouter.ai/docs/guides/best-practices/prompt-caching).
- [OpenRouter latency definitions](https://openrouter.ai/docs/guides/best-practices/latency-and-performance).
- [OpenRouter routing behavior](https://openrouter.ai/docs/guides/routing/provider-selection).
