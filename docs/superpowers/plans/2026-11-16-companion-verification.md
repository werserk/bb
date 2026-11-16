# Companion implementation verification — 2026-11-16

Historical receipt. Current direct-OpenRouter implementation and remaining acceptance gaps are recorded in [the November17 verification](2026-11-17-direct-companion-verification.md).

Status: the Pi-based implementation and its local verification are complete. The owner subsequently selected OpenCode instead of Pi. The OpenCode preliminary pilot is complete; a production OpenCode path and subsecond acceptance remain incomplete. No release, deployment, production model change or production background activation was performed. This receipt is the current execution status for the provider and goal-oriented companion plans; their original checklists remain the accepted scope, not a claim that every live acceptance item passed.

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
- This Terra baseline predates the OpenCode pilot below. Paired cold/warm-prefix results and full final-event-to-visible-suggestion latency remain unverified. The below-one-second goal has NOT passed.

## OpenCode preliminary pilot — 2026-11-17

The owner selected the existing OpenCode OpenRouter connection in question `qst_5r8mrgg2c3`, superseding the Pi connection step. No keys were replaced, exported to artifacts or copied to Pi. The native OpenCode 2.2.7 stateless text API advertised both exact candidates with variant `none`. The full owner instruction source was supplied on every call; no real chat history was sent.

Exactly 20 application calls were admitted: 10 DeepSeek full-state cases, 7 Qwen full-state cases and 3 DeepSeek short-output diagnostic repeats. Qwen stopped after its seventh call timed out at 30 seconds. The remaining full-state safety cases ran only on DeepSeek. No application retries ran. Native retries for selected pre-execution failures remain possible; upstream attempt counts, actual served models, finish reasons, token usage and monetary cost were not exposed by this endpoint.

| Requested model and output | Calls | Structurally valid | Median response | Response range |
| --- | --- | --- | --- | --- |
| DeepSeek V4.1 Flash 1017, state + suggestion | 10 | 9 | 3.27 s | 2.35–8.94 s |
| Qwen3.8 27B, state + suggestion | 7 | 2 | 10.42 s | 6.27–26.17 s |
| DeepSeek, suggestion only | 3 | 3 | 1.29 s | 1.23–1.55 s |

Times measure local fetch start to response headers from the non-streaming generation endpoint, excluding body read/parse/validation and the BB coordinator/UI. Response medians/ranges include invalid model outputs but exclude the Qwen transport timeout. They are not time to a usable suggestion. Invalid raw outputs were not retained, so their exact JSON/schema/source failure causes cannot be recovered from these artifacts.

The short-output diagnostic retained the full BIBLE, recommendation role and synthetic messages, supplied an already prepared grounded goal and constraints, and omitted task-state regeneration from output. Three repeats of one scenario are exploratory evidence only: they neither establish causal attribution to output length nor pass the full production contract or broad quality acceptance. The slowest local diagnostic response still exceeded one second before validation/UI.

Schema/source validation did not establish semantic correctness: a valid DeepSeek missing-history response spoke as the executing agent, and a side-question response called reported progress ready without evidence. Independent semantic review passed the complete state/message contract for 5 of 10 DeepSeek attempts and 2 of 7 Qwen attempts. Lower-severity state fidelity defects count separately from the high-severity wrong-speaker response. All three short diagnostics passed their narrower semantic review. These small samples are insufficient evidence to select either candidate as the production companion.

OpenCode's native API takes a single prompt string and returns text only. It lacks the ordered-role, completion-reason and routing controls used by the accepted BB generation path. The pilot did not register an OpenCode service in BB or invent missing stop/usage receipts. The implemented coordinator and UI remain checked locally as above; OpenCode production integration remains unfinished. No release or production setting change occurred.

## Evidence index

Durable evidence lives in the owning BB thread storage, outside the repository. Test logs: `companion-final-plugin.log`, `companion-final-sdk.log`, `companion-final-pi.log`, `companion-codex-compat.log`, `companion-final-gateway-contract.log`, `companion-core-tests.log`, `companion-final-types.log`. UI: `companion-ui-tab.json`, `companion-ui-enter.json`, `companion-ui-receipt.json`, `companion-ui-ready.jpg`. Live pilot: `companion-pilot-terra.json`, `companion-pilot-terra-continuity.json`, `companion-pilot-semantic-review.json`, `companion-terra-semantic-review.md`. Reviews: `provider-quality-review.md`, `companion-spec-review.md`, `companion-quality-review.md`. OpenCode: `opencode-pilot-results.json`, `opencode-pilot-summary.json`, `opencode-pilot.mts`, `opencode-safety-pilot.mts`, `opencode-short-pilot.mts`, `opencode-companion-preflight.md`; `opencode-pilot-semantic-review.json` and `.md` preserve per-case review separately from structural validation.

The verify-bb inventory helper could not determine this checkout from its globally installed skill location; no baseline was rewritten. An early reviewer check used system Node 26, failed before tests and disturbed the shared native SQLite build. The repository's standard native-module repair under Node 22 restored the lab; all evidence counted above comes from the subsequent Node 22 runs. Failed exploratory checks are preserved in thread logs and are not counted as passing tests.

## Remaining work

Access is no longer blocked. The owner-selected native OpenCode route has material contract limitations and did not meet speed/quality acceptance. Resolve whether OpenCode must execute requests itself or may remain the credential owner while a BB host adapter calls OpenRouter directly with explicit routing and complete receipts. The latter is a proposal, not an implemented or approved transport substitution. Keep task-memory preparation separate from final-message latency in the next design; the short-output diagnostic is evidence for investigation, not acceptance of that architecture.

The 20-call pilot budget is exhausted. Any further paid verification needs a new owner budget decision. Production provider integration, full quality verification and final-event-to-visible-suggestion timing remain incomplete. Do not release until separately instructed.
