## ADDED Requirements

### Requirement: Plugins can present their environment provider as a Run on group

The fork SHALL expose `app.slots.experimental_runOnProvider` with `version: 1`. Core SHALL accept a registration only when the registering plugin owns the named environment provider, and SHALL render each accepted registration as a group under the Local machines in the new-thread Run on menu. Core SHALL ignore a registration with an unknown version, for a provider the plugin does not own, or for a provider that already has one, and SHALL log one warning for each.

#### Scenario: Worker group renders under Local

- **WHEN** account-workers registers "On a worker" for its provider `account-workers.worker` with the choice `machine-b → machine-a` for the current project
- **THEN** the Run on menu shows the Local group first and then "On a worker" with the row `machine-b → machine-a`, and the machine section of machine-b does not list the provider a second time

#### Scenario: Registration for another plugin's provider

- **WHEN** a plugin registers a group for an environment provider whose owning plugin is a different plugin
- **THEN** no group renders for it and core logs one warning

#### Scenario: Unknown version is skipped

- **WHEN** a plugin registers a group with `version: 2` on a fork that knows only version 1
- **THEN** the menu shows no group for it, core logs one warning, and the rest of the composer works

#### Scenario: Projectless new thread

- **WHEN** the new-thread composer has no project selected
- **THEN** no Run on groups render

#### Scenario: Plugin crash is contained

- **WHEN** a registration's `useChoices` throws
- **THEN** that group is absent and the Local group and Send still work

### Requirement: Choosing a worker row is a stock provider selection

Choosing a row SHALL select the registered provider on the row's agent host and seed the provider inputs with the row's `inputs`, and SHALL change nothing else about the new-thread request. The request SHALL equal the one the stock picker produces for the same draft, provider, host and inputs.

#### Scenario: Parity with the stock picker

- **WHEN** the user sends text, an image, a file and a file mention with a chosen model, reasoning level, permission mode, service tier, session options and a Send later time, once through the row `machine-b → machine-a` and once through the stock selection of `account-workers.worker` on machine-b with the same inputs
- **THEN** the two create requests are equal

#### Scenario: Models and options follow the agent host

- **WHEN** the user picks `machine-b → machine-a`
- **THEN** the model list, reasoning, permission modes, service tier and session options are those of machine-b

#### Scenario: Workspace changed in the plugin control

- **WHEN** the user picks `machine-b → machine-a` and then changes the workspace in the provider's inputs control to a value no row has
- **THEN** the chip shows the agent host with "Choose a workspace" and does not show a workspace the request will not carry

### Requirement: The chip names where the agent runs and where the files are

The Run on chip SHALL show the local host name for a Local selection and `agent → workspace` for a worker choice. For an open thread, core SHALL show the `agent → workspace` chip only when the thread's environment provider has an accepted registration, SHALL take the agent from the thread's environment host, and SHALL take only the workspace from the plugin. A remembered choice that is not available SHALL fall back to the default Local host, and the chip SHALL show that host.

#### Scenario: Worker selected for a new thread

- **WHEN** the user picks `machine-b → machine-a`
- **THEN** the chip reads `machine-b → machine-a`, the menu footer shows the workspace detail, and the branch chip shows the workspace's branch

#### Scenario: Open worker thread

- **WHEN** an open thread's environment came from `account-workers.worker` on machine-b and the plugin reports workspace `machine-a`
- **THEN** the chip reads `machine-b → machine-a`, its popover shows the agent as locked, the workspace, its detail and the plugin's thread actions, and the branch chip shows the workspace's branch

#### Scenario: Plugin cannot relabel other threads

- **WHEN** a plugin's registration is accepted for its own provider and the open thread was created by a stock local environment
- **THEN** the row shows today's machine label

#### Scenario: Plugin gone

- **WHEN** the remembered choice is `machine-b → machine-a` and the plugin is disabled
- **THEN** the chip shows the default Local host and sending uses that host

### Requirement: File mentions come from the workspace

For a worker choice and for an open worker thread, core SHALL take `@file` mention suggestions from the project's source on the workspace host and SHALL insert the path relative to the project root. Commands and skills SHALL keep coming from the agent host.

#### Scenario: Mention in a new worker thread

- **WHEN** the user picks `machine-b → machine-a` and types `@READ`
- **THEN** the suggestions list files of the project on machine-a, choosing `packages/db/README.md` inserts that relative path, and the slash commands are those of machine-b

#### Scenario: Mention in an open worker thread

- **WHEN** an open thread runs on machine-b with workspace machine-a and the user types `@`
- **THEN** the suggestions list files of the project on machine-a, not of the scratch directory on machine-b

### Requirement: Unavailable choices are visible and block send with a reason

Core SHALL compute agent and workspace host availability from the hosts list and the provider's per-host availability. A choice whose agent or workspace host is offline, whose provider is unavailable on the agent host, or that has a plugin `disabledReason`, SHALL be disabled with its reason. A selected choice that becomes unavailable SHALL turn the chip amber and block Send with the reason through the existing new-thread blocker.

#### Scenario: Worker goes offline while selected

- **WHEN** `machine-b → machine-a` is selected and machine-b disconnects
- **THEN** the chip reads `machine-b offline → machine-a` in amber and Send is blocked with "Worker machine-b is offline"

#### Scenario: Open thread with worker offline

- **WHEN** an open worker thread's agent host is offline
- **THEN** the chip is amber and its popover says when the worker was last seen and that the next turn waits

#### Scenario: Plugin reports an issue for a thread

- **WHEN** `useThreadWorkspace` returns `issue: "Workspace unbound"`
- **THEN** the chip is amber and the popover shows "Workspace unbound"

### Requirement: Plugins can add items to the run row

The fork SHALL expose `app.slots.experimental_composerRunRowItem` with `version: 1`, rendered after the Run on chip in the new-thread and open-thread rows. A new-thread item's `setSubmission` value SHALL be sent as the existing single `pluginSubmission` with the item's plugin id.

#### Scenario: Account chosen for a new thread

- **WHEN** the pool's account item sets `{ policy: { mode: "named", accountId: "acc-2" } }` and the user sends
- **THEN** the create request's `pluginSubmission` is the pool's id with that data

#### Scenario: Legacy single submission still works

- **WHEN** a plugin calls `useComposer().submit({ experimental_data })` and no row item holds data
- **THEN** that plugin's data is sent as before

### Requirement: A send carries at most one plugin submission

Core SHALL refuse a row-item submission over 16 KB and SHALL let only one plugin hold it at a time. Core SHALL refuse a send where a row item and a `useComposer().submit` from different plugins both supply data, and SHALL keep the draft.

#### Scenario: Two plugins want the submission

- **WHEN** the pool's row item holds data and another plugin calls `submit` with its own data
- **THEN** no thread is created, the draft is kept, and the reason names the conflict

#### Scenario: Refused create keeps the account choice

- **WHEN** the account item holds a named account and the create is refused or fails
- **THEN** the draft and the account choice are kept and the chip still shows the named account

#### Scenario: Submission cleared on project change

- **WHEN** the account item holds data and the user switches the project or the agent provider
- **THEN** the submission is cleared and the chip shows Auto

### Requirement: Run on works at 390

At compact widths the Run on menu, the open-thread popover and the account menu SHALL open as bottom drawers, and the run row SHALL stay on one line with the Run on and account chips visible.

#### Scenario: Phone width

- **WHEN** the composer is 390 px wide and the user taps the Run on chip
- **THEN** a "Run on" drawer opens with Local and "On a worker" stacked, the branch chip is hidden, and the project chip is icon-only and still opens the project menu
