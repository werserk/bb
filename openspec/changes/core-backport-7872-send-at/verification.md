# Verification

Status: implemented on a branch; source checks below. Independent review: PASS with fixes, fixes applied. No release candidate, no live check. All commands ran under `env -i HOME PATH NODE_OPTIONS=--no-experimental-webstorage` from the branch worktree, based on `fork/main` 6597674a8d.

| Check | Result |
|---|---|
| Typecheck `@bb/db`, `@get-bb/plugin-sdk`, `@bb/domain`, `@bb/server` (`pnpm --filter <pkg> typecheck`) | exit 0 each |
| `apps/server` `test/threads/dispatch-hooks.test.ts` | 44/44 passed. The Send now test ("sends a scheduled row a plugin holds at once on Send now") fails if either `!sendNow` guard in `dispatch-attempt.ts` (the time wait or the hook call) is removed. |
| `apps/server` `test/threads` + `test/public` | 127 files, 1456/1456 passed after the review fixes (1455/1455 before them, second run). The first run had 1 failure in `thread-plugin-metadata-configure.test.ts` (extra observations from other threads). That file passed 3/3 on three isolated reruns, and the whole set passed on the rerun. Treated as a load-dependent flake (load average about 14-22). |
| `packages/db` full suite | 70 files, 744/748 passed after the review fixes (743/747 before them). The 4 failures also fail on the clean base 6597674a8d, the same 4 by name (checked by stashing this change): `thread-drafts-migration` x2 (a rewind replays an upstream table rebuild that drops fork columns; this change adds `recheck_at` to the same list) and `plugin-persistence` lone-surrogate x2. |
| `packages/db` `test/fork-upstream-backports.test.ts` | 8/8 passed. Mutation check: without the stage call, the sync test fails; with covered migrations disabled, the fresh-after-sync and never-ran-0007 tests fail; without the error wrap around the restore, the restore-after-failed-migration test fails. |
| `packages/db` `test/fork-ledger.test.ts` | 6/6 passed |
| Upstream hunk fidelity | For each of 14 backported files (source, docs and the three queue data tests), the ordered added and removed lines equal upstream 89f1e507d6's (`diff`: 0) |
| Fork `0007` vs upstream `0162` | `cmp`: identical |
| Lint | `@bb/server`, `@bb/db` and `@get-bb/plugin-sdk` have no `lint` task. The root `oxlint` config reports only `bb(no-comments)`, which already fires on the base versions of the same files. `oxfmt --check` passes on every file this change made unclean and on the new files. Files that were unformatted on the base are left as upstream has them. |
| `openspec validate --strict` | valid |

Not run: the full server suite outside `test/threads` and `test/public`, plugin-sdk tests, app/desktop builds, and any packaged or live check. The old-runtime rollback result is a simulation (see design.md).
