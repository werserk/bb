## ADDED Requirements

### Requirement: Committed raw and byte custody

The core SHALL enforce these conditions:

A negotiated identified send receives accepted only after committed raw-envelope, identity/hash/order and actual byte ownership custody. Same-project inventoried attachments need no asynchronous preparation before this checkpoint. Cross-project/uninventoried byte custody delays acknowledgement until copy/inventory and target pin commit.

#### Scenario: Inventoried input custody

- **WHEN** an identified negotiated send has inventoried input
- **THEN** accepted follows the raw custody transaction before asynchronous preparation

#### Scenario: Cross-project byte custody

- **WHEN** input needs copying or inventory
- **THEN** acknowledgement waits for actual byte ownership

### Requirement: Replay identity and legacy ingress

The core SHALL enforce these conditions:

Replay returns retained receipt; changed original identity conflicts. Legacy/no-ID ingress shares ordering but retains truthful old receipts and no invented retry identity.

#### Scenario: Replay and legacy identity

- **WHEN** a duplicate identified request or a no-ID legacy request enters the lane
- **THEN** replay preserves its retained receipt, changed identity conflicts, and legacy ingress receives no invented retry identity

### Requirement: Original dispatch and parent handoff

The core SHALL enforce these conditions:

The head enters the original inline path with unchanged request semantics and hook/mention context. A successor cannot enter before the head's committed native queue/request/start handoff or standalone clear completion. compactFirst holds its parent through the subsequent original-message handoff.

#### Scenario: CompactFirst parent handoff

- **WHEN** preparation is held or only a compactFirst subrequest commits
- **THEN** the next intake waits for the original parent handoff with original request and hook context

### Requirement: Native scheduling and independent threads

The core SHALL enforce these conditions:

Native schedule/steer/group/reorder semantics remain authoritative after transfer. Other threads and new custody acknowledgements remain independent.

#### Scenario: Native order after transfer

- **WHEN** native custody commits for the head
- **THEN** native schedule, steer, grouping and reorder rules remain authoritative while other threads remain independent

### Requirement: Revision guards and stale-worker fencing

The core SHALL enforce these conditions:

Pre-seal edit/cancel use revision CAS. After seal, 409 means no edit/cancel and custody/content stays canonical. Retained failures are visible, never expire silently or imply successful handoff. Restart recovers staging/pending and expired claims across all thread statuses; stale claims cannot commit at any of the six effect seams.

A `message.dispatch` hook pass is not an effect seal: only mention/model/clear/compact/startup effects and the provider request seal a row. A row interrupted (stop, crash, expired lease) before its first seal is resent once with its hooks re-run (a hook may run twice per message; documented for plugin authors). If the resent attempt is interrupted or fails again, the row is abandoned: terminal `rejected` with an `intake_abandoned` receipt and a clear `last_error`, and the thread is unblocked.

#### Scenario: Interrupted hook pass is resent once, then abandoned

- **WHEN** the server stops mid-hook, restarts, and the resent attempt succeeds
- **THEN** the provider receives the message once, in order
- **WHEN** the resent attempt is interrupted again
- **THEN** the row is rejected as `intake_abandoned` and the next send on the thread is accepted

#### Scenario: Sealed revision conflict

- **WHEN** edit or cancel races a revision change or effect seal
- **THEN** 409 preserves custody and does not perform the requested action

#### Scenario: Restart and stale claim

- **WHEN** restart encounters staged, pending or expired work in any thread status
- **THEN** recovery retains work and a stale claim cannot commit through any effect seam

### Requirement: Uncertainty and terminal anchors

The core SHALL enforce these conditions:

Uncertain sealed external effects require evidence or retained recovery failure, not an exactly-once claim. Terminal rows retain identity/hash/receipt/order until thread deletion, payload compacted when safe.

#### Scenario: Terminal retention

- **WHEN** a send reaches safe terminal or native handoff custody
- **THEN** identity, hash, receipt and order anchors remain until thread deletion and only safe payloads compact

#### Scenario: Deletion rollback and commit

- **WHEN** a real thread-delete cascade is rolled back or committed while waiters exist
- **THEN** rollback preserves live rows and waits, while committed deletion retires vanished-row waiters with intake_not_deliverable

### Requirement: Failed-head recovery policy

The core SHALL enforce these conditions:

Failed heads block following intake preparation. Unsealed failures permit revisioned retry/cancel. Sealed failed rows expose their recorded effect stage and accept only revision-CAS reconcile: the server searches committed native evidence in one transaction.

#### Scenario: Failed-head explicit recovery

- **WHEN** a head fails before or after seal
- **THEN** followers remain blocked, unsealed work permits revisioned retry or cancel, and sealed work permits only evidence reconciliation

### Requirement: Authoritative parent handoff proof

The core SHALL enforce these conditions:

Genuine original queue/request/first-start/clear custody transfers the same row and retains its truthful native receipt without execution or resend. No proof preserves unresolved failed content and the blocked lane. First-start intent alone and compactFirst compact-only proof cannot release the parent. Reconcile never accepts a client assertion of delivery.

#### Scenario: Evidence for the original parent

