# Design

## Mount, not the cap

The cap in `PluginThreadContextCard.tsx` is correct where upstream mounts the card: in the overlay, a definite-height flex column with `py-3`, `calc(100% - 1.5rem)` is the overlay's content box minus 1.5rem, and 36rem bounds tall panes. The defect is the content-sized wrapper the fork put between the overlay and the card. Two fixes were considered:

| Option | Effect | Chosen |
|---|---|---|
| Remove the wrapper (restore upstream mount) | Cap works as designed; fork diff shrinks; nothing else changes | yes |
| Change the card's `max-h` to `max-h-full` and keep the wrapper | Also fits, but adds a second fork delta in a file upstream 0.50.1 edits, and keeps a wrapper that has had one child since 41361a7df0 | no |

The wrapper carried `[&>[data-thread-context-card]]:min-h-0 shrink`. As a direct flex child the card is `shrink-0` again, as in upstream: it does not shrink, its `max-h` cap bounds it, and above the cap it scrolls inside itself (`overflow-y-auto`).

## Cap

"Up to a sensible cap" is the existing one: the smaller of 36rem (576 px) and the overlay's content box minus 1.5rem. Below the cap the card is exactly as tall as its rows; above it, the card scrolls inside itself. At the cap the `shrink-0` card can push the table of contents (its `my-auto` sibling) out of the overlay, which clips it; that is unchanged from upstream and out of scope here. No new constant.

## Widths and themes

- **1440 and other wide panes:** layout `gutter` or `shift`; the card renders in the overlay and is fixed by this change.
- **390 with a mouse or trackpad:** layout `banner`; rows render in the header popover with its own `100dvh` cap, unaffected. The check confirms all rows show.
- **390 with a coarse pointer (phone):** the experiment gate turns the card off (`ThreadDetailView.tsx:298-300`), unchanged.
- **Dark and light:** no colour or token changes; checked for clipping only.

## Verification

- Unit: `ThreadScreen.test.tsx` renders the page presentation inside a `ThreadContextCardProvider` with `enabled` and one core row, with `clientWidth` spied to a gutter-wide pane (jsdom reports 0, which would keep the `banner` layout and render no card; same technique as `PluginThreadContextCard.test.tsx`), and asserts that `[data-thread-context-card]`'s parent element is `[data-scroll-overlay]`. jsdom cannot measure layout, so this pins the cause, not the pixels. It fails on `fork/main` and passes with the fix.
- Browser: two and five rows at 1440×900, 1440×500 and 390×844, dark and light: `card.scrollHeight <= card.clientHeight`. Five rows are about 146 px, below the cap at 1440×500 (about 412 px), so the cap needs its own case: a 1440×170 viewport (overlay content box 106 px, cap 82 px) with five rows must give `clientHeight` ≈ the cap and `scrollHeight > clientHeight`.
