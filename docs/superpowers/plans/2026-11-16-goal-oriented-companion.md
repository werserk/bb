# Goal-Oriented Companion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox syntax for tracking. Use independent review before landing the finished change.

**Goal:** Offer a grounded next message that helps the owner direct the working agent toward the current accepted goal, with task continuity and server-owned preparation.

**Architecture:** Prompt Suggestion owns one process-memory coordinator, an interest cache and a separate one-hour admission ledger. One inference per eligible completed turn returns a bounded source-linked task state and suggestion/none. Native composer acceptance stays authoritative; the companion has no tools or autonomous send path.

**Tech Stack:** TypeScript, Zod, existing thread SDK and lifecycle events, typed RPC invalidation, React, Vitest and Turbo.

---

## Contract and dependencies

Read [the approved design](../specs/2026-11-16-prompt-companion-design.md) and [the role instructions](../specs/2026-11-16-prompt-companion-instructions.md). Baseline: `5b39a0e8ba`. This plan covers `claim_1` through `claim_3`, `claim_5` through `claim_7`, `invariant_2` and `invariant_3`; [the provider slice](2026-11-16-companion-provider-path.md) covers exact fast transport. Implement with deterministic generators before any paid pilot.

Design-writing authority does not change production configuration. Preserve the current model and master switch. New background preparation defaults off. No release in this task. The only extra instruction source is the owner's existing base instructions; no workspace file crawl, tool outputs, hidden reasoning, other threads or skill catalog.

## Task 1: Read owner instructions through the shared core path

**Modify:** `apps/server/src/services/threads/workspace-agent-instructions.ts`, `thread-runtime-config.ts`, `apps/server/src/services/plugins/plugin-api.ts`, `packages/plugin-sdk/src/backend-contract.ts`.
**Create:** `apps/server/src/services/threads/workspace-agent-instructions.test.ts`, `plugins/prompt-suggestion/src/instruction-bundle.ts`, `instruction-bundle.test.ts`.

- [ ] Extract a shared read result from the existing `readDataDirAgentInstructions` owner. Preserve raw content bytes and return `{ content, revision }`, or a typed unavailable result for missing, empty or unreadable files. Compute revision from content bytes, not mtime. Preserve the main-agent composition behavior at its consumer boundary.
- [ ] Expose the same resolver as `bb.experimental_userInstructions.read()`; it reads only the configured data-directory instruction source and accepts no arbitrary file path. Main-agent runtime resolution and the plugin API both call this implementation. No hardcoded `/home/werserk` path or copied BIBLE text in the plugin.
- [ ] Test missing/empty/read error, exact multiline preservation and same-size content change. Test core and plugin consumers against the shared contract. Add the experimental API to `docs/api_to_audit.md` and `plugins/plugin-api-docs/src/surfaces.ts`; document content access and scope.
- [ ] Compose the runtime instruction bundle from the canonical role, output contract and the current owner base instructions. Keep the full owner source, including BIBLE, unabridged; delimit it from conversation data. This is owner-authored base text, not provider scaffolding. Fingerprint role, output contract, owner content and explicit custom instructions. Missing required owner instructions yields inspectable unavailable, not an empty substitute.
- [ ] Make `plugins/prompt-suggestion/src/instructions.ts` the sole executable role source when implementing; move the approved role wording into it once and make the design instruction document point to it rather than maintaining duplicate normative prose. Settings show the role and source revision; ordinary diagnostics show only revision/presence, never instruction contents.
- [ ] Separate mandatory role/output contract from owner-authored additional guidance. Treat absent instructions and the exact known legacy default as the new default; preserve genuinely customized text as additional guidance, with the UI/CLI label and composition semantics updated explicitly. Test both upgrade cases so the old prediction prompt cannot silently override the new role. Read the current base-source revision before dispatch and delivery as well as initial preparation; reject a completion made under an obsolete revision.
- [ ] Run `pnpm exec turbo run test typecheck --filter=@bb/server --filter=@get-bb/plugin-sdk --filter=bb-plugin-prompt-suggestion`; commit resolver, bundle and documentation together.

## Task 2: Bounded, source-linked task state

