# Companion Provider Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox syntax for tracking. Use independent review at the contract and finished-change boundaries.

**Goal:** Make exact reasoning-off, session affinity and latency routing available through BB's existing authenticated Pi/OpenRouter generation path.

**Architecture:** Keep provider translation and credentials in Pi's host runtime. Normalize generic capabilities in the native dispatcher and reuse that path from AI Gateway. Prompt Suggestion consumes the resulting capability without owning provider credentials or HTTP transport.

**Tech Stack:** TypeScript, Zod, Plugin SDK, Pi 0.84.4 runtime, Vitest and Turbo.

---

## Scope and evidence

This is the provider slice of [the approved design](../specs/2026-11-16-prompt-companion-design.md), specifically `claim_4`, `claim_5`, `claim_6`, `invariant_2` and `decision_2`. The [companion plan](2026-11-16-goal-oriented-companion.md) is the second slice. Both plans are preparation; production settings, paid requests and release remain unchanged. Source baseline is `5b39a0e8ba`.

Current evidence: `plugins/provider-pi/src/ai/runtime.ts` uses authenticated `ModelRuntime`, tools `[]`, retries `0`, but rejects explicit reasoning; `service.ts` advertises no reasoning choices. The installed adapter supports `sessionId`, `thinkingLevelMap` and `compat.openRouterRouting`. Use its actual serializer in tests: assigning a field in our wrapper is insufficient evidence of the provider payload.

The reusable transport must remain independent of the companion role, task-state schema and BIBLE. No database migration or new credential store is needed.

## Task 1: Generic session-affinity contract

**Modify:** `packages/plugin-sdk/src/ai-generation.ts`, `packages/plugin-sdk/src/internal/ai-generation.ts`, `packages/plugin-sdk/src/internal/ai-generation.test.ts`.

- [ ] Add failing dispatcher cases: old adapter without the capability accepts omitted/null affinity; requesting affinity on that adapter fails before its generator runs; capable adapter receives the exact normalized hint; whitespace-only and over-limit hints fail parsing.
- [ ] Add the public request and capability fields, retaining optionality only at the external boundary:

```ts
experimental_sessionAffinity?: string | null;
```

```ts
experimental_sessionAffinity?: boolean;
```

- [ ] Normalize request hint to `null` and capability to `false` once in dispatcher Zod schemas. The request schema is `z.string().trim().min(1).max(256).nullable().default(null)`. Internal service request/model intersections require these fields. Reject a non-null hint with capability false using the existing `unsupported` error path. Update service implementations and typed test fixtures so normalization is not repeated downstream.
- [ ] Run `pnpm exec turbo run test typecheck --filter=@get-bb/plugin-sdk`; verify old adapters still work without the new option. Commit the contract and its behavior tests together.

## Task 2: Pi capabilities and exact translation

**Modify:** `plugins/provider-pi/src/ai/contract.ts`, `runtime.ts`, `runtime.test.ts`, `service.ts`, `service.test.ts`.
**Create:** `plugins/provider-pi/src/ai/options.ts`, `plugins/provider-pi/src/ai/options.test.ts`.

- [ ] In the host contract, carry required normalized affinity plus the advertised reasoning-effort array and affinity boolean. Preserve the native model ID, profile and host selection. Do not infer capabilities solely from the displayed model name.
- [ ] Write a behavior table covering a non-thinking model, an optional-thinking OpenRouter model whose off mapping is valid, a mandatory-thinking model whose off mapping is null, and a non-OpenRouter model. Unsupported explicit effort must fail before `completeSimple`; Pi's internal effort clamping cannot satisfy this test by silently choosing another effort.
- [ ] Implement one options resolver used by both model advertisement and generation. Derive supported efforts from installed model metadata and verified adapter semantics. Expose `none` only when the actual request can disable reasoning. Preserve existing provider-default behavior for a null effort. Do not widen temperature or service-tier capabilities as incidental work.
- [ ] Add an adapter-level synthetic request test using Pi's serializer with intercepted transport. For explicit `none`, assert the final OpenRouter JSON has `reasoning.effort === "none"`; also assert the selected exact model, absent tools and absent provider credentials from diagnostic output. A wrapper-options mock alone does not pass this gate.
- [ ] Forward non-null affinity to Pi `sessionId` only on compatible routes. Assert the resulting `x-session-id` header equals the opaque hint; reject hints on unsupported routes. Keep retries zero, caller cancellation and timeout behavior.
- [ ] Run `pnpm exec turbo run test typecheck --filter=bb-plugin-provider-pi`; commit the translation and request-evidence tests.

## Task 3: Connection-owner routing controls

**Create:** `plugins/provider-pi/src/ai/settings.ts` and `plugins/provider-pi/src/ai/settings.test.ts`.
**Modify:** `plugins/provider-pi/server.ts`, `plugins/provider-pi/app.tsx`, `plugins/provider-pi/src/ai/service.ts`, `contract.ts`, `runtime.ts` and their affected tests.

