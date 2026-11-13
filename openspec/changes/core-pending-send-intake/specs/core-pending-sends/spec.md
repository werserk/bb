# Pending-send intake requirements

## Admission

A negotiated identified send receives accepted only after committed raw-envelope, identity/hash/order and actual byte ownership custody. Same-project inventoried attachments need no asynchronous preparation before this checkpoint. Cross-project/uninventoried byte custody delays acknowledgement until copy/inventory and target pin commit. Replay returns retained receipt; changed original identity conflicts. Legacy/no-ID ingress shares ordering but retains truthful old receipts and no invented retry identity.

## Delivery

The head enters the original inline path with unchanged request semantics and hook/mention context. A successor cannot enter before the head's committed native queue/request/start handoff or standalone clear completion. compactFirst holds its parent through the subsequent original-message handoff. Native schedule/steer/group/reorder semantics remain authoritative after transfer. Other threads and new custody acknowledgements remain independent.

## Actions and recovery

Pre-seal edit/cancel use revision CAS. After seal, 409 means no edit/cancel and custody/content stays canonical. Retained failures are visible, never expire silently or imply successful handoff. Restart recovers staging/pending and expired claims across all thread statuses; stale claims cannot commit at any of the six effect seams. Uncertain sealed external effects require evidence or retained recovery failure, not an exactly-once claim. Terminal rows retain identity/hash/receipt/order until thread deletion, payload compacted when safe.

Failed heads block following intake preparation. Unsealed failures permit revisioned retry/cancel. Sealed failed rows expose their recorded effect stage and accept only revision-CAS reconcile: the server searches committed native evidence in one transaction. Genuine original queue/request/first-start/clear custody transfers the same row and retains its truthful native receipt without execution or resend. No proof preserves unresolved failed content and the blocked lane. First-start intent alone and compactFirst compact-only proof cannot release the parent. Reconcile never accepts a client assertion of delivery.

Deterministic4xx before any seal becomes terminal rejected with original status/body replay and no failed lane residue. Post-seal 4xx remains retained uncertainty; the originating legacy request and same-ID replay preserve its original status/code/message with retained-custody/recovery details. Typed pre-effect guard collisions use a one-shot release wake plus finite backoff with at most 3 automatic retries. Old success receipts stay sent/queued; unknown failed/blocked legacy waits receive bounded 409 intake_blocked with explicit retained custody, immediately for a failed head or after 30s of held preparation. No timeout silently cancels, discards or acknowledges a handoff.

Pending intake is not totally ordered against dedicated context clear/compact or native drain. Like native queued messages, a send admitted before a dedicated clear may deliver afterward. Pure intake preparation cannot prevent native drain; native scheduling/group/steer ordering remains unchanged. Selected standalone builtins through either send route still enter the lane; raw/mixed command input retains its native classification and hook context.

## Integration gates

The new table uses a generated migration/snapshot and real migrated SQLite regressions. The accepted fixture prerequisite is not proof of this migration. A supplies truthful typed server capability/receipt/minimal read/actions. B supplies UI/SDK/CLI, joint canonical observation and harness deltas before enablement. C supplies the separately reviewed managed rollback barrier and old-binary-open-new-DB fixture. No release is authorised by these requirements.
