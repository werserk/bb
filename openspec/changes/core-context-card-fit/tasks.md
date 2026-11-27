# Tasks

Owner scope: owner decision 2026-11-27; approved by the owner, owner decision 2026-11-27 (fork rule (bb-plugin-lab `docs/bb-fork/README.md`)). Builder: `builder-claude`. Reviewer: `reviewer-arch`, read only. Boundaries: README §2 (bb-plugin-lab `docs/bb-fork/README.md` §2). Code branch `core/context-card-fit` from current `fork/main`.

## 1. Fix

- [x] 1.1 Remove the single-child wrapper around `<ThreadContextCard />` in the page case of `ThreadScreen.tsx`; recheck the line anchors on current `fork/main` first.
- [x] 1.2 Regression test in `ThreadScreen.test.tsx`: with a real `ThreadContextCardProvider` (enabled, one row, gutter-wide `clientWidth`), the card's parent is `[data-scroll-overlay]`; fails on `fork/main`, passes with the fix.

## 2. Gates

- [x] 2.1 `pnpm typecheck`, `pnpm lint`, `@bb/app` tests (counts). Lint: 19 errors before and after, none in touched files. `ops/bb-fork/build-candidate` is left to the release step (the coordinator asked for no candidate here).
- [x] 2.2 Browser check (2026-11-27), Ladle on this branch with a local harness story that mounts the real `ThreadContextCardProvider`, `ThreadContextCard` and `BottomAnchoredScrollBody` (before = the removed wrapper reproduced, after = the direct mount), dark and light. 1440×900 and 1440×500: before 44/68 (2 rows) and 122/146 (5 rows) client/scroll px; after 68/68 and 146/146. 1440×170 (short pane; overlay content box 106 px, cap 82 px border-box): 80/146 client/scroll, so the card stops at the cap and scrolls. This case proves the cap only, not the fix: before and after are equal there (80/146), because the wrapper's `max-h-full` bounds it by the overlay in a pane shorter than the card. The 1440×900 and 1440×500 measurements prove the fix. 390×844: banner drawer 68/68 and 146/146. Screenshots and measurements are kept with the builder's local evidence. A live lab run on a built candidate was not done (no candidate built for this branch).
- [x] 2.5 Rebased on `fork/main` 6456171fe0 (upstream `desktop-v0.50.1` synced), 2026-11-27. The mount anchor moved to `ThreadScreen.tsx:688-690` and now matches upstream 0.50.1 byte for byte after the fix. Upstream rewrote `renderScreen` in `ThreadScreen.test.tsx`, so the test takes an optional `wrap` after the new `timeline` argument; the obsolete `ThreadContextCard` mock from the first commit is gone and `vi.restoreAllMocks()` is in `afterEach`. Re-run: the test fails on the base (1 failed / 10 passed, `expected false to be true`) and passes with the fix; `ThreadScreen` plus `components/plugin`: 75 files / 713 tests passed; `@bb/app` typecheck exit 0; `@bb/app` lint 0 warnings, 0 errors. Browser check repeated with the same harness and Chromium 1248, dark and light: 1440×900 and 1440×500 before 44/68 and 122/146, after 68/68 and 146/146; 390×844 drawer 68/68 and 146/146; 1440×170 80/146 before and after (cap only).
- [ ] 2.3 Patch ledger in bb-plugin-lab: no new row. In the row of the plan-dock patch that added the wrapper (0ba48f3669, 41361a7df0), record that the wrapper is removed and the card mount matches upstream again.
- [ ] 2.4 `reviewer-arch` review (coordinator).