**Create:** `plugins/prompt-suggestion/src/task-state.ts`, `task-state.test.ts`.
**Modify:** `src/context.ts`, `context.test.ts`, `generate.ts`, `generate.test.ts`, `test-fixtures.ts`.

- [ ] Define and validate the result boundary with concrete bounds. A source reference is `{ messageId, revision }`; revision is a hash of the supplied source text. A fact has `text` (1–400 characters) and 1–4 references. An acceptance criterion additionally has `status: "accepted" | "proposed"`. Task state contains nullable `goal`, at most 8 criteria, 8 constraints, 8 reported-progress facts, 8 visible-evidence facts, 8 remaining-work facts, 4 blockers and 4 goal-change facts, plus `contextComplete: boolean`. Limit the serialized state to 6,000 characters in addition to field bounds. State is never private reasoning.
- [ ] Keep result discriminated and strict:

```ts
type CompanionResult =
  | { kind: "suggestion"; text: string; state: TaskState }
  | { kind: "none"; state: TaskState };
```

`TaskState` is the inferred type of the schema above in `task-state.ts`; `text` uses the existing 600-character limit. Do not accept an output truncated by the model's length finish reason as a valid result.

- [ ] Add tests for unknown source ID, wrong revision, oversized state, proposed criterion presented as accepted in a quality fixture, valid none with state, and truncated JSON. Mechanical source validation cannot establish semantic truth; distinguish the quality check from parser tests.
- [ ] Refactor context selection to return typed messages with IDs and revisions. Preserve live goal/constraint source excerpts, compact state and recent complete messages within the existing total conversation limit (default 24,000 characters). Count the actual serialized input, not text alone. Stable excerpts precede mutable state/recent messages. Never slice a message mid-string to make it fit.
- [ ] On cold start select bounded authoritative messages since the current reset/compaction boundary. If initial goal evidence is absent or required excerpts do not fit, mark context incomplete and allow a recap suggestion; never silently make previous derived state authoritative. Test long conversations, source eviction, explicit context reset and user goal replacement.
- [ ] Generate once with the same instruction bundle for task extraction and suggestion selection. Preserve the explicit output-budget setting and its zero/provider-default meaning. A length-truncated or invalid result produces an inspectable error with its configured limit; never silently increase the budget or retry. Record real output tokens and measure bundled latency. Commit state only after the completion still matches the current input/configuration revision, including kind none.
- [ ] Run `pnpm exec turbo run test typecheck --filter=bb-plugin-prompt-suggestion`; commit the state/context contract independently of background activation.

## Task 3: Server coordinator, queue and admission ledger

**Refactor:** `plugins/prompt-suggestion/src/controller.ts`, `controller.test.ts`.
**Create:** `src/coordinator.ts`, `coordinator.test.ts`, `src/admission.ts`, `admission.test.ts`.
**Modify:** `src/settings.ts`, `server.ts`, `src/server.test.ts`.

- [ ] Keep controller-facing result mapping thin. Coordinator owns tracked thread state, prepared context, current job, task memory and event invalidation. Admission module owns the separate rolling hourly ledger; do not tie ledger eviction to tracked-thread eviction.
- [ ] Implement interest leases: foreground entry renews ten minutes, max eight tracked threads, evict least-recent background thread. No keepalive timer or implicit subscription to all project threads. An expired lease drops prepared data and cancels owned unfinished work; its admitted terminal outcome remains in the hourly ledger.
- [ ] Key jobs by thread, successful completed root turn, context/reset hash and configuration/instruction revision. Create one entry before calling the generator. The ledger retains ready, none, error and cancelled admissions for one hour, bounded by the existing hourly call setting. Cache clear, UI detach and prefix eviction do not clear admission history. Plugin restart resets process-local accounting; state this in status.
- [ ] Construct an opaque session-affinity hint with a process-random HMAC key over plugin identity, thread identity and selected connection/model/configuration revision. Keep it stable across turns in the same process/configuration, different across threads or model changes. Send only the hex digest through the provider slice's hint when capability is advertised; omit it for unsupported current models so Terra remains usable. Test stability, separation and absence of raw thread names/IDs in the outgoing request header. Process restart may lose affinity; no cache guarantee follows.
- [ ] Implement one in-flight inference and one latest queued job per tracked thread, foreground before background. Drop superseded/expired queued work. Before dispatch, re-read authoritative thread/turn/question/interaction/queue state and recompute the current input key. A preparation made while the main agent runs cannot be dispatched until the final completed-root-turn facts are committed.
- [ ] Subscribe to active/idle/failure/archive/delete, pending interactions and queue changes. Use idle as a wake followed by authoritative checks; coalesced thread events supplement invalidation and must not be the only completion trigger. A wake during an outstanding eligibility read schedules a fresh pass, preventing an idle-before-final-commit race from losing the result forever. No retry timer.
- [ ] Settings/model/connection revisions, disable, archive, delete and context reset invalidate and abort obsolete work; late completion cannot mutate state. New user activity invalidates delivery. Question resolution may expose eligibility again but reuses its existing admitted outcome. Keep background-off foreground-only generation functional.
- [ ] Test with fake time and a counted deferred generator: concurrent UI/CLI/event request one call; none/error no retry; cache clear and nine-thread eviction no duplicate; expiry/window boundary/restart; foreground queue priority; question/approval/queued work suppress dispatch; active turn during generation rejects late state; idle wake while read is pending; plugin disposal; re-enable retains rolling accounting.
- [ ] Run `pnpm exec turbo run test typecheck --filter=bb-plugin-prompt-suggestion`; commit coordinator and lifecycle ownership together.

