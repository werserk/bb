## ADDED Requirements

### Requirement: The card shows all its rows up to a cap

The thread context card SHALL be as tall as its rows when they fit under the cap, which is the smaller of 36rem and the scroll overlay's content box minus 1.5rem. Only content taller than the cap SHALL scroll inside the card.

#### Scenario: Two rows at 1440

- **WHEN** a thread's card has the parent row and the account row, at 1440×900 in dark or light theme
- **THEN** both rows are fully visible and the card does not scroll

#### Scenario: Short pane

- **WHEN** the card's rows are taller than the scroll overlay's content box minus 1.5rem
- **THEN** the card stops at that height and scrolls inside itself

#### Scenario: Banner layout at 390

- **WHEN** the pane is 390 px wide with a fine pointer and the user opens the header's thread context popover
- **THEN** every row is visible without scrolling unless the rows exceed the popover's existing cap
