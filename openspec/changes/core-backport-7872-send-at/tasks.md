# Tasks

Checked items are implemented and covered by the checks in [verification](verification.md). Nothing here is released.

- [x] Apply upstream 89f1e507d6 source, schema, data-layer and contract hunks unchanged; keep the SDK version at 0.6.132.
- [x] Generate fork migration `0007_queued_message_recheck_at` with the fork drizzle-kit config, append upstream's data move, keep only the newest fork snapshot.
- [x] Covered fork migrations: record a fork migration without running when its upstream pair is applied.
- [x] Stage and restore `recheck_at` around upstream's migrator for databases that ran fork `0007`.
- [x] Sync-simulation tests for every database state, interrupted run and the previous build.
- [x] Spawn-path regression in `dispatch-hooks.test.ts`; diagnosis-only tests not carried over.
- [x] Port upstream's db data tests and the plugin authoring doc (`backend-events.md`).
- [x] `FORK.md`: the backport mechanism and what a sync must keep.
- [ ] Owner decision: release as `data-protocol` (separate step; not part of this branch).
- [ ] Follow-up: strict hook decision schema, after logging unknown keys.
