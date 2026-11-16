# Companion implementation verification — 2026-11-16

Status: implementation and local verification complete; live fast-API selection remains blocked on an authenticated OpenRouter connection. No release, deployment, production model change or production background activation was performed. This receipt is the current execution status for the provider and goal-oriented companion plans; their original checklists remain the accepted scope, not a claim that every live acceptance item passed.

## Implemented

- Existing authenticated Pi generation path: conservative exact reasoning-off capabilities, opaque session affinity, connection-owned lowest-latency routing, no retries or model fallback, and applied-routing readback. SDK and OpenAI-compatible Gateway share the dispatcher. Host protocol is 268. Codex retains its unchanged strict host payload.
- One server coordinator for UI, CLI and RPC: active-thread preparation, finite interest leases, one inference queue, separate one-hour admission history, source-linked task memory and stale-result rejection. A new foreground completion renews the existing membership without a cancellation gap. Typing dismisses only local presentation.
- Canonical companion role plus strict result/state contract and the full current owner instruction source. The shared core reader preserves exact owner content and hashes it; core's historical trim/missing behavior remains unchanged. No provider tools, skills or autonomous executor are added.
- Queue/preparation/model/validation/server durations, usage, actual model/tier, finish reason and output budget. Browser attachment observations use only the browser clock and carry the job ID; they exclude transport and are not end-to-end latency.
- Bounded synthetic pilot, default dry-run, explicit live call/output limits, no automatic retry. Reports retain only validated, decoded and redacted synthetic outputs; invalid output and raw provider/parser errors are omitted. No new credential store.

Small implementation choices keep the same contracts with fewer modules: Pi routing uses its existing server settings and status RPC; admission behavior is tested through the coordinator; no separate settings.ts or admission.test.ts was necessary. Final source is integrated as one local implementation commit after cross-component review rather than landing unreviewed intermediate slices.

## Checked locally

All commands ran with Node 22.19.0 and Turbo, with complete logs in the owning thread storage.

| Surface | Command after `pnpm exec turbo run` | Result |
| --- | --- | --- |
| Companion | `test typecheck lint --filter=bb-plugin-prompt-suggestion` | 86 tests passed; typecheck and lint passed (one existing React compiler warning) |
| Shared SDK | `test --filter=@get-bb/plugin-sdk` | 494 tests passed |
| Pi serializer/runtime/status | `test --filter=bb-plugin-provider-pi -- src/ai server.test.ts` | 18 tests passed |
| Codex compatibility | `test --filter=bb-plugin-provider-codex -- src/ai/affinity-compat.test.ts` | 1 test passed |
| Gateway and host wire | `test --filter=bb-plugin-ai-gateway --filter=@bb/host-daemon-contract` | 29 and 100 tests passed |
| Core instructions and discoverability | `test --filter=@bb/server -- test/services/plugins/plugin-authoring-docs.test.ts src/services/threads/workspace-agent-instructions.test.ts` | 20 tests passed |
| Cross-component types | `typecheck --filter=@bb/server --filter=@get-bb/plugin-sdk --filter=bb-plugin-provider-pi --filter=bb-plugin-provider-codex --filter=bb-plugin-ai-gateway --filter=bb-plugin-plugin-api-docs` | All selected tasks passed |

Regression coverage includes ninth-thread eviction without another admission, foreground queue priority, wake during an outstanding preparation read, expiry/dispose cancellation, source replacement and context clearing, unsupported options, exact serialized OpenRouter payload/header, false/stale state, partial output, old-registration cleanup, and an already-admitted new-turn job surviving UI renewal with background disabled. Affinity is tested across turns, threads, configuration changes and process restart.

Actual isolated BB UI, synthetic model: Codex Tab turns the placeholder candidate into editable text; Claude Enter creates exactly one normal send request, intercepted before provider dispatch. Navigation away/back returns the same job ID and leaves generation count at one. The CLI result ID matches the browser attachment receipt. Compact 390-pixel Chromium also submits the candidate through the visible Send button with one intercepted request; physical iOS/Safari was not tested. This proves consumer behavior, not live model speed. The lab uses a fresh owned data directory and does not change the installed user's model.

Independent provider/source/spec/quality reviews found blockers; all named C1–C3 and Q1–Q4 findings were fixed and re-reviewed closed. The final telemetry delta passed source review. Saved review reports retain original findings and their closure instead of erasing the evidence trail.

## Live model evidence and limits

Thirteen unique synthetic Russian scenarios used the implemented role, strict task state and full current owner instructions (12,138 owner characters; 16,971 total instruction characters). They went through the already installed subscription Gateway, not the new coordinator. No real conversation history was sent in this pilot.

- All 13 outputs passed JSON/schema/source-reference validation and independent semantic direction review. This is one sample per scenario, not a statistical quality guarantee or owner UX acceptance. One keyword screen falsely flagged a negated purchase instruction; the original screening result is preserved. One answer included unnecessary initial agreement without granting new scope.
- Complete-response latency: median 4,476 ms, minimum 3,359 ms, maximum 8,648 ms. Requested Terra Low/Fast; every response reported actual tier `default`.
- Usage across all calls: 51,612 input tokens, 5,310 output tokens, 27,648 cached input tokens. Terra's explicit output limit was 0 because the adapter does not support a cap; the remote provider cap remains unknown. No monetary cost estimate is inferred from subscription usage.
- No OpenRouter inference was performed. Pi has no authenticated OpenRouter connection in this environment. Exact DeepSeek/Qwen availability, paired cold/warm-prefix results, fast-provider semantic quality and full final-event-to-visible-suggestion latency remain unverified. The below-one-second goal has NOT passed.

## Evidence index

Durable evidence lives in the owning BB thread storage, outside the repository. Test logs: `companion-final-plugin.log`, `companion-final-sdk.log`, `companion-final-pi.log`, `companion-codex-compat.log`, `companion-final-gateway-contract.log`, `companion-core-tests.log`, `companion-final-types.log`. UI: `companion-ui-tab.json`, `companion-ui-enter.json`, `companion-ui-receipt.json`, `companion-ui-ready.jpg`. Live pilot: `companion-pilot-terra.json`, `companion-pilot-terra-continuity.json`, `companion-pilot-semantic-review.json`, `companion-terra-semantic-review.md`. Reviews: `provider-quality-review.md`, `companion-spec-review.md`, `companion-quality-review.md`.

The verify-bb inventory helper could not determine this checkout from its globally installed skill location; no baseline was rewritten. An early reviewer check used system Node 26, failed before tests and disturbed the shared native SQLite build. The repository's standard native-module repair under Node 22 restored the lab; all evidence counted above comes from the subsequent Node 22 runs. Failed exploratory checks are preserved in thread logs and are not counted as passing tests.

## Remaining owner input

Choose an existing OpenRouter connection or provide its key through the secure credential flow already offered in the pending question. Then run the capped synthetic fast-model comparison through Pi and measure the new coordinator/UI path before choosing a production generator. Do not release until separately instructed.
