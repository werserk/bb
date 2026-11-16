# Direct OpenRouter and split companion verification

Status: implemented and locally verified, not released. Quality and subsecond latency acceptance remain incomplete. Owner approval qst_4p3zf4m9g2 selected direct OpenRouter with the existing OpenCode credential and authorized twenty new synthetic calls; all twenty have been consumed. No production model, settings or credential were changed.

## Implementation

The ACP host runtime reads only the active OpenRouter key through the native OpenCode credential export, keeps it host-local and does not create another store. One shared AI service supplies native SDK and Gateway consumers. Explicit model capabilities come from the live catalog; the direct request has ordered message roles, latency routing, no fallback, no application retries, requested reasoning and output caps. Missing usage remains unknown; completion reasons are checked. Host protocol269 covers the new commands. The host bundle uses a local sanitized error class, not an unavailable server-only SDK runtime export.

Foreground output is a strict short suggestion or none. It settles before a separate source-validated memory refresh starts. Both use the same selected model and full exact owner instructions. Memory has one running slot, shared hourly admission accounting, one reserved foreground admission, cancellation and stale-result checks. It cannot rewrite a settled result or adopt an unsent suggestion as an owner decision. This initial version prepares memory after a completed foreground result, for future turns; it does not generate memory on each streamed event.

Preemption requests cancellation; the shared SDK intentionally retains a slot until underlying provider work settles. A saturated dispatcher can return typed busy without retrying the admitted snapshot. A later new turn can run after cleanup. RPC and CLI expose the same memory counters; inspect remains separate from the short result.

## Verification

All executed under Node22.19.0 with Turbo. No test or build was delegated to a worker.

- `pnpm exec turbo run typecheck test:workspace lint prepare:bundled --filter=bb-plugin-provider-acp`: exit0, 116 tests, typecheck/lint/bundle passed. Log: `direct-provider-bundle-fix.log`.
- `pnpm exec turbo run typecheck test --filter=bb-plugin-provider-acp --filter=@bb/host-daemon-contract`: earlier exit0; 100 host contract tests passed. Later provider checks supersede the earlier115-test provider run. Log: `direct-provider-checks-3.log`.
- `pnpm exec turbo run typecheck test lint prepare:bundled --filter=bb-plugin-prompt-suggestion`: exit0, 101 tests, typecheck/lint/bundle passed. Log: `split-companion-verified.log`. Existing React compiler/Vite configuration warnings remain, not new failures.
- Read-only production-host-runtime catalog probe returned383 text models and both exact requested candidates with explicit none support. No paid call was made by that probe.
- Independent spec and quality reviews passed after closure of missing diagnostics/schema documentation, host bundle import and contention-test findings. These source verdicts are separate from live quality acceptance.

UI component tests and shared SDK/host-runtime consumers were exercised. This turn did not re-run an installed UI or a real server-daemon roundtrip. Earlier isolated UI evidence is historical; no new end-to-end visible latency claim follows from these checks.

## Paid pilot

Twenty calls: ten memory requests capped at2048 output tokens and ten short requests capped at256, exact DeepSeek V4.1 Flash1017, reasoning none. All carried full current BIBLE; no real conversation history. A durable exclusive admission receipt prevented overwriting/restarting the run. Invalid raw outputs and private instructions were not retained; decoded results and provider telemetry were redacted before persistence.

The sequential warm diagnostic supplied successfully validated memory to the short request; failed memory fell back to the original fixture seed/messages. It used the actual registered shared service and production host runtime via a test host bridge. It is not proof of coordinator scheduling or physical UI latency.

| Role | Calls | Structural pass | Median | Range | Median key lookup, included |
| --- | --- | --- | --- | --- | --- |
| Короткая подсказка | 10 | 10/10 | 1.63 с | 1.20–3.56 с | 0.38 с |
| Обновление памяти | 10 | 9/10 | 3.80 с | 2.12–5.07 с | 0.38 с |

Durations include the shared SDK, credential lookup, HTTP body, parsing and role/source validation/redaction. They exclude actual daemon transport and UI. No short sample was below one second. The key export alone had median0.38s, but subtracting it is not evidence that another credential mechanism will achieve subsecond latency.

Independent semantic review: short results9/10 strict passes (all10 correct direction); memory8/10 usable strict passes; pairs7/10. The missing-history short result invents the owner's inability to see history. A memory fact attributes an owner restriction to the assistant's proposal; another memory result failed validation with unknown precise cause because invalid raw output was intentionally omitted. Stop, spend and injection cases did not invent approval. These are small synthetic samples, not population quality estimates.

Usage across all twenty calls: 75482 input tokens, 4342 output tokens, 45312 cached input tokens. Actual returned model matched the requested DeepSeek ID; actual service tier and monetary cost were not reported by this shared contract. Cached token counts are observed, not a cache-hit guarantee.

## Evidence and remaining work

Durable thread storage: `direct-companion-pilot-plan.json`, `direct-companion-pilot.mts`, `direct-companion-pilot-results.json` (source hashes and per-call receipts), `direct-companion-summary.json`, `direct-companion-semantic-review.json`, `direct-companion-semantic-review.md`, `direct-companion-pilot-preflight-review.md`, and the verification logs above. Earlier failures remain in logs; they are not counted as passing gates.

No release or production switch is authorized. Faster-model evaluation and improvement of the remaining role/source errors are still needed for the accepted quality and latency target. Further paid calls require a new owner budget; the current twenty-call budget is exhausted. The direct adapter and split scheduler are available locally for that next comparison.
