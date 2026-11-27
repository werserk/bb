# Design

## Source

The server, db data layer, schema and plugin SDK contract hunks are upstream 89f1e507d6, applied unchanged. Their added and removed lines match upstream file by file. Two hunks are left out on purpose: the SDK version bump (`packages/domain/src/plugin-sdk-version.ts`, `packages/plugin-sdk/package.json`) and upstream's query-cost script, which the fork does not have. Fork-only callers of the changed wait API (the send-intake seam test and the queue amplification test) pass `recheckAt: null`; their semantics do not change.

## Migration

`packages/db/drizzle/` stays byte-identical to upstream, so `0162` cannot go there: it depends on upstream `0153`-`0161`, which the fork lacks. The migration is fork migration `0007_queued_message_recheck_at`, generated with the fork drizzle-kit config. The generated DDL matched upstream's, and the data move was appended as upstream did. The file is byte-identical to upstream `0162`, so its Drizzle hash is the same too. Only `0007_snapshot.json` is kept in `drizzle/fork/meta/`.

## Reconciliation with a later sync

A later sync takes `drizzle/` from upstream unchanged, which brings `0162`. Without help, a database that ran fork `0007` would fail on `0162`'s `ADD recheck_at` (the column exists), and `0162`'s data move would move sender times on plugin-held rows into `recheck_at`. That is the bug this change fixes. A fresh database would get the column from `0162` and then fail on fork `0007`'s `ADD`.

Two mechanisms in `packages/db/src/fork-upstream-backports.ts` handle this. Both are dormant until `drizzle/meta/_journal.json` contains `0162_queued_message_recheck_at`.

1. **Covered fork migrations.** `forkBackportsOfUpstream` pairs fork `0007` with upstream `0162`. The fork runner in `fork-migrations.ts` keeps Drizzle's rules (it applies every migration newer than the newest ledger row, in one transaction) with one difference: a fork migration whose upstream pair is already in `__drizzle_migrations` is recorded in `__bb_fork_migrations` with its real hash, without running. It is a small loop of our own, because Drizzle's migrator cannot skip one file's statements. The completeness check after it is unchanged.
2. **Stage around upstream's migrator.** `stageForkRecheckAtForUpstream` runs before `drizzleMigrate` when `0162` is in the journal, is not yet in `__drizzle_migrations`, and `recheck_at` exists. In one transaction it copies `id, recheck_at, send_at, state` of every row with a re-ask time or a plugin-held sender time into `__bb_fork_stage_queued_message_recheck_at`. Then it drops the index and the column. `0162` then runs as upstream wrote it. `restoreStagedForkRecheckAt` runs in the same `finally` as upstream's own staging helpers: it writes the copied values back by row id and drops the stage. If upstream's migrator threw, or a stopped run left a stage behind, it first re-adds the fork's column and index, which returns the database to its pre-stage state.

| Database at the sync | Stage | `0162` | Fork `0007` | Result |
|---|---|---|---|---|
| Ran fork `0007` (upgraded through this build) | copies and drops | runs, data move touches no row in the new meaning | already in fork ledger | values unchanged, one column, one index |
| Fresh | no table, no-op | runs | recorded without running | upstream schema |
| Never ran fork `0007` (skipped this build) | no column, no-op | runs, data move applies | recorded without running | same as upstream |

Between `0162` and the restore, later upstream migrations in the same run see the staged rows with `0162`'s values. Upstream `0163`-`0172` do not rebuild or rewrite `queued_thread_messages`. Re-check this when syncing past them.

**At the sync, the maintainer:**

1. Takes `drizzle/` from upstream unchanged.
2. Keeps `drizzle/fork/0007_queued_message_recheck_at.sql` and its journal entry. They are ledger identity on every database that ran them.
3. Resolves the upstream hunks of #7872 (identical lines) in favour of upstream.
4. Refreshes the fork snapshot as `FORK.md` describes. `recheck_at` is upstream schema by then, so nothing new is generated for it.
5. Runs `packages/db/test/fork-upstream-backports.test.ts`. Its sync simulation copies `drizzle/` and adds upstream `0162` from `test/fixtures/` only when the copy lacks it, so it runs against the real synced folder too.

The stage step and the fork `0007` entry stay as long as any database may still upgrade from a pre-sync build.

## Release class and rollback

Class `data-protocol` (the fork release runbook): a new column and index, a data move on existing rows, and an additive plugin contract field. It needs `--owner-approved`, and the runbook takes a database snapshot before the first start.

Pointer rollback to the previous build works without a snapshot restore:

- Startup (checked by simulation): the previous build's fork runner sees `0007` as the newest ledger row, applies nothing, and its completeness check covers only `0000`-`0006`. Upstream's ledger is unchanged. The test "the build before this backport still starts on a database that ran 0007" runs `migrate()` with that build's `drizzle/` on a migrated database, and every queue value stays as it was. The simulation uses this change's fork runner with the old folder. The old runner is Drizzle's own migrator, which follows the same newest-row rule (inferred equivalence).
- Behaviour on the old runtime (inferred from code): it ignores `recheck_at`. Plugin waits that relied on a re-ask time wake only on a recheck or another drain. Plugin-held rows with a sender time go back to today's behaviour: the old drain sends them without a time once the plugin proceeds. So rollback returns the bug, no worse than today.
- Rolling forward again: `0007` is already in the ledger and does not re-run. Rows the old runtime wrote with a plugin time in `send_at` are read as a sender time. Such a message waits until that time (normally seconds) and is never sent early.

Restore the snapshot only if this migration itself damaged the database. It drops every queued message and thread change made after the upgrade.

## Plugin SDK version

`PLUGIN_SDK_VERSION` stays 0.6.132. The fork carries one piece of 0.6.133-0.6.174. Reporting 0.6.174 would tell plugins that every change in that range is present. A plugin cannot detect `recheckAt` support by version on this fork. The legacy `sendAt` on a `wait` keeps working and means the re-ask time.

## Strict hook decision schema (follow-up)

A `.strict()` decision schema would make an unknown key fail the attempt with the plugin named, so contract skew is loud instead of silently stripped. It changes behaviour for any installed plugin that returns extra keys today. That set includes plugins outside this repository, so no behaviour change cannot be shown. Left as a follow-up: log unknown keys first, then decide.
