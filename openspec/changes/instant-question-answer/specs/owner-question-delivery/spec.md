## ADDED Requirements

### Requirement: Durable card answers use active-turn injection when possible

The core SHALL attempt a fresh durable questionResponse through the existing claimed auto/steer path with expectedTurnId. Automatic steering SHALL send a provider command only when the negotiated steerMode is inject; other modes SHALL return the existing non-steerable result without interrupting the active turn. Explicit user steer SHALL retain its existing behavior. It SHALL retain policy, interaction, compaction, host, manual-stop and transactional claim guards.

#### Scenario: Idle answer

- **WHEN** an owner submits an answer while its thread is idle
- **THEN** the answer is dispatched now through the shared queue and recorded once

#### Scenario: Queue-mode ACP provider

- **WHEN** an automatic card-answer input targets the real queue-mode ACP bridge
- **THEN** the runtime returns busy without accepting the input or cancelling its active prompt, and existing recovery queues it once
- **AND** an explicit user steer still uses the bridge queue/cancel path

#### Scenario: Busy inject-capable provider

- **WHEN** a fresh answer targets an active provider turn that accepts injection
- **THEN** the auto request carries the expected active turn ID and the answer is submitted once

### Requirement: Refused injection preserves native card custody

The core SHALL record optional typed questionResponse questionId/revision/queuedMessageId on the stored request event. On a non-steerable or stale-turn rejection it SHALL atomically restore a questionResponse queue row, relink the same card and clear its submission receipt. It SHALL derive identity from typed history, never answer text. A recovered answer SHALL wait for the current turn to end and display Queued · will be sent after this turn.

#### Scenario: Provider cannot inject

- **WHEN** an active provider refuses a fresh card-answer request as non-steerable
- **THEN** exactly one replacement answer remains queued for the next input and repeated wakes do not repeat injection

#### Scenario: Stale expected turn

- **WHEN** the provider rejects the answer request because expectedTurnId is stale
- **THEN** the answer remains queued with the same original card custody and is not lost

#### Scenario: Duplicate submit or rejection

- **WHEN** the same answer or command rejection is delivered again
- **THEN** the current durable answer receipt is returned without another queued copy or request

#### Scenario: Withdrawn response

- **WHEN** a restored card answer is withdrawn before its next input
- **THEN** its replacement row cannot be dispatched

### Requirement: Additive history is compatible with legacy runtimes

An event without questionResponse SHALL retain its existing read semantics. Older .124/.139 readers SHALL ignore the optional event field. Upgrade and rollback SHALL preserve queued answer identity and card delivery receipts without new database columns or payload kinds.

#### Scenario: Legacy request event

- **WHEN** a request event has no questionResponse field
- **THEN** its existing reader result remains unchanged

#### Scenario: Older reader consumes new history

- **WHEN** an older runtime reads an event containing questionResponse
- **THEN** it ignores the unknown field and retains the existing request data

#### Scenario: Upgrade and rollback of queued answers

- **WHEN** a queued answer crosses .124 or .139 and candidate runtimes in either direction
- **THEN** the same card remains linked to the queued answer and consumption records its submission receipt