- **WHEN** revisioned reconciliation searches native evidence
- **THEN** only committed original queue, request, first-start or clear custody transfers the row without execution; absent proof, start intent or compact-only proof retains the failed parent

### Requirement: Pre-effect and post-seal errors

The core SHALL enforce these conditions:

Deterministic4xx before any seal becomes terminal rejected with original status/body replay and no failed lane residue. Post-seal 4xx remains retained uncertainty; the originating legacy request and same-ID replay preserve its original status/code/message with retained-custody/recovery details.

#### Scenario: Original rejection replay

- **WHEN** a deterministic 4xx occurs before seal or an error occurs after seal
- **THEN** pre-seal rejection is terminal and replayable, while post-seal uncertainty preserves its original error and retained-custody details

#### Scenario: Malformed stored receipt

- **WHEN** nativeReceipt text fails JSON or response-schema validation
- **THEN** current waiters reject with retained-custody intake_blocked and unregister without changing the row, resending, releasing its lane or leaving an unhandled parse rejection

### Requirement: Healthy legacy waits and guard recovery

The core SHALL enforce these conditions:

Typed pre-effect guard collisions use a one-shot release wake plus finite backoff with at most 3 automatic retries. Old success receipts stay sent/queued. Healthy preparation, healthy predecessors and active inline tails preserve their original awaited result without an unconditional 30s HTTP deadline.

#### Scenario: Healthy head and inline tail

- **WHEN** healthy preparation, a follower or an active inline tail exceeds 30 seconds
- **THEN** the legacy caller keeps awaiting its original single-effect sent or queued receipt or actual failure or stop

#### Scenario: Pre-effect guard collision

- **WHEN** a typed pre-effect guard collision prevents entry
- **THEN** a one-shot release wake and finite backoff permit at most three automatic retries

### Requirement: Blocked legacy and lifecycle settlement

The core SHALL enforce these conditions:

Unknown failed/blocked legacy waits receive bounded 409 intake_blocked with explicit retained custody when a genuinely failed head is observed. Worker failure and lifecycle stop still settle waiters with truthful retained-custody errors. No timeout silently cancels, discards or acknowledges a handoff.

#### Scenario: Genuinely failed head or stop

- **WHEN** a head actually fails or its worker stops
- **THEN** legacy waiters settle with truthful retained-custody errors without cancellation, discard or a forged handoff

### Requirement: Dedicated context and native drain boundary

The core SHALL enforce these conditions:

Pending intake is not totally ordered against dedicated context clear/compact or native drain. Like native queued messages, a send admitted before a dedicated clear may deliver afterward. Pure intake preparation cannot prevent native drain; native scheduling/group/steer ordering remains unchanged.

#### Scenario: Independent clear and drain

- **WHEN** a dedicated context action or native drain occurs while intake preparation is held
- **THEN** it retains native scheduling and group or steer order; an admitted send may deliver after an independent clear

### Requirement: Command classification parity

The core SHALL enforce these conditions:

Selected standalone builtins through either send route still enter the lane; raw/mixed command input retains its native classification and hook context.

#### Scenario: Selected or mixed command input

- **WHEN** either participating send route receives standalone builtins or raw or mixed command input
- **THEN** the send remains in the shared lane with native classification, runtime intent and hook context

### Requirement: Generated storage and client integration

The core SHALL enforce these conditions:

The new table uses a generated migration/snapshot and real migrated SQLite regressions. The accepted fixture prerequisite is not proof of this migration. A supplies truthful typed server capability/receipt/minimal read/actions. B supplies UI/SDK/CLI, joint canonical observation and harness deltas before enablement.

#### Scenario: Client enablement

- **WHEN** admission is enabled for UI, SDK or CLI
- **THEN** the actual generated migration has meaningful real-SQLite coverage and clients integrate joint canonical observation and harness deltas

### Requirement: Managed rollback and release authority

The core SHALL enforce these conditions:

C supplies the separately reviewed managed rollback barrier and old-binary-open-new-DB fixture. No release is authorised by these requirements.

#### Scenario: Incompatible rollback and release

- **WHEN** an incompatible target is considered with open custody or a release is requested
- **THEN** the separately reviewed rollback barrier refuses unsafe rollback, its old-binary fixture remains required, and this specification grants no release authority

### Requirement: Intake behind a server setting

The core SHALL enforce these conditions:

The server experiment `sendIntake` defaults off and gates admission of new sends into the intake lane; rows stored while it was on stay deliverable and visible.

#### Scenario: Setting off

- **WHEN** `sendIntake` is off and a send enters a thread without open rows
- **THEN** it dispatches or queues as before, no `thread_send_intakes` row is written, and `send-admission` answers 404 `intake_disabled`

#### Scenario: Setting on

- **WHEN** `sendIntake` is on and the same send enters
- **THEN** it is stored as an intake row before preparation and ends transferred with its native handoff

#### Scenario: Setting turned off with open rows

- **WHEN** `sendIntake` is turned off while a thread has an open intake row
- **THEN** a later send to that thread is delivered after the row, a send to another thread uses the legacy path, and the read and action routes still serve the row

#### Scenario: Legacy deferred startup sweep

- **WHEN** the startup sweep delivers a legacy deferred send before the worker is ready
- **THEN** it bypasses the lane and does not wait on the worker
