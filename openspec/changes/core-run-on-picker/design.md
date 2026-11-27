# Design

Source facts are from `fork/main` 6597674a8d (read 2026-11-27) unless marked otherwise. Line anchors move at `desktop-v0.50.1` (known moves: the new-thread send moves into `submitNewThreadRequest`, about `NewThreadComposer.tsx:725-777` and `:1915-1936`; `queued-messages.ts:597` becomes `:514`; slot registration goes through 0.50.1's `usePluginSlotKind`). Recheck every anchor after the sync.

## Boundaries: who owns what

| Concern | Owner |
|---|---|
| Thread creation, the request (input, attachments, mentions, model, reasoning, permission, service tier, session options, Send later), durable `create()`/`remove()`, a requested re-run of `create()`, `remove()` backoff, retirement | core, stock, unchanged |
| Model catalog, options, commands and skills of the provider's machine | core, stock (`resolveProviderRouting`, `NewThreadComposer.tsx:859-880`) |
| Picker grouping, `agent → workspace` chip, open-thread popover, workspace branch chip, row items, 390 | core, fork delta (presentation) |
| Which hosts are workers, the worker → workspace pairs, scratch, binding, profile checks, rebind | `account-workers` (environment provider + RPCs) |
| Account policy and its menu | account-pool plugin (U1) |

## Why environment providers (R-B1)

The first draft had the client call a plugin `prepare` before creating the thread and `release` after a failure. That was a client-side, non-durable copy of a step core already owns: a closed tab or a timeout after a server-side success left an orphan, which needed a TTL sweep, `expires_at` and a claim keyed on the scratch path. A stock environment provider removes all of these:

| Need | Stock mechanism (checked) |
|---|---|
| The thread runs on machine-b with files elsewhere | provider `create(ctx{host, thread, inputs, …})` returns `{status:"created", path, ownsPath, resource}` (`packages/plugin-sdk/src/environment-provider.ts`) |
| Binding by the real thread id | `ctx.thread.id` is present in `create()` |
| Cleanup | `remove(ctx{environment, resource, …})`, driven by core at retirement |
| Durable across Send later and restarts | the start intent `{type:"provider", environmentProviderId, machine, inputs}` is stored with the thread; provisioning runs after admission (`dispatch-attempt.ts:1092` → `scheduleThreadProvisioningAdvance`), so for Send later `create()` runs at the scheduled time |
| Bounded pre-checks | `validate` runs under the plugin decision timeout, default 10 s (`thread-environment-placement.ts:379-394`, `plugin-hook-registry.ts:25`). `create()` has no bound in core (checked: `environment-engine.ts:323-337` → `plugin-runtime.ts:900-962`; its signal is provisioning cancellation and plugin lifetime only), so the plugin owns a deadline (N1, tasks 4.4) |
| Retries | core re-runs `create()` with `attempt + 1` only when an errored environment is advanced for a `starting` thread (`environment-engine.ts:2091-2106`): a requested retry, not an automatic backoff. Only `remove()` backs off (`REMOVE_RETRY_MS`, 5 attempts) |
| A plugin control for the inputs | `app.slots.experimental_environmentProviderInputs` (props `{projectId, target, value, onChange}`) |
| Picker availability | provider `availability(ctx)`, exposed per host as `SystemEnvironmentProvider.machineAvailability` |
| No project checkout needed on machine-b | placement checks the host's project source only when the provider declares `requires.projectCheckout` (`thread-environment-placement.ts:231-234`, `:693-712`) |
| The hook knows its thread | `message.dispatch` sees `environmentIntent.kind === "provider"` with `environmentProviderId` and `inputs` (`backend-contract.ts:572-586`), on the inline attempt and on drains |

**R-B2 follows from this.** Choosing a worker row selects the stock provider on machine machine-b, so the model catalog, reasoning, permission modes, service tier and session options come from machine-b, and commands and skills too (`projectHostId = providerHostId`, `NewThreadComposer.tsx:1566`). Core builds the request itself, so the parity reference is "the same draft sent through the stock picker to provider `account-workers.worker` on machine-b with the same inputs", and the fork's test asserts byte equality with it.

**File mentions (N2, decided: route to the workspace host, relative paths).** Stock mention search follows `projectHostId` for a new thread (`NewThreadComposer.tsx:1566-1581`) and the thread's environment for an open thread (`ThreadDetailPromptArea.tsx:879-899` → `useComposerTypeahead({environmentId})`). For a worker that is machine-b (no project source) or the scratch directory, so `@` would offer no machine-a files. The fork routes mention suggestions only, not commands or skills, to the project source on `workspace.hostId`:

| | Stock source | Run on source |
|---|---|---|
| New thread, worker choice | `{projectId, hostId: machine-b}` | `{projectId, hostId: workspace host, environmentId: null}` |
| Open worker thread | `{environmentId: scratch on machine-b}` | `{projectId, hostId: workspace host, environmentId: null}` |
| Commands and skills | agent host / environment | unchanged (machine-b) |

The inserted path needs no mapping. A workspace suggestion inserts its path as listed, relative to the project source root (`pathMentionSuggestions.ts:17-23`; fixture paths like `packages/db/README.md`, `usePathSuggestions.test.ts:56`). No server code rewrites a path mention before the provider (searched `apps/server/src` and `packages/agent-runtime`: none found; inferred from the search). The worker's tools take "Path relative to the workspace root" and resolve it with `confine(root, input)` = `path.resolve(root, input)` inside the root (account-workers `tools.ts:142`, `confine.ts`). `validate` makes `root` equal to that same project source on the workspace host. A mention is therefore relative to the project root, and the root is the binding's root. The plugin's thread instructions must tell the agent to read mentioned paths with the workspace tools, not with the provider's native file tools, which would resolve them against the scratch directory (tasks 4.6). The fallback "mentions off with a reason" is not needed: the mapping is the identity.

## SDK (fork-only, experimental)

New types live in a fork file, `packages/plugin-sdk/src/fork/run-on-contract.ts`; hot files only import and forward them. They are not in npm `@get-bb/plugin-sdk`: a plugin detects them at runtime (`typeof app.slots.experimental_runOnProvider === "function"`), declares the shapes locally, and keeps stock behaviour (provider under machine-b in the machine section, plus its inputs control) when they are absent.

**Versioning.** Each registration carries `version: 1`. Core mounts only versions it knows and logs one capability warning for others. New optional fields do not bump the version; any change to the meaning of a field does.

```ts
// app.slots.experimental_runOnProvider(registration)
export interface ExperimentalRunOnProviderRegistration {
  version: 1;
  /** One of this plugin's own environment providers. Core ignores the registration otherwise. */
  environmentProviderId: string;
  /** Group heading and line, e.g. "On a worker", "agent there, files on machine-a". */
  title: string;
  description?: string;
  order?: number;
  /** Choices for a new thread in this project. A plugin hook, called inside the plugin's boundary. */
  useChoices(scope: { projectId: string }): ExperimentalRunOnChoices;
  /** The workspace of an open thread created by this provider. A plugin hook. */
  useThreadWorkspace(scope: {
    threadId: string;
    inputs: JsonValue | null;
  }): ExperimentalRunOnWorkspace | null;
  /** Optional actions under core's details in the open-thread popover. */
  ThreadActions?: ComponentType<{ threadId: string }>;
}

export interface ExperimentalRunOnChoices {
  status: "loading" | "ready" | "error";
  choices: readonly ExperimentalRunOnChoice[];
  error?: string;
}

export interface ExperimentalRunOnChoice {
  /** Stable within the registration; core remembers it per project. */
  id: string;
  /** The machine the provider runs on; core selects the provider there. */
  agentHostId: string;
  /** The provider inputs this choice submits; core seeds the stock inputs state with it. */
  inputs: JsonValue;
  workspace: ExperimentalRunOnWorkspace;
  /** A plugin-level reason; host offline and provider availability are core's to compute. */
  disabledReason?: string | null;
}

export interface ExperimentalRunOnWorkspace {
  /** The bb host that holds the files; core derives its name and online state. */
  hostId: string | null;
  /** Chip label when `hostId` is not a known host. */
  label?: string;
  /** Menu footer and popover, e.g. the path. */
  detail?: string;
  /** The workspace's current branch, shown by the branch chip (R-m1). */
  branch?: string | null;
  /** Set when the plugin knows the thread cannot run as bound, e.g. "Workspace unbound". */
  issue?: string | null;
}

// app.slots.experimental_composerRunRowItem(registration)
export interface ExperimentalComposerRunRowItemRegistration {
  version: 1;
  id: string;
  /** Among row items only, all after Run on; default 0, ties by plugin id then id. */
  order?: number;
  component: ComponentType<ExperimentalComposerRunRowItemProps>;
}

export interface ExperimentalComposerRunRowItemProps {
  scope:
    | { kind: "new-thread"; projectId: string | null; providerId: string | null }
    | { kind: "thread"; threadId: string; projectId: string };
  /** At compact widths the item should render icon-first. */
  compact: boolean;
  /** New thread only. The data core holds for this plugin, so a remounted item keeps its pick. */
  submission?: JsonValue | null;
  /**
   * New thread only. This plugin's data for the send's single `pluginSubmission`;
   * null clears it. Returns false when it is refused (another plugin holds it,
   * or the JSON is over 16 KB). Core drops it after a successful create (a
   * refused or failed create keeps it with the draft) and on a project
   * or provider change.
   */
  setSubmission?: (data: JsonValue | null) => boolean; // a property: plugins call it detached
}
```

`useChoices` and `useThreadWorkspace` are called by a small probe component mounted in the plugin's `PluginSlotMount` boundary, through a local binding (`const useChoices = registration.useChoices`), not as a method call: the fork hit React Compiler error 300 with the method-call form (README, Tasks fixed-tab continuity), and the compiled-path test covers it.

**Slot wiring (R-M5).** Same path as the fork's precedent `experimental_modal`:

1. `packages/plugin-sdk/src/app-contract.ts`: import from `fork/run-on-contract.ts`, two members on the slots interface.
2. `packages/plugin-sdk/src/app.ts`: the `app.slots` forwarders.
3. `packages/plugin-sdk/src/internal/plugin-app-registration-collector.ts`: two `slots.experimental_*` collectors.
4. `packages/plugin-sdk/src/testing/app.tsx`: test doubles.
5. `apps/app/src/lib/plugin-slots.ts` (on 0.50.1, through `usePluginSlotKind`) and `apps/app/src/lib/plugin-sdk-app-impl.tsx`.
6. `apps/app/src/test/fixtures/plugins.ts`: fixture entries.
7. `plugins/plugin-api-docs/src/surfaces.ts`: both surfaces, which the compile-time `_assertAllSlotsListed` (`apps/server/test/services/plugins/plugin-authoring-docs.test.ts:327`) requires.
8. `docs/api_to_audit.md`: one appended fork block.

## Trust rules (R-M7, security)

- **Owner check.** Core accepts a `runOnProvider` registration only when the provider list entry whose `environmentProviderId ?? id` equals the registration's `environmentProviderId` has `pluginId` equal to the registering plugin's id. `machineProviderPluginId` of a composed entry never counts. Otherwise core ignores the registration and logs one warning. One registration per provider; a second is ignored with a warning.
- **Current owner, not creator.** The open-thread check uses the provider's current owner, because the response has no `environmentProviderPluginId` (it exists only in the database). If the plugin is uninstalled and another plugin registers the same id, old threads get the new plugin's chip. Provider ids are first-wins (`plugin-api.ts:1351`, `:1375`), so this needs an uninstall first; accepted as low risk.
- **Open thread from data.** Core shows the worker chip only for a thread whose `environment.environmentProviderId` matches an accepted registration. The agent host is `environment.hostId`, which core knows; the plugin supplies only the workspace. A plugin cannot relabel another plugin's or a stock thread.
- **Plugin RPCs resolve targets server-side.** `choices.list({projectId})`, `thread.workspace({threadId})` and `rebind({threadId, workspaceHostId})` never accept a host path. The server computes pairs from its configured workers × the project's sources, and finds the binding by thread id. `rebind` refuses a thread whose provider is not `account-workers.worker`.
- **Provider inputs are caller-controlled too.** `validate` resolves the project's source on `workspaceHostId` through the workspace host's `resolveRoot` and refuses a `root` that differs, a host with no source, the agent host itself (`same_host`), and a host that is not connected. The stored `root` is therefore a checked echo, kept so the popover can show it without an RPC.
- **Submission.** Core sets `pluginSubmission.pluginId` from the row item's registration, so a row item cannot write another plugin's entry from the UI. An HTTP client can still forge one, as today, so the pool hook treats the data as untrusted: it checks `pluginId === bb.pluginId` (older runtimes give it unfiltered), validates with a schema, applies it only on a `pending` thread's start attempt (never on an existing thread's send, which would bypass U1's confirm dialogs), and respects host roles.

## The picker and the chip

**New thread.** The row is `project · Run on · [row items] · branch … permission`. The Run on chip is today's environment picker trigger.

| Selection | Chip |
|---|---|
| Local host (today) | `[laptop icon] machine-a`, unchanged |
| Worker choice | `[server icon] machine-b → machine-a` (agent host name, arrow, workspace host name or `label`) |
| Agent or workspace host offline | amber, `machine-b offline → machine-a` or `machine-b → machine-a offline` |

The menu keeps today's machine list as the **Local** group ("agent and files on one machine") and adds each accepted registration below it with its heading and description. A row is `dot · icon · agent → workspace · reason or "last seen" · check`. The machine sections stop listing a provider that has an accepted registration, so the worker does not appear twice. The footer shows the selected choice's `workspace.detail` (e.g. `Workspace machine-a · /srv/repo`). Projectless new threads get no groups.

Choosing a row sets the stock selection value `provider:<agentHostId>:<environmentProviderId>` and seeds the stock inputs state (`handleProviderInputsChange`, `NewThreadComposer.tsx:1210-1260`) with `choice.inputs`. The plugin's stock inputs control still renders beside it and may change the workspace; the chip then reads the choice whose `inputs` deep-equal the current value, or the agent host alone with "Choose a workspace" when none matches.

Core remembers the choice id per project in a fork preference (new file). A remembered choice that is gone, or whose plugin is not running, falls back to the default Local host, and the chip shows that host: it never claims a worker it is not going to use.

**Branch chip (R-m1).** For a worker choice the branch chip shows `workspace.branch`, as in the B mockups (`main`). The stock environment branch is the git branch of the agent host's path (`refreshAttachedEnvironmentBranch`, `thread-environment-placement.ts:886-903`), which for scratch is null, so core uses the plugin's value only for a worker thread and only through the trust rules above.

**Open thread.** `ThreadEnvironmentSummary` renders a static `MachineLabel` for the environment host and the provider's name and icon. For a thread whose provider has an accepted registration, the probe calls `useThreadWorkspace({threadId, inputs: environment.environmentProviderSelection?.inputs ?? null})`, and the label becomes the same `agent → workspace` chip as a button. Its popover, from the mockup (`png/B-thread-dark.png`):

- "This thread runs on"; Agent `machine-b` with a lock (the worker is fixed for the thread); Workspace `machine-a`; `workspace.detail`; `workspace.issue` if any;
- the plugin's `ThreadActions` (account-workers: "Change workspace…", i.e. rebind).

Without a registration, the row is exactly today's.

## Account chip

The account chip is a row item registered by the account-pool plugin, placed right after Run on (`order`), in both the new-thread and the open-thread row. The pool exports `AccountMenu({ account, choose, confirmPending, trigger, align?, header? })` and `useThreadAccount(threadId)` (`ui/thread-account/AccountPicker.tsx:179-191`, `hooks.ts:28` on `pool/u1u2-ui`), so reuse stays inside the pool plugin:

- **Open thread:** `AccountMenu` with `useThreadAccount(threadId)` and a chip trigger. A second door to the same U1 menu and store; the card row stays.
- **New thread:** a draft adapter with the `UseThreadAccount` shape, described in tasks §5. On change the chip calls `setSubmission({ policy })` with `{mode:"named", accountId, onLimit?}`, or `null` for Auto, the default.

**Single submission (R-M6).** Core keeps the existing single `CreateThreadRequest.pluginSubmission` (`server-contract/src/api/threads.ts:299`); there is no list. The owner rule, in the composer:

| Send | `pluginSubmission` |
|---|---|
| No row item data, no `submit({experimental_data})` | absent |
| One row item holds data | `{pluginId: row item's plugin, data}` |
| `useComposer().submit({experimental_data})` from plugin P, no row item data, or row item data from P | P's data (the submit wins for its own plugin) |
| Row item data from P and `submit` data from Q ≠ P | refused, draft kept, "Two plugins want to add data to this send. Clear the account choice or send without the plugin action." |

A second plugin's `setSubmission` while another holds the slot returns false. So the 0.50.1 wait-owner rule (`queuedOwner.pluginId ?? request.pluginSubmission?.pluginId`) and the shared one-per-pass hook context (`buildHookContext`) are unchanged.

**Size.** `setSubmission` refuses JSON over 16 KB (R-m4) in the app. The server field stays unbounded, as stock; a server cap would change a stock schema and is not needed for the UI path.

**When the hook sees it.** A create with `sendAt` runs the inline `attemptDispatch` with `pluginSubmission` (`thread-create.ts:495-513`), and the hook pass runs before the time, capacity and other waits (`dispatch-attempt.ts:546-551`, `:719-765`). So the pool applies the account on the inline pass for Send now and for Send later. Only later drains get `null`, and by then the policy is set. The account-workers provider does not answer `wait` for these threads, so it does not interfere.

**Reattempts (R-M2).** A reattempt reruns the whole hook pass with the same `pluginSubmission` (`dispatch-attempt.ts:880-913`). The pool hook is idempotent: if the stored policy already equals the desired one, it answers `proceed` without a write; it never sends a stale `expectedRevision` (the pool checks revision before same-policy, `thread-account.ts:443-451`). A refused `set` (`unavailable`, `at-limit`, `other-provider`) answers `reject` with the pool's message.

## Unavailable and offline

| State | New thread | Open thread |
|---|---|---|
| Agent host offline | Row disabled, "last seen …"; if selected, chip amber and Send blocked with "Worker machine-b is offline" through the existing blocker with reason `project_setup` (R-m3) | Chip amber `machine-b offline → machine-a`; popover: "Worker machine-b is offline. Last seen … The next turn waits until it reconnects." plus "Open machines"; send behaves as today for an offline host |
| Workspace host offline | Row disabled, "workspace machine-a offline"; Send blocked the same way | Chip amber `machine-b → machine-a offline`; the popover says the agent cannot read the workspace |
| Provider `availability` not available on that host | Row disabled with the provider's reason (stock `machineAvailability`) | — |
| Plugin `disabledReason` / `workspace.issue` | Row disabled with the reason | Chip amber; the popover shows the issue |
| `useChoices` `status: "error"` | Group shows one disabled row with the error | — |
| Plugin disabled, crashed or not running | Group absent; a remembered choice falls back to Local | No registration, so today's label with the provider name |
| `validate` or `create()` fails | Stock: create refused with the provider's message, or the thread shows the stock provisioning failure | — |

Core computes host online state from `useHosts()`, the same source as today's dots and "last seen".

## 390

- The Run on menu uses the shared `PopoverContent` with `mobileTitle="Run on"`, which becomes a bottom drawer at compact widths, as today's machine menu does (`png/B-mobile-dark.png`). Groups stack in the same order and the workspace footer stays at the bottom.
- The pool's `AccountMenu` passes `mobileTitle`, so it becomes a drawer too; its title must become a prop for the new-thread chip ("Account for this thread" is hard-coded, `AccountPicker.tsx:214`, `:235`).
- The row fits on one line. The Run on and account chips stay visible; the branch chip hides first (`data-promptbox-hide-branch-compact`), then the project chip collapses to its icon (owner decision 2026-11-27: icon only), so the project can still be switched on a phone. Names truncate before the arrow does.
- The open-thread popover becomes a drawer through the same `mobileTitle`.

## Release class

**UI-only by the machine check (R-m6):** README §6 classes are machine-checked (same migration digest, same daemon protocol version, same native dependency set), not "app code only". This change has no server code at all: app components and fork SDK types. Rollback to stock of the same version is valid: stock ignores the two slots, the worker provider stays a stock provider (shown under machine-b in the machine section with its inputs control), and stock understands `pluginSubmission`.

**Rollback edge (R-m5).** The first draft's new `pluginSubmissions` field would have been stripped by a stock server. With the single stock field that edge is gone; a new bundle against a stock server of the same version behaves the same.

**Plugin data, own rollback note.** `account-workers` stores bindings in its own SQLite (`bindings.ts`). Provider bindings fit the existing columns (`thread_id` is set in `create()`), so no plugin migration is expected; if a marker column turns out necessary (tasks 4.5), it is a forward-only plugin migration. Rolling the plugin back to a version without the provider leaves provider threads whose `remove()` cannot run until the provider returns; core keeps them as stock does for a missing provider (inferred; tasks 4.9 checks it in a lab). Rolling back the plugin needs that noted in the plugin's own ledger, not the fork's.

## Collisions

None of `core/composer-context-sheet` (already ported as f83901b733), `core/context-panel-single-section` or the `composer-context-*` builder branch touches the row under the composer or the pickers. `core-pending-send-intake` changes the existing-thread send lane and server dispatch files; this change has no server code. `core-backport-7872-send-at` (D1) touches the queue and dispatch hooks, not the composer. Upstream `desktop-v0.50.1` is the real overlap: it rewrites `NewThreadComposer.tsx` (518 lines), `ThreadDetailPromptArea.tsx` (454) and `app-contract.ts` (+123).

## Footprint and order

**New fork files (R-M4):**

| Area | Files |
|---|---|
| SDK | `packages/plugin-sdk/src/fork/run-on-contract.ts` |
| App | `apps/app/src/fork/run-on/{registrations.ts, RunOnGroups.tsx, RunOnChip.tsx, RunOnThreadPopover.tsx, ComposerRunRowItems.tsx, useRunOnSelection.ts, run-on-preference.ts, submission.ts}` plus tests and stories |

**Hot files, 1–10 lines each (about 70 lines total):** `app-contract.ts`, `app.ts`, `internal/plugin-app-registration-collector.ts`, `testing/app.tsx`, `lib/plugin-slots.ts`, `lib/plugin-sdk-app-impl.tsx`, `test/fixtures/plugins.ts`, `plugins/plugin-api-docs/src/surfaces.ts`, `pickers/EnvironmentPicker.tsx` (render groups, skip registered providers in machine sections), `promptbox/NewThreadComposer.tsx` (`useRunOnSelection`, submission, branch, blocker, mention source; may exceed 10 lines), `promptbox/NewThreadPromptBox.tsx`, `promptbox/ThreadEnvironmentSummary.tsx`, `views/thread-detail/ThreadDetailPromptArea.tsx` (row items, mention source), `docs/api_to_audit.md` (one block). The line count is an estimate; R1 recounts it on the synced base (tasks 1.8). The authoring-docs test changes only if `surfaces.ts` does not satisfy it alone. That is 15 hot files and about 10 new ones (R-m9; the first draft's "about 20 files" undercounted the wiring).

**Tests:** parity with the stock provider selection (byte-equal request for one draft: text, image, file, mention, model, reasoning, permission, tier, session options, `sendAt`); owner check and second-registration refusal; open-thread chip only for a matching provider; remembered choice fallback; inputs edited in the stock control; availability matrix; submission owner rule, 16 KB refusal, clearing on project and provider change and only after a successful create; mention suggestions from the workspace host with a relative inserted path; compiled-path test for the probes; picker and chip stories in dark and light at 1440 and 390. No server code changes; one new server contract test pins the Send later inline pass (tasks 1.6), and the pool tests its own hook (tasks 5.6).

**Order (R-M3):**

1. `core-context-card-fit` (independent; on `core/context-card-fit`).
2. The `desktop-v0.50.1` sync lands on `fork/main`. It needs the owner's data-upgrade decision (six upstream migrations, daemon protocol change).
3. Lab probes (tasks §0).
4. Core R1: SDK slots and wiring, tests.
5. Core R2: groups, chip, open-thread popover, row items, unavailable states, 390.
6. Plugin work in parallel with R2, against the R1 branch: account-workers (tasks §4) and the pool (tasks §5).
7. Live acceptance (tasks §6). Send later combined with another waiting hook needs D1 first.

## Patch ledger entry (draft)

The maintainer adds the row when R1/R2 land; this is the draft text.

| Patch | Change | Paths in `werserk/bb` | Migrations / protocol | Upstream status | Retire when | State |
|---|---|---|---|---|---|---|
| Run on picker | `core-run-on-picker` | new: `packages/plugin-sdk/src/fork/run-on-contract.ts`, `apps/app/src/fork/run-on/*`; hooks in `packages/plugin-sdk/src/{app-contract.ts,app.ts,testing/app.tsx,internal/plugin-app-registration-collector.ts}`, `apps/app/src/lib/{plugin-slots.ts,plugin-sdk-app-impl.tsx}`, `apps/app/src/test/fixtures/plugins.ts`, `plugins/plugin-api-docs/src/surfaces.ts`, `apps/app/src/components/pickers/EnvironmentPicker.tsx`, `apps/app/src/components/promptbox/{NewThreadComposer.tsx,NewThreadPromptBox.tsx,ThreadEnvironmentSummary.tsx}`, `apps/app/src/views/thread-detail/ThreadDetailPromptArea.tsx`, `docs/api_to_audit.md` | none (app and fork SDK types only; no server change; daemon protocol and native deps unchanged) | not proposed (downstream only; new `experimental_` SDK members over stock environment providers) | upstream ships provider presentation (grouping, `agent → workspace`) and composer row items. Plugin data (account-workers bindings) has its own rollback note in the plugin | on `core/run-on-sdk` / `core/run-on-ui` after the `desktop-v0.50.1` sync; not on `fork/main` |
