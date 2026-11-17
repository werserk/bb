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
An explicit clearPendingSendScope boundary is available for logout. Its behavior
is unit-tested; actual auth/logout integration remains unproven.

## Verification and delivery boundary

The implementation builder commits only its isolated core branch. The controller
owns independent review, live Electron/Chrome reload races, targeted isolated DOM
proofs and stored-format P/C/P/stock rehearsal. Unit mocks do not prove those.
Release/rollback/install, main merge, push and PR are outside builder authority.
Core-host-contract release remains owner-only.

The plugin-owned fork patch ledger is outside this builder's authorized write
scope. Proposed row for the controller to apply there:

| Patch                | Change                    | Paths in core                                                                                                                                                                                                                     | Migrations / protocol                            | Upstream status           | Retire when                                                                                                    | State                                                                        |
| -------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Pending send overlay | core-pending-send-overlay | domain/event and queue types; server-contract/SDK send and snapshot DTOs; DB queue ID assignment; server send/queue/provision/lineage; thread-view user projection; client-core overlay/journal; app mutation/cache/render owners | none; optional stored JSON and derived queue IDs | downstream, not published | upstream has equivalent continuously visible owner send custody and causal queue/request/reload reconciliation | isolated candidate; review/runtime/compatibility proof pending; not released |
