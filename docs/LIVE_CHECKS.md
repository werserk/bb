# Live checks

Checks of the installed plugin with real threads and real accounts. Each entry
names the build, what was asked and what was observed. Accounts are A and B;
labels and ids stay local.

## P4: switching a thread's account between turns (build 17b4e84)

A new thread on a `server` machine. Turn 1 runs on auto; then
`bb pool thread set <thread> <B>`; then turn 2.

| Question | Claude (claude-code, Haiku 5.5) | Codex |
|---|---|---|
| Turn 1 | auto chose A; audit `pass-issued`, `select A` | not run |
| `set` named B | `ok`, revision 1, `switchContinuity: continues`; audit `policy B named-fallback-auto@cli` | not run |
| Turn 2 goes to B | yes: audit `switch B`; `get` gives serving B, route `pass` | not measured |
| Session continues | yes: one provider session id for both turns, no second env resolution, turn 2 recalled a word from turn 1 | not measured |
| Pass lifecycle | own `pt1` pass (`grandfathered: false`). On archive: audit `pass-revoked archived` at once, `archived-grace` in `bb pool pass list` for the 30 s undo grace, then gone | not run |

The Codex switch was skipped because the pool had no usable Codex account (both
subscriptions were at their weekly limit; the API key was disabled and was left
disabled). `switchContinuity` for Codex stays `may-restart`, and no
session-bound 400 classifier is added until a refusal is observed.

Two model calls were used.
