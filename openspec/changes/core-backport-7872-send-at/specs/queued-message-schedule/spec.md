## ADDED Requirements

### Requirement: A sender's time survives a dispatch wait

The core SHALL keep a queued message's sender time (`sendAt`) whatever the row waits on, and SHALL NOT dispatch the message before that time. A `message.dispatch` plugin's re-ask time SHALL be stored separately (`recheckAt`) and SHALL NOT replace or clear the sender's time.

#### Scenario: Plugin wait on a scheduled send

- **WHEN** a send with a future `sendAt` meets a hook that answers `wait` with a `recheckAt`
- **THEN** the queued row keeps `sendAt` and stores `recheckAt`, and when the plugin later proceeds before `sendAt`, the row becomes a time wait with the same `sendAt` and no turn starts

#### Scenario: New thread's first message held at creation

- **WHEN** a thread is created with a future `sendAt` and its first dispatch meets a plugin `wait`, and the plugin then calls `recheck("message.dispatch")` and proceeds
- **THEN** no turn starts before `sendAt`, and the message is sent once `sendAt` is reached

#### Scenario: A wait that clears without the plugin

- **WHEN** a plugin wait on a scheduled row is cleared because the plugin stopped, or the row is requeued because its host went offline
- **THEN** the row keeps its `sendAt`

### Requirement: Wait decision contract

The core SHALL accept `recheckAt` on a `wait` decision, SHALL treat a legacy `sendAt` on a `wait` as `recheckAt`, and SHALL fail the dispatch attempt when a decision sets both. The reported plugin SDK version SHALL stay unchanged by this backport.

#### Scenario: Legacy field

- **WHEN** a hook built against an older SDK answers `wait` with `sendAt`
- **THEN** the core stores it as the re-ask time and leaves the sender's time unchanged

### Requirement: Fork migration reconciles with upstream

The fork migration that adds `recheck_at` SHALL be byte-identical to upstream `0162`. After a sync brings upstream `0162`, migration SHALL succeed on every database, SHALL leave exactly one `recheck_at` column and index, and SHALL NOT apply `0162`'s data move to rows that the fork migration already moved.

#### Scenario: Database that ran the fork migration

- **WHEN** a database that ran fork `0007` migrates with a `drizzle/` that contains upstream `0162`
- **THEN** migration succeeds, every queued row keeps its `send_at`, `recheck_at` and `state`, and a second run changes nothing

#### Scenario: Fresh database after the sync

- **WHEN** a fresh database migrates with a `drizzle/` that contains upstream `0162`
- **THEN** upstream creates the column, and fork `0007` is recorded in the fork ledger without running

#### Scenario: Interrupted migration

- **WHEN** a run stops after staging and before restoring
- **THEN** the next run restores the staged values, with or without upstream `0162` present

#### Scenario: Previous build on the migrated database

- **WHEN** the build before this backport starts on a database that ran fork `0007`
- **THEN** its migration succeeds and leaves every queued value unchanged
