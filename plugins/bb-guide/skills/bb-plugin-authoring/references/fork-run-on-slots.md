# Run on picker slots (fork)

Fork-only and experimental: call `app.slots.experimental_runOnProvider?.(...)`
and `app.slots.experimental_composerRunRowItem?.(...)`; stock bb has neither,
and then the provider stays in its machine section with its
`experimental_environmentProviderInputs` control.

- `experimental_runOnProvider` registers `{ version: 1, environmentProviderId,
title, description?, order?, useChoices, useThreadWorkspace, ThreadActions? }`
  for one of this plugin's own environment providers; core ignores it when
  another plugin owns the provider. The New Thread "Run on" menu shows a group
  with `title` and `description` below the Local machines and stops listing
  the provider under its machine. `useChoices({ projectId })` is a React hook
  returning `{ status, choices, error? }`; each choice is `{ id, agentHostId,
inputs, workspace, disabledReason? }`. Choosing it selects the provider on
  `agentHostId` and seeds its inputs with `inputs`; `workspace` is `{ hostId,
label?, detail?, branch?, issue? }`. `useThreadWorkspace({ threadId, inputs })`
  returns the workspace of an open thread created by the provider, or null;
  `ThreadActions` receives `{ threadId }` and renders in the open thread's
  Run on popover.
- `experimental_composerRunRowItem` registers `{ version: 1, id, order?,
component }`, an item in the row under the composer. Every item sits after
  Run on; `order` (default 0, lower first, ties by plugin id then item id)
  sorts items among themselves. The component receives `{ scope, compact,
submission?, setSubmission? }`. `scope` is `{ kind: "new-thread", projectId,
providerId }` or `{ kind: "thread", threadId, projectId }`; render icon-first
  when `compact`. New thread only: `setSubmission(data | null)`, a plain
  function, holds this plugin's data for the send's single `pluginSubmission`,
  stores a JSON copy and returns false when another plugin holds it, the value
  does not survive a JSON round trip (undefined, functions, Map, Date, NaN,
  BigInt, cycles) or the JSON is over 16 KB;
  `submission` is the data core holds for this plugin, so a remounted item can
  restore its pick. Core keeps it while a create is refused or fails and clears
  it after a successful create and when the new-thread scope (project or agent
  provider) changes.
