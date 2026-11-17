# Composer Prompt Helper Implementation Plan

> **For agentic workers:** Use subagent-driven-development task-by-task; parent owns all executable checks and release operations. Do not run paid inference experiments.

**Goal:** Ship the approved inline A helper: meaning-preserving draft improvement, separate optional advice, explicit preview/application, and next-step assistance for an empty thread composer.

**Architecture:** Prompt Suggestion owns manual role generation through the existing shared dispatcher and admission ledger. Core owns inline composer contributions and scoped automatic-suggestion suspension; the existing synchronous composer.replace updater is the only draft mutation path. No daemon wire or storage schema change is required for the helper.

**Tech Stack:** TypeScript, React, Zod, Plugin SDK, Turbo/Vitest, existing fork candidate/release tooling.

## Authority and invariants

Owner request on 2026-11-17 authorizes implementation and release `now`, superseding the previous release hold. Paid pilot requests remain exhausted; no model/credential/settings switch is authorized. Release uses the private downstream runbook, never upstream npm publishing. Compare with current fork/main before integration so newer changes are retained.

- claim_ui: inline A inside the composer on desktop/mobile; isolated screenshot verification plus mounted component tests.
- claim_intent: helper instruction contract preserves owner intent and separates advice; deterministic schema/prompt tests, no claim of live model quality without a paid pilot.
- claim_apply: only explicit apply updates draft; immutable captured draft comparison plus context check; preserve attachments and protected mention identities; no sending.
- claim_budget: helper, foreground and memory share hourly admission; manual helper works while auto is disabled and preempts memory; cancellation/reset/disposal checks.
- claim_surfaces: RPC and CLI share helper service; core and plugin share composer mutation and rendering paths.

## Task 1 — Backend helper and shared budget

Files: plugins/prompt-suggestion/src/{helper,helper-context,helper-contracts}.ts as needed; generate.ts, instruction-bundle.ts, controller.ts, coordinator.ts, contracts.ts; plugins/prompt-suggestion/server.ts; corresponding tests and plugin skill/overview.

- [ ] Add strict helper input {threadId,requestId,token,draft,expectedContextRevision,protectedMentions}; bound draft to12000 codepoints. Preserve protected mention tokens supplied in draft as data, never instructions. Tokens use <<BB_MENTION_${requestId}_${index}>>; require each exactly once, reject literal collisions and unknown tokens before applying.
- [ ] Add helperContext({threadId}) => {revision:string|null}. Include current conversation, context boundary, owner instruction and configuration revision in snapshot identity; exclude unrelated lifecycle telemetry. Manual mode permits active and no-history thread contexts, not only completed turns. Empty history plus empty draft returns none.
- [ ] Return {kind:'helper',text,advice,contextRevision}, {kind:'none',contextRevision}, or typed unavailable. Text max16000 codepoints, advice max2000 or null; enforce complete stop and bounded body. Use provider-default output limit for manual role instead of automatic short cap; no silent fallback or retry.
- [ ] Reuse full BIBLE source; unsent draft is not accepted task evidence. Share request ledger, prioritize helper over memory, and retain capability-based cancellation. Add separate helper counters.
- [ ] Register helper/helperContext RPC and helper CLI --thread --draft --request --token; reuse cancel. Tests: disabled auto, invalid input, absent history, rate saturation, cancellation, context/config change, incomplete output, reset/disposal, budget priority, strict advice separation and full BIBLE.

## Task 2 — Shared inline renderer and plugin UI

Files: packages/plugin-sdk/src/app-contract.ts and internal composer registration/suggestion controller; SDK harness; apps/app composer contributions; plugins/composer/src/PromptBoxInternal.tsx; plugins/prompt-suggestion/app.tsx, src/prompt-helper.tsx and mention helpers/tests; docs/api_to_audit.md, plugins/plugin-api-docs/src/surfaces.ts.

- [ ] Add experimental inline composer panel contribution, rendered inside editor border above draft, including compact layout. The existing toolbar action owns the button; an inline panel owns preview rendering. A WeakMap keyed by the shared mounted suggestion controller synchronizes only open/request state, because useComposer handles are per-hook. Two same-thread composers remain independent. Add scoped automatic-suggestion suspension with disposal; native accept/render path respects the same suspension.
- [ ] Use helperContext then helper RPC with exact request/token. Loading leaves draft editable; apply is disabled after draft or meaningful context changes. Before apply revalidate server revision and compare captured composer key/context/draft in composer.replace(current=> current===captured ? replacement : current).
- [ ] Encode structured mentions as collision-safe protected tokens. Require every original token once, reject unknown tokens, restore exact mention identities/UTF16 ranges. Omit attachments in replacement to preserve them.
- [ ] Render Improved request/Next step, optional Advice, Replace draft/Insert, Try again, Dismiss. Never bind Send/Enter to preview acceptance. Suppress ghost only while helper open and restore after close. Cancel on unmount/thread switch, ignore late responses. No-thread new-composer remains unsupported initially; thread drafts with no history are supported.
- [ ] Tests: keyboard/touch buttons, draft edit race, changed context, late responses, mentions/attachments, dismissal, suspension release, compact full-width layout, no automatic send, unavailable model/error/retry/none.

## Task 3 — Verify and review

- [ ] Parent uses Node22 at /home/werserk/.local/share/bb-fork/node22/node-v22.19.0-linux-x64/bin with Turbo. Run plugin typecheck/test/lint/bundle, SDK relevant contract tests, app/composer typechecks and focused mounted tests. Save logs in thread storage. No native dependency rebuild under another Node version.
- [ ] Update system architecture and SDK audit/guide; read final diff against every claim. Independent spec and quality reviews must close actionable findings before integration.
- [ ] Build isolated candidate and exercise actual composer with deterministic local generator in isolated data directory only. Capture desktop/mobile rendering and apply race evidence. No fake result may be presented as real model quality or installed latency.

## Task 4 — Release

- [ ] Read /home/werserk/Projects/bb-plugin-lab/docs/bb-fork/runbook-release.md and ops/bb-fork tools. Verify current daily pointer/version/source and fork/main. Integrate reviewed work retaining intervening changes; rerun affected checks on integrated source.
- [ ] Build source-pinned candidate through existing build-candidate tool; verify bundled Prompt Suggestion and provider changes are included and install state is retained. Run dry-run preflight.
- [ ] Release with --now and exact owner authorization note through the canonical fork tool. This interrupts daily turns; preserve evidence and handoff before command. End turn as required by release lifecycle; verify receipt/current pointer and installed feature after restart before claiming release succeeded.

## Self-review

All accepted UI behavior maps to tasks 1–2 and executable checks in task3. Existing unreleased companion/provider changes also enter the candidate and need integrated verification. Active-stream context invalidation must exclude irrelevant telemetry to avoid permanently stale previews. No paid calls, credential changes or unrelated runtime settings are part of these tasks.

Plan review: helper_plan_review GREEN; notes incorporated for root server path, per-mounted shared state and token collisions. No new helperOutputTokenLimit setting is added: the manual role uses provider-default output cap and documents the distinction from the automatic cap.