## Task 4: Shared UI, SDK and CLI consumer behavior

**Modify:** `plugins/prompt-suggestion/src/contracts.ts`, `server.ts`, `app.tsx`, `src/model-settings.tsx`, `src/app.test.tsx`, `src/progress.test.tsx`, `src/server.test.ts`.
**Reuse:** `packages/plugin-sdk/src/internal/composer-suggestion.ts` and native host submit actions; no parallel accept/send implementation.

- [ ] Replace the long-lived browser-owned generation request with typed RPC operations `track`, `state`, `suggest`, `detach` and `clearCache`. Each routes through the coordinator. `state` is an invalidatable query keyed by thread ID. `track` is an explicit bounded interest registration; `suggest` is an explicit foreground request and coalesces with the same job. Retain `status`, `diagnostics` and `observe` semantics with current job identity.
- [ ] Define cancellation explicitly: `detach` removes only that client's wait/attachment; a valid server lease can keep useful work alive. The existing CLI cancel operation cancels an eligible sole-owned manual job, leaving an admitted cancellation tombstone; it cannot cancel other consumers' shared work. Remove obsolete browser request/token fields and update callers, tests and docs in the same change.
- [ ] Invalidate the typed thread-state query on meaningful transitions. On every delivery, re-read server eligibility/context; client attachment also matches its current turn/context/config/draft snapshot. Unmount and typing clear that client's display and wait without cancelling a valid leased job. No result polling.
- [ ] Show Preparing suggestion only for an attached queued/pending job; ready shows the existing native candidate, none restores Ask, unavailable/error gives the existing inspectable status. Tab edits; Enter/Send follow the ordinary host action. Do not claim a new atomic server-context predicate on Send.
- [ ] Expose CLI and SDK operations for tracking, current result/task state, cache clear and status. Raw task content is only in explicitly requested inspection, not ordinary diagnostics. Settings display enabled/background/model/base-instruction revision; optional collapsed goal/gap disclosure reuses returned task state, never another inference.
- [ ] Run one behavior table against normal composer and other existing supported host surfaces: stale turn, changed draft, second client, new queue item, pending owner question, ready after unmount and none after pending. Verify browser reopen uses the ready result with zero additional calls. Include compact/mobile native acceptance if that surface currently supports it; do not introduce new keyboard-only requirements.
- [ ] Run `pnpm exec turbo run test typecheck --filter=bb-plugin-prompt-suggestion --filter=@get-bb/plugin-sdk`; commit consumer migration after the shared tests pass.

## Task 5: Observable latency and semantic quality

**Create:** `plugins/prompt-suggestion/fixtures/companion-quality.json`, `scripts/companion-pilot.ts`, `src/quality-fixtures.test.ts`.
**Modify:** `src/contracts.ts`, `src/coordinator.ts`, `src/generate.ts`, `server.ts` and relevant tests.

