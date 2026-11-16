# Prompt Suggestion speed follow-up

The owner selected optimization plus comparison of Haiku 5.5 through the existing MWAPI connection, GPT-6.1 Terra Fast and GPT-6 Luna. Use synthetic conversations only; do not enable production suggestions before a measured selection is accepted. Original shared-AI and Prompt rollout remains authorized.

## Evidence and design

Release candidate 0.49.0+werserk.7 was built from 97ecf7d7be but its release failed before the mutation window because the nightly restart service was waiting for idle. Daily remained .5. The waiting nightly service was stopped after verifying its only child was sleep; its timer remains enabled. Combine the retry with the speed changes.

Initial Codex catalog sample was 2364 ms. Follow-up phase probes measured 2690/426/183 ms, with first model/list 2494 ms and subsequent 3/2 ms. Existing native caching already removes most steady-state catalog cost; shutdown was not the dominant cost. Do not add a generic TTL-only cache or change child shutdown semantics. Remove UI-only duplicate config/read, consume raw native model capabilities and keep fresh route/auth validation.

Explicit generation gains optional serviceTier (default null), advertised serviceTiers (default empty), and actualServiceTier (null when not reported). The dispatcher normalizes legacy absence and rejects unsupported options. Requested Fast maps in the adapter; benchmark reports requested and actual provider tier separately. Prompt settings expose reasoning and speed without silently resetting on model switches.

The existing Sub2API plugin owns MWAPI base URL and keyCommand. Extend that owner with an optional Anthropic generation capability, default off and explicitly host-bound. Preserve usage behavior on old core, do not reinterpret server keyCommand on a changing primary host, do not copy credentials into consumers. The live catalog contains claude-haiku-5-5; transport inference remains to be checked.

Independent plan review by speed_design_review: GREEN, with fresh route validation, raw capability fidelity, explicit host binding and truthful small-sample latency reporting required.

## Work and acceptance

- Implement and test shared speed controls, raw Codex capabilities, unchanged Pi behavior and Prompt settings.
- Implement/test optional MWAPI generation at the existing connection owner.
- Compare identical short/long synthetic dialogs, including completed work and unresolved choices; record errors, valid none responses and latency until complete validated JSON. Keep cold/warm measurements distinct; a small sample is not a p95 SLA.
- Independently review changes and outputs. Verify real composer, Tab/Enter, cancellation, unsupported controls and route-change rejection in isolated BB.
- Build immutable candidate, deploy through maintained release workflow and verify receipt. Keep production suggestions off until the owner selects measured settings.

## Measured follow-up

The isolated lab ran 21 sequential requests through an unmodified OpenAI client and AI Gateway on seven identical synthetic conversations. Terra requested Fast/low: median 2730 ms, max 6180 ms, 7/7 valid JSON, upstream reported default tier. Luna low/default: median 3195 ms, max 4781 ms, 7/7 valid JSON. MWAPI requested Haiku 5.5: median 13689 ms, max 15129 ms, 0/7 valid JSON, actual model reported Haiku 4.5. Small samples describe this run, not a latency SLA. Raw cases/results and runner are in thread storage as suggestion-speed-*.json/mts.

Prompt checks passed (21 tests plus typecheck/lint); SDK/Gateway/provider focused checks passed. Independent source review found no blocking correctness issues. External MWAPI adapter passed 19 tests/typecheck/build and documents private-fork SDK staging. Real settings UI verified unsupported none warning and clearing it after low/Fast selection. Suggestions remain disabled in production.

Daily changed concurrently to 0.49.0+werserk.6 (85fa8d372da6). Preserve that released ancestry before building the next candidate. The prior .7 candidate is superseded and must not be deployed.