- [ ] Register a Pi-owned native-generation routing setting with exact values `default` and `lowest-latency`; default remains `default`. Expose the same setting through plugin settings UI and CLI, including readback. Do not change agent-turn provider routing as an undocumented side effect.
- [ ] Resolve the setting on the server, pass it explicitly through the Pi host contract, and apply it only to OpenRouter native generation. Non-OpenRouter routes keep their native behavior; their status must say the OpenRouter setting is inapplicable.
- [ ] In lowest-latency mode, create a request-local model compatibility override, preserving the catalog object and existing compatible metadata:

```ts
const openRouterRouting = {
  sort: "latency" as const,
  require_parameters: true,
  allow_fallbacks: false,
};
```

- [ ] Test exact outgoing `provider` payload, default-mode preservation, immutable catalog model and settings changes between calls. Record routing mode in non-sensitive diagnostics; never label it guaranteed provider selection or latency.
- [ ] Increment `HOST_DAEMON_PROTOCOL_VERSION` from the then-current value in `packages/host-daemon-contract/src/protocol.ts`; update `test/contract.test.ts`. Baseline is 267, so 268 is correct only if no intervening change has bumped it. New host fields and meanings are incompatible with the previously shipped daemon and must trigger its update.
- [ ] Run `pnpm exec turbo run test typecheck --filter=bb-plugin-provider-pi --filter=@bb/host-daemon-contract`; commit settings and wire compatibility together.

## Task 4: Gateway and discoverable API

**Modify:** `plugins/ai-gateway/src/chat.ts`, `chat.test.ts`, `gateway.test.ts`, `plugins/ai-gateway/server.ts`, `plugins/ai-gateway/skills/ai-gateway/SKILL.md`, `docs/api_to_audit.md`, `plugins/plugin-api-docs/src/surfaces.ts`.
**Also inspect/update:** Pi's existing skill and plugin overview, `docs/system-overview.md`, and the applicable surfaces enumerated by `docs/cli-guide-and-skill.md`.

- [ ] Accept optional `prompt_cache_key` in the Gateway Chat Completions schema and map it to the generic affinity hint. Document this compatibility field as best-effort affinity, not a cache guarantee. Native callers and Gateway must reach the same dispatcher and strict capability checks.
- [ ] Use a table to verify omitted key, valid key, too-long key and unsupported-model key through HTTP and native generation. Preserve Gateway's existing text-only, non-streaming scope and error translation. No implication of full OpenAI API support.
- [ ] Document public experimental members, defaults, unsupported behavior, core/shared callers and stabilization criteria in the API audit and Plugin Guide. Document Pi CLI routing selection and default behavior. Update the architecture map to show a single native generation path.
- [ ] Run `pnpm exec turbo run test typecheck --filter=bb-plugin-ai-gateway --filter=bb-plugin-provider-pi --filter=@get-bb/plugin-sdk`; review and commit this slice.

## Task 5: Prepare bounded pilot without spending

**Create:** `plugins/prompt-suggestion/scripts/companion-pilot.ts`, `plugins/prompt-suggestion/fixtures/companion-quality.json` during the companion slice; provider slice supplies exact synthetic request capture tests above.

- [ ] Make dry-run the pilot default. It validates fixture IDs, selected native model IDs and required capabilities and prints the planned call count; it sends no inference request. Live mode requires explicit call/token caps and an output artifact path, and stops at either cap. It uses the BB native API and existing Pi credentials, never a new key field.
- [ ] Prepare paired exact models `deepseek/deepseek-v4.1-flash-1017` and `qwen/qwen3.8-27b`, explicit none, lowest-latency route and no fallback. Resolve their current opaque BB IDs from the catalog when executing; absence is an unavailable result, not a substituted model.
- [ ] Record queue, preparation, model-call, validated-result and visible-attachment times separately; use nullable usage/cache counters when unavailable. Compare actual full instruction/state output with the old text-only baseline. None/error/timeout are distinct outcomes, never successful fast suggestions.
- [ ] Keep live execution blocked until an accessible OpenRouter connection and a concrete owner-approved spend/call bound exist. This blocks only the paid pilot and production model choice, not local implementation or synthetic tests. Do not ask the owner to reapprove the accepted design.

## Completion boundary

Provider completion requires passing dispatcher, Pi serializer, routing, Gateway and daemon-version checks plus independent change review. The native path is usable even without enabling companion background generation. No subsecond claim follows from synthetic tests; no release, provider switch or paid pilot is included in this plan-writing step.

## Execution receipt

Local implementation and verification are recorded in [the 2026-11-16 verification receipt](2026-11-16-companion-verification.md). The fast-provider pilot is still pending authenticated OpenRouter access; no release or production activation occurred. Original checklists above preserve the approved scope.
