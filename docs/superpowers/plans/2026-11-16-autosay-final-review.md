# Autosay final source reviews

## Spec compliance

Reviewer: `/root/autosay_plan_review` (independent). No remaining source blockers after correcting authoritative lifecycle selection, settings cancellation, expected turn identity, CLI cancellation capability, durable-question invalidation, and old-host capability detection. Spec acceptance remains incomplete until live lab and configured real generator checks are recorded.

## Code quality

Reviewer: `/root/autosay_quality_review` (independent). Source PASS after Q1 fix: renderer registration teardown must synchronously revoke capability and invalidate the candidate even when its host remains mounted. Current implementation uses an active registration token. Regression proves ordinary rerender preserves the candidate, while real teardown refuses acceptance and leaves draft unchanged.

Reviewed evidence: `autosay-plugin-final.log` (24 tests, typecheck and lint); `autosay-host-evidence/final-host-tests2.log` (18 focused tests, 186 outside the filter); `autosay-host-evidence/final-app-types.log` (typecheck). Earlier broader regressions are recorded separately and are not represented as reruns of the final tree.

No reviewer ran builds or tests; both inspected source and the recorded outputs. Live runtime verification and real generator/provider acceptance are distinct from this source verdict.

## Post-lab layout review

The browser uncovered clipped text in the narrow compact composer. The final renderer expands while a candidate is shown, bounds long text scrolling and keeps acceptance outside the scroller. Independent quality reviewer rechecked this fix, its regression and actual touch evidence: PASS, no new source blockers. The configured real generator remains unverified.
