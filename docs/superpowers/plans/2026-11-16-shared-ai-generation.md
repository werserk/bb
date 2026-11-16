# Shared AI Generation Implementation Plan

> For agentic workers: use subagent-driven-development for bounded implementation tasks and independent reviews. Do not pause between authorized reversible tasks.

**Goal:** Release a shared model-generation service, compatible text gateway and renamed Prompt Suggestion consumer.

**Architecture:** Extend the existing AI service registry and SDK. Provider plugins retain host-local model/auth execution. AI Gateway exposes a strict OpenAI text subset; Prompt Suggestion calls the native service directly.

**Tech Stack:** TypeScript, existing plugin SDK/host RPC, Zod, Hono, React, Turbo/Vitest.

## Task 1: Shared contract and dispatcher

Files: packages/plugin-sdk/src/backend-contract.ts, new focused AI contract/validation modules, internal/host-policy.ts, testing host; apps/server/src/services/ai and services/plugins/plugin-api/runtime.
- [x] Define experimental model descriptors, text messages, supported options and nullable usage with stable host/profile-bound model identity.
- [x] Extend existing registrations with optional experimental text-model capability. Preserve legacy registrations.
- [x] Implement validated models/generate methods, bounded cancellation/concurrency and exact-model dispatch.
- [x] Route core native helper calls through the common dispatcher; legacy selection behavior remains external and cannot be entered by explicit calls.
- [x] Test all consumer entry paths with one contract table and failure modes; update audit and Plugin Guide.

## Task 2: Provider adapters

Files: plugins/provider-pi/{server.ts,src/host.ts,src/ai/*,package.json}; plugins/provider-codex/src/{ai-service.ts,host.ts,ai/*}; package lock.
- [x] Add direct Pi ModelRuntime host catalog and tool-free generation with same native root/auth context.
- [x] Add explicit Codex generation and matching primary-host catalog; reject unsupported custom routes and controls.
- [x] Keep provider credentials local; report actual finish/usage only.
- [x] Verify cancellation, invalid model, account/catalog binding and packaged runtime dependencies.

## Task 3: AI Gateway

Files: plugins/ai-gateway/{server.ts,app.tsx,src/*,skills/*,package.json}; apps/server/src/routes/plugins.ts and auth tests.
- [x] Add tested Bearer token support to core plugin-token authentication without weakening existing auth.
- [x] Add bounded GET models and POST chat/completions through shared SDK; non-stream text only, exact error shapes, reject unsupported inputs before dispatch.
- [x] Add settings/readiness/Base URL/model display and CLI model listing/generation; reuse native token UI.
- [x] Verify unchanged OpenAI SDK requests in isolated lab; no transcript/secret logging.

## Task 4: Prompt Suggestion

Files: plugins/autosay renamed plugins/prompt-suggestion; current docs, package lock and guide pointers.
- [x] Replace direct HTTP config/generator with selected native model and shared API.
- [x] Add supported model picker with connection identity and unavailable-state handling.
- [x] Retain instructions, context bounds, request cancellation and accepted composer behavior.
- [x] Search all runtime references for stale name; preserve archived release history explicitly.
- [x] Check old installed config and disable old plugin before new activation.

## Task 5: Verification/release

- [x] Run relevant Turbo tests/typecheck/lint; independent spec and quality review; resolve findings.
- [x] Run isolated actual UI + unchanged external client contract + bounded real-provider smoke with synthetic text.
- [ ] Package and verify dependency closure, installed base ancestry and model identity.
- [ ] Commit/push reviewed changes; install plugins; use maintained release tool and verify receipt.
- [ ] Keep Prompt Suggestion disabled until owner selects its generator; do not infer paid model preference.
