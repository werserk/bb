# Pending send overlay

Change: `core-pending-send-overlay`, approved .154 base
`afc3d72b5b1899566034fc671633b84d8ce763d8`.

The app owns local sends outside Query caches in `pending-send-owner.ts`.
`PendingSendOverlay` composes owner content after the native authoritative timeline
merge and with the native queue list. The same controller serves native and
embedded ThreadChat. Delivery status and actions attach to the native owner
message; only recovery state uses the shared banner. Composer and Send now no longer insert or remove optimistic
timeline/queue cache rows. Status predictions remain a separate concern. Unchanged
projections preserve input arrays and row/child references; filtered ancestry uses
copy-on-write. A weak projection memo is cleared on custody changes, so acknowledged
or hidden owner payloads are not retained by a second content cache. Presentation
context remains stable until owner state or the rendered thread changes.

Each owner action has an optional UUID `clientSubmissionId`. Public ingress
coalesces concurrent identical requests, rejects conflicts, searches the latest
1000 requested events and the derived queue key, and rechecks before insertion.
The immediate transaction recheck uses the sequence captured before the initial
check, plus the queue key. Only events newer than that fence can race preparation.
Internal queue/retry dispatch legitimately preserves admitted membership and
bypasses public submission deduplication. This is bounded replay protection,
not global exactly-once execution after pruning or the retention window.

Ordinary identified queue IDs are server-derived `qsub_<UUID>`. No schema,
migration, daemon field, dependency or index is added. Requested event JSON carries
per-group `clientSubmissions` and `sourceQueuedMessageIds`; deferred/retry rows
resolve their original memberships through existing source-request lineage.
Retry dispatch preserves its stored agent-only payload and continuation behavior.
For a replay of several original groups, source group boundaries partition that
stored payload; membership offsets follow those groups. A native continuation
nudge is one actual group and retains every source member at index zero.
Common serializers retain these optional fields. Parent-system callers omit them;
fork history copies retain JSON without sharing source-thread overlay ownership.

`GET /capabilities/pending-send-overlay` is a direct local v1 capability; Send
does not wait for it. The SDK exposes it under `system.pendingSendOverlay()`.
`threads.queueSnapshot()` reads queue presence, bounded event placements and the
watermark in one SQLite read transaction. Existing queue-list arrays remain
unchanged. The CLI exposes `bb thread queue snapshot <threadId> [queueIds...] --json`
and `bb thread tell --client-submission-id <uuid>` for the same contracts.
Placement lookup admits batches of at most 100 events, at most 2000
rows / 2 MiB JSON / 100 ms processing before admitting more work. An admitted
batch may overshoot; diagnostics report actual rows, bytes and elapsed time.
Uncovered or pruned history stays unresolved. Absence does not invent a reason.

Legacy sent receipts use a joint post-receipt timeline AND queue read before
handoff (M1). Neither pre-receipt reads nor cached/push data discharge that fence.
While that legacy fence is open, new canonical user/queue pushes after the
send-start baseline stay behind the same presentation fence. Authoritative caches
remain intact; the joint apply replaces the pending presentation in one batch.
The owner serializes reconciliation and debounces automatic handoff reads in
250 ms windows. Cached pushes always contribute matching identity facts, including
for unconfirmed/unresolved entries, without starting a read per frame. Explicit
invalidation can reconcile acknowledged queue aliases even when their request is
outside the visible window. Definitive failures do not drive automatic reads.
Reads use deferContent and at most eight timeline segments; ordinary reconciliation
observes facts without replacing the native timeline cache. A private bounded read
cannot retire visible custody ahead of native canonical coverage. The legacy joint
handoff applies its bounded deferred timeline and queue in one batch. Failed sent
handoff reads expose unresolved custody with Refresh/Hide. No text matching or
timeout acknowledges sends.

