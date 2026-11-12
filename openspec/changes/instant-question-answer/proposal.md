# Instant durable question answers

## Why

An accepted card answer waits for idle even when the active provider supports injection. Reusing auto/steer without durable card attribution would falsely leave the card submitted after a refused steer.

## What Changes

- Try existing claimed auto/steer with expectedTurnId for fresh questionResponse rows.
- Guard automatic injection with the negotiated bridge steerMode through the internal daemon/runtime call; explicit user steer is unchanged.
- Restore the existing questionResponse payload and card custody atomically after refusal or stale-turn rejection, then wait for the next input.
- Add optional typed questionResponse identity only to persisted request events. Do not infer identity from rendered text.
- Show Queued · will be sent after this turn for the busy fallback.
- Preserve legacy event reads and queued card custody across .124/.139 upgrade/rollback.

## Impact

Core domain history, queue/dispatch recovery, native delivery presentation and regression/compatibility tests. No database columns, SDK inputs, daemon wire or command changes. The internal daemon/runtime call and adapter capability getter change. This follow-up is a separate branch above the frozen pair, rebased onto Part C; no merge/release authority. Coordinator approved this history extension and delta on2026-11-12.
