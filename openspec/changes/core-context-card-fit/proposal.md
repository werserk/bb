# Thread context card fits its rows

## Why

With the `threadContextCard` experiment on, the card at 1440 px is 44 px tall while its content is 68 px: the second row (the pool's account row, U1) is cut in half and reachable only by scrolling inside the card (designer's live crop of the card). The owner wants the card to show every row it has without scrolling (owner decision 2026-11-27).

Cause (checked in source, `fork/main` 6597674a8d): the card's own cap is `max-h-[min(36rem,calc(100%-1.5rem))]` (`apps/app/src/components/plugin/PluginThreadContextCard.tsx:387`). Upstream mounts the card directly in the scroll overlay, a definite-height flex column, so `100%` is the overlay's content box (the pane minus the overlay's `py-3`). Fork commit 0ba48f3669 wrapped the card in a `div` (to stack the plan above it), and 41361a7df0 later moved the plan out but kept the wrapper (`apps/app/src/views/thread-detail/ThreadScreen.tsx:651-653`). The wrapper is a `shrink-0` item of that definite column, so its height counts as definite (CSS Flexbox §9.8) and equals its content, the card. `100%` therefore resolves to the card's own content height, and the card is always that minus 1.5rem: 68 − 24 = 44 px, exactly the measured clip. (Had the wrapper been indefinite, the percentage would compute to `none` and nothing would clip.) The clip therefore hits every card shorter than the pane, at every width.

## What Changes

- Remove the fork's single-child wrapper around `<ThreadContextCard />` in the page presentation of `ThreadScreen.tsx`, so the card is again a direct child of `[data-scroll-overlay]`, as in upstream `desktop-v0.49.0`. The card's existing cap (36rem, or the pane height minus 1.5rem, whichever is smaller) then applies as designed: a card shorter than the cap shows all rows; a longer one scrolls inside itself.
- No change to the card component, its layout modes (gutter, shift, banner), the banner popover (its cap uses `100dvh` and is unaffected), the pin button or plugin slots.
- A structural regression test pins the mount (the card's parent is the overlay), and the browser check measures that the card does not scroll internally with two and with five rows, and that a pane shorter than the rows caps it.

## Capabilities

### New Capabilities

- `core-thread-context-card`: the card shows all its rows up to a cap.

## Impact

- Code: `apps/app/src/views/thread-detail/ThreadScreen.tsx` (about −2/+1 lines) and one test in `ThreadScreen.test.tsx`. The fork's diff against upstream shrinks.
- Release class: a UI-only delta over `fork/main` (app bundle only; no migration, no daemon protocol, no dependency change); it reaches daily with the 0.50.1 sync release, which is `data-protocol` and needs the owner's yes.
- Upstream: not proposed. The defect exists only in the fork.
- Collisions: none of `core/composer-context-sheet` (stale, already ported into `fork/main` as f83901b733), `core/context-panel-single-section`, the `composer-context-*` builder branch or `core-pending-send-intake` touches the card or its mount. Upstream `desktop-v0.50.1` changes `PluginThreadContextCard.tsx` (slot hook, shared resize observer) and 64 lines of `ThreadScreen.tsx`; restoring the upstream mount makes that merge smaller, not larger.
- Size: one `builder-claude` slice, under 40 lines including the test. Branch `core/context-card-fit` from current `fork/main`.
