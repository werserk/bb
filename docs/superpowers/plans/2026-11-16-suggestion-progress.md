# Suggestion progress

goal: Show truthful suggestion progress and settings status, merge reviewed code without release.
in_scope: SDK transient request status; existing composer placeholder/loading/error UI; plugin lifecycle and model settings status; docs and focused tests.
claim_1: Pending requests show Preparing suggestion with spinner; successful candidate uses current placeholder acceptance path. Probe: controller and composer tests plus isolated browser.
claim_2: None returns ordinary placeholder; failure/timeout shows ordinary placeholder and accessible pressable error detail. Cancellation, typing, context change, unmount and stale completion clear only their own status. Probe: out-of-order/cancellation tests.
claim_3: Settings identify enabled state, selected model, reasoning and requested speed. No claim Fast was actually served. Probe: settings UI.
invariant_1: No daily configuration change, deployment or restart. Only isolated verification and merge into the owner-approved fork/main integration branch. No upstream writes.
invariant_2: No new provider requests merely to animate UI. Status belongs to request ID and composer snapshot; input always editable, pending is not submittable text.
decision_1: Extend shared experimental suggestion controller rather than independent plugin DOM overlay, so existing composer and SDK share lifecycle.
affected_paths: packages/plugin-sdk/src/app-contract.ts, internal/composer-suggestion*, plugins/composer, plugins/prompt-suggestion, docs/api_to_audit.md, docs/system-overview.md, plugins/plugin-api-docs/src/surfaces.ts.
non_goals: model speed research, mobile insert button, retries, changed eligibility or automatic model selection.

## Verification

SDK progress tests, Prompt lifecycle/typecheck/lint, native key tests, mounted compact-composer regression and direct timeout/cancellation regression passed. The initial full app test invocation was stopped when its chained script ignored file filtering; the proper Turbo test:focused checks passed. Logs: progress-sdk-tests.log, progress-plugin-checks.log, progress-app-focused.log, progress-compact-test.log, progress-timeout-test.log, progress-types.log in thread storage.

Independent plan and final scope/correctness review passed. Review fixes cover the compact collapse attribute, summary focus handling and supported icon names. Isolated Chromium verification covered pending empty/non-submittable editor, ready candidate, none, mobile390px loading/error disclosure, typing clears error, and settings status. Screenshots and browser receipts are in thread storage. Mobile Safari/device verification was not performed; no new drawer or modal was added.

Merge target is fork/main, based on e7200b807ee9. No release, production settings change or daily restart is authorized for this change.