The optional versioned session journal uses exclusive Web Locks. A normal
navigation uses nonwaiting acquisition; a duplicate starts a fresh journal.
Reload waits for actual grant. While waiting, new sends remain in memory.
Refresh retries acquisition; Hide aborts only this document's lock request and
cannot read, delete or mutate the unowned journal (M2). Late grants are fenced by
generation and AbortSignal. Recovery never resends automatically. Journal failures
leave memory sending available with a reload warning. Scope includes origin,
primary host and server data root; an actual scope change disposes recovery and
clears the in-memory owner. Query garbage collection/removal does not clear custody.
The production app query client installs `bindPendingSendIdentity` before rendering.
It reads the built-in `bb-account.v1.status` RPC and consumes the existing
`bb-account` / `account` realtime signal broadcast by AccountService on sign-in,
sign-out, pairing adoption and credential invalidation. Reconnect rereads status;
ordinary transport disconnect does not discard custody. Identity uses base URL,
user ID and server ID, not profile names or every profile revision. Unknown identity
blocks journal restoration, while memory sends remain available. Logout or an actual
identity change calls `clearPendingSendScope`, forgets only owned journal custody,
aborts pending Web Lock waits and increments the generation. Old status reads,
reconciliation results and send/send-now receipts cannot affect the new identity.
The journal key includes that identity, origin, primary host and data root. There
is no separate core logout UI; the account plugin owns that action. Unit integration
covers the actual signal/RPC boundary; live account-switch proof remains separate.

## Verification and delivery boundary

The implementation builder commits only its isolated core branch. The controller
owns independent review, live Electron/Chrome reload races, targeted isolated DOM
proofs and stored-format P/C/P/stock rehearsal. Unit mocks do not prove those.
Release/rollback/install, main merge, push and PR are outside builder authority.
Core-host-contract release remains owner-only.

The plugin-owned fork patch ledger was updated in plugin commit
`aff9603fad23d7adc47be72089386a02efbc488b`. Core does not maintain a second draft row.

## Follow-up review dispositions

| Review item                   | Disposition and evidence                                                                                                                                                        | Remaining risk / owner                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| R1 same-sequence recovery     | Fixed: represented unresolved custody retires through observe, including journal entries; regression test                                                                       | Live trace: lab controller                                                      |
| R2 grouping                   | Fixed: settled queue filtering goes through adjacency repair; regression test                                                                                                   | None identified                                                                 |
| R3 empty queue reference      | Fixed: stable owner fallback arrays; queue hook passes absence through; projection identity test                                                                                | Query observer result objects follow normal TanStack semantics                  |
| R4 legacy subscription tag    | Fixed: legacy joint cache replacement syncs the applied tag; M1 batch remains intact                                                                                            | Old-server live proof: lab controller                                           |
| R5 observe cost               | Identity index cached weakly per immutable native rows array; each push builds it once, repeated queue pushes use indexed membership. 100k-row measurement retained in test log | Cold indexing is O(visible rows); live frames: lab controller                   |
| R6 / A1.7 multi-ID retry      | Production retry test covers accepted/unaccepted sources, two IDs in distinct original groups and two aliases; continuation retains all IDs at group zero                       | Live continuation: lab controller                                               |
| R6 / A1.8 contract allowlist  | Retained explicit baseline repair: pendingTodos.planId and timeline steps.id were already emitted but omitted from contract enumeration                                         | Removing these would restore a known baseline failure; reviewer checks scope    |
| R6 / A1.9 UUID casing         | Normalize through the shared ingress schema before deriving keys and dedup identity                                                                                             | No migration; previously persisted uppercase values are not rewritten           |
| R6 / A1.10 length heuristic   | Fixed: detect added row identities even if one canonical row is hidden; pending content no longer suppresses timeline error                                                     | Runtime frame proof: lab controller                                             |
| R6 / A1.11 mutation variables | Fixed: WeakMap prepares a copied request shared by lifecycle and mutationFn; original variables are unchanged                                                                   | Existing explicit-ID callers keep their identity                                |
| R6 / A1.12 legacy baseline    | Fixed: absent queue cache stays undefined rather than an authoritative empty baseline                                                                                           | Unknown pre-send queue content stays visible until M1 joint handoff             |
| R6 / A1.13 CLI snapshot size  | Deferred: debug command retains explicit server validation at 200 IDs; app reconciliation already chunks                                                                        | No custody risk; CLI batching follow-up belongs to parent, no silent truncation |
| R7 final-tree evidence        | Final source freeze precedes affected/full app checks and typecheck/build; report identifies exact tree and known baseline failures                                             | Independent review and packaged live proof belong to parent                     |

No release readiness is inferred from unit/typecheck/build evidence. Stored-format,
Chrome/Electron Web Locks and packaged native/embedded proof remain separate gates.
