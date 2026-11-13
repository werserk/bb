# Subpart A implementation plan

Checked items describe implementation or selected runtime coverage, not independent approval or release readiness. Current verdict and exact evidence: [verification](verification.md).

- [x] Record typed owner approval, Addendum10 conditions and accepted fixture prerequisite without modifying immutable overlay approval.
- [x] Add one Drizzle intake schema, generated migration/snapshot, matching rewind support and real migrated DB tests for identity/hash/order/pins/revision/claims/terminal retention/thread deletion.
- [x] Add shared intake admission and bounded restartable worker, preserving original envelope and delayed asset custody; route modern/legacy/no-ID send entry through the lane.
- [x] Fence requested append, queue handoff, first start, clear completion, compact correlation and model recovery in their actual transaction/effect seams; release after committed custody, including compactFirst parent rules.
- [x] Add negotiated accepted/capability and typed minimal canonical read/revision actions; preserve truthful old receipts and post-seal custody on 409.
- [ ] Publish actual generated schema/state/terminal/native-handoff/DB-WAL/writer-stop/packaged capability contract for C, explicitly distinguishing implementation facts from missing proof.
- [ ] Run affected meaningful tests and required typecheck/build through Turbo, serial fresh load1<16 and nice19/ionice3; refusal stops the phase. Retain exact commands/exits/counts/logs and separately disclose matching-base failures.
- [x] Update architecture and capture a local review-candidate commit for the same reviewer; readiness remains partial. Do not implement B/C, package, run labs or release.

Required failure scenarios: mixed legacy/modern ordering with delayed staging head; replay after payload compaction; cross-project source deletion after custody; stale epoch at each seam; committed handoff vs held HTTP/provider; compactFirst intermediate checkpoint; edit/cancel 409 preserves content; startup and DB-close boundaries. Exact runtime coverage and gaps must be reported, not inferred from source alone.

Addenda13/14 required source/regression delta (definitions are not runtime evidence):

- [x] Revisioned same-row reconcile from authoritative native evidence; keep no-proof custody blocked and preserve compactFirst parent semantics.
- [x] Retain original pre-effect deterministic rejection/replay, classify post-seal uncertainty honestly, bound failed-head legacy errors and guard retries while preserving healthy legacy waits.
- [ ] Verify R-a..R-f through real SQLite/server paths, mode/hook context table, and dedicated context/native-drain boundary. Include exact test names/results and remaining simulation boundaries.
