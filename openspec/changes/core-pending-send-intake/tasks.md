# Subpart A implementation plan

Checked items describe implementation or selected runtime coverage, not independent approval or release readiness. Current verdict and exact evidence: [verification](verification.md).

- [x] Record typed owner approval, Addendum10 conditions and accepted fixture prerequisite without modifying immutable overlay approval.
- [x] Add one Drizzle intake schema, generated migration/snapshot, matching rewind support and real migrated DB tests for identity/hash/order/pins/revision/claims/terminal retention/thread deletion.
- [x] Add shared intake admission and bounded restartable worker, preserving original envelope and delayed asset custody; route modern/legacy/no-ID send entry through the lane.
- [x] Fence requested append, queue handoff, first start, clear completion, compact correlation and model recovery in their actual transaction/effect seams; release after committed custody, including compactFirst parent rules.
- [x] Add negotiated accepted/capability and typed minimal canonical read/revision actions; preserve truthful old receipts and post-seal custody on 409.
- [ ] Publish actual generated schema/state/terminal/native-handoff/DB-WAL/writer-stop/packaged capability contract for C, explicitly distinguishing implementation facts from missing proof.
- [ ] Run affected meaningful tests and required typecheck/build through Turbo, serial fresh load1<16 and nice19/ionice3; refusal stops the phase. Retain exact commands/exits/counts/logs and separately disclose matching-base failures.
- [x] Gate the whole path behind the `sendIntake` experiment (default off) with the legacy route unchanged while off.
- [x] Update architecture and capture a local review-candidate commit for the same reviewer; readiness remains partial. Do not implement B/C, package, run labs or release.

Required failure scenarios: mixed legacy/modern ordering with delayed staging head; replay after payload compaction; cross-project source deletion after custody; stale epoch at each seam; committed handoff vs held HTTP/provider; compactFirst intermediate checkpoint; edit/cancel 409 preserves content; startup and DB-close boundaries. Exact runtime coverage and gaps must be reported, not inferred from source alone.

Addenda13/14 required source/regression delta (definitions are not runtime evidence):

- [x] Revisioned same-row reconcile from authoritative native evidence; keep no-proof custody blocked and preserve compactFirst parent semantics.
- [x] Retain original pre-effect deterministic rejection/replay, classify post-seal uncertainty honestly, bound failed-head legacy errors and guard retries while preserving healthy legacy waits.
- [ ] Verify R-a..R-f through real SQLite/server paths, mode/hook context table, and dedicated context/native-drain boundary. Include exact test names/results and remaining simulation boundaries.

## Subpart B — authorised Addendum20 implementation contract

Parent thr_8n7wrh4rpj authorised B apply on 2026-11-14 after same-reviewer Addendum20 plan PASS; frozen A80f6d3cd remains the source anchor. No schema/storage/daemon/dependency/native-ordering change. No package/live/release authority. createdAt is an optional/nullable additive A-view field, not a migration. The following mandatory conditions govern B; prior A verification remains historical unchanged-input evidence.

R1 Snapshot section (blocking-for-coding clarity): A's GET send-intakes lists ALL states incl. terminal history (readThreadSendIntakePage, no state filter) — do not use it for reload; snapshot section = nonterminal page + terminal metadata for requested IDs only. Specify: additive request/response, optional by capability; whole joint read synchronous (no await between native rows/placements/eventMaxSeq/intake page) in one read tx; joint coverage complete only if BOTH complete; byte budget on the intake page (envelopes carry full input; native snapshot already has scannedBytes) and >200 IDs chunked with merge, any failed chunk ⇒ partial; staging/terminal rows have input=null (A view) ⇒ neutral rendering, never fabricated text.
R2 Merge/causality rule written down: intake rows carry no event seq, so use per-row revision monotonic + terminal sticky + request-generation fence (older snapshot discarded) for intake, eventMaxSeq for native. Absence of a known nonterminal row is proof only on complete coverage AND with its terminal metadata (transferred/cancelled/rejected + handoff); otherwise keep local and show unresolved. Handoff causality: A commits queue row and transferred state together, so a joint read must never show transferred without the native row/request/placement; test that.
R3 Capability: new `/capabilities/pending-send-intake` {version:1}; absent/404/other version = unsupported; fetched per identity generation; true even before provider readiness (A keeps custody pending); 503 intake_unavailable (stopped/move frozen) = UNKNOWN outcome ⇒ replay same UUID, never fall back to legacy; downgrade mid-session covered by the generation fence (add test). createdAt is an additive A-view field: mark as A-schema amendment, optional/nullable.
R4 Error discrimination by code + canonical row: intake_conflict (stale/sealed, not edited), intake_not_ready (unchanged), intake_blocked (blocked head vs corrupt transferred receipt: blockerId==intakeId AND row transferred ⇒ "Result unavailable; custody evidence retained"; otherwise blocked-lane text; code alone is overloaded and A is frozen), submission_conflict/submission_already_admitted. Reconcile no-proof returns 200 with state failed, revision+1 and lastError "Unresolved: no committed native handoff proof; custody retained" — render as Unresolved, never as success.
R5 Reload without journal: reconstructed rows are single-submission; no group/alias/lineage claims (those live in the client journal/native rows); say so.
R6 Project/host deletion residual: by the plan’s own source note thread-deleted is emitted at MARK time before physical deleteProject, so A’s D1 subscription runs while rows still exist and the final cascade emits only project-deleted ⇒ waiters would hang (no timer). Treat the post-commit project-deleted/host vanished-row sweep as PLANNED, not conditional (test-first still), as a separately reviewed A-file delta; no timer.
R7 CLI: `tell --ack stored` output = id/revision/state/clientSubmissionId (distinct from sent/queued), unsupported = explicit error code, unknown outcome prints the UUID for replay; `thread intake list` nonterminal by default, history opt-in (A returns all).
R8 Enablement/limits stated in docs: capability is B’s only switch; legacy A route already writes intake rows, so B adds no new custody class but does not make rollback safe — A+B+C live remains required; no release claim.
R9 Tests to add: capability downgrade, chunked >200 IDs partial, out-of-order snapshots, terminal-sticky merge, intake_not_ready vs intake_conflict handling, corrupt-transferred discriminator.