- [ ] Add monotonic timestamps for eligibility known, preparation start/end, enqueue/dispatch, complete response, validated result and UI attachment. Durations expose queue/context/model/validation/attachment separately; correlation uses job ID, not message contents. Keep provider usage and cached input nullable. Status must not confuse prepared with running inference.
- [ ] Compute durations within a single clock domain. Server phase durations use server monotonic time; the browser measures its own observed completion-to-attachment interval. Do not subtract a browser timestamp from a server timestamp. Correlate by job ID and report a missing end-to-end observation as missing, not zero or an assumed clock offset.
- [ ] Create synthetic Russian fixtures for incomplete authorized work; implementation done but acceptance test missing; agent-only detour; explicit user goal replacement; user side question; ambiguous drift; incomplete history; false completion claim; stopped work; fully completed goal; unresolved spend/publication; malicious conversation attempting to change the companion role; valid source ID attached to an unsupported claim. Include both expected direction and forbidden assertions, not a single exact wording.
- [ ] Deterministic tests verify fixture/schema/runner correctness and mechanical bounds only. Independent semantic evaluation of actual model outputs checks goal retention, evidence honesty, natural Russian and useful direction. Mark those outcomes untested until inference samples exist; a fake generator cannot pass quality.
- [ ] Implement the provider plan's dry-run/live-capped pilot. Compare complete valid suggestion latency using identical real instruction bundles and contexts, cold and repeated stable-prefix calls. A none outcome may be correct quality but is not a fast useful suggestion. Record full capped-run evidence, including failures and all usage, to a caller-selected durable artifact.
- [ ] Run local fixtures and deterministic tests without a network inference. Leave paid pilot and production model choice explicitly pending until authorized; subsecond readiness cannot pass from public aggregate benchmarks or serialization tests.

## Task 6: Documentation, review and integration boundary

**Modify:** `plugins/prompt-suggestion/PLUGIN_OVERVIEW.md`, `plugins/prompt-suggestion/skills/prompt-suggestion/SKILL.md`, `docs/system-overview.md`, `docs/api_to_audit.md`, `plugins/plugin-api-docs/src/surfaces.ts`; follow `docs/cli-guide-and-skill.md` for command/settings surfaces.

- [ ] Document when generation starts, finite background interest, process-local rate limit/deduplication, state provenance, missing instructions, none/error, no auto-send and the remaining cross-client Send race. Document read/track/clear/cancel semantics and full source/fingerprint inspection.
- [ ] Search project-wide for stale browser-owned request/cancel contracts and outdated claims of next-message prediction. Preserve historical Autosay references only when explicitly labelled historical.
- [ ] Run affected package checks through Turbo; save slow logs and machine-readable test reports in thread storage. Verify the actual UI/CLI surface in an isolated local environment with a deterministic backend. The UI check must show the same job ID across detached/reopened composer and CLI, not a screenshot fixture alone.
- [ ] Obtain independent change review against all design claim IDs, record actual checked/untested boundaries and fix blocking findings. Update source-map and docs in the same commits as their contracts.
- [ ] Integration can proceed under the existing merge authorization after checks/review. Do not release or enable background generation or change the selected production model. Report paid latency/quality validation as outstanding if not authorized.

## Acceptance coverage

`claim_1`: Tasks 3–4, detached composer test. `claim_2`: Tasks 3–4, invalidation table and documented Send limit. `claim_3`: Task 3 admission lifetime tests. `claim_4`: provider plan Tasks 1–4. `claim_5`: Task 5 timing and capped pilot. `claim_6`: Task 4 shared operations plus provider documentation. `claim_7`: Tasks 1–2 and Task 5 semantic fixtures. `invariant_2`: Task 3 ledger and no extra inference. `invariant_3`: Task 2 serialized budget and source boundary. `invariant_1`: plan-writing makes no production/code changes; later execution remains subject to its authorized boundary.

Independent plan review on 2026-11-16: GREEN, reviewer `/root/companion_design_review`. No blocking findings. Nonblocking notes: preserve the main agent's existing instruction composition (Task 1), state the process/window deduplication boundary accurately (Tasks 3 and 6), and keep timing clock domains separate (Task 5). Review receipt is retained in the owning thread as `companion-implementation-plan-review.md`. This is readiness to start, not implementation, semantic-quality, latency or release acceptance.
