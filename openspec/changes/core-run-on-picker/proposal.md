# "Run on" picker over a worker environment provider, and an account chip

## Why

`account-workers` runs an agent on a worker host (machine-b) against a workspace that stays on machine-a. Today it is reachable only through its CLI (`spawn`), and the composer row under the box (project · machine · branch) shows only the agent's host, so a worker thread reads as "machine-b" with no sign that its files are on machine-a. The owner chose variant B (owner decision 2026-11-27; from the designer's variant B mockups):

- the machine chip becomes one **Run on** picker with a **Local** group (today's machines) and an **On a worker** group; a worker choice reads `machine-b → machine-a`;
- the **account** is its own chip next to it, with the same menu as the account row (U1) of the thread context card;
- `account-workers` owns the worker logic. Core does not take it over.

Stock core already has the mechanism for "a plugin decides where a thread's files are": environment providers (`bb.experimental_environments.register`, stock since `desktop-v0.48.1`). Core persists the provider choice with the thread, calls the provider's `create()` durably with the real thread id after admission, re-runs it when an errored environment is advanced for a starting thread (a requested retry, not a backoff), and calls `remove()` at retirement, with a bounded backoff. The New Thread picker already lists providers per machine, routes the model catalog and options to the provider's machine, and renders a plugin's inputs control. So the worker becomes a provider, and the fork adds only presentation.

## What Changes

- **Plugin, stock API (no core change):** `account-workers` registers the environment provider `account-workers.worker` with inputs `{ workspaceHostId, root }`. `validate` resolves the workspace server-side; `create()` prepares the scratch directory on the agent host and creates the binding with the real thread id; `remove()` releases both. The plugin also registers the stock `experimental_environmentProviderInputs` control (workspace selector). On stock bb this already works: the worker shows under machine-b in the machine section.
- **SDK, fork-only, experimental, presentation only:**
  - `app.slots.experimental_runOnProvider`: for one of the plugin's own environment providers, a picker group (heading, description, `agent → workspace` choices that seed the provider inputs) and the workspace view of an open thread (label, detail, branch, actions).
  - `app.slots.experimental_composerRunRowItem`: a chip in the row under the composer (for the account), with a single plugin submission for a new thread.
  - Both carry `version: 1` (precedent: `experimental_artifact.version: 1`, `app-contract.ts:5390`).
- **Picker:** the new-thread environment picker renders the worker group under its machine list; choosing a row selects the stock provider on the agent host and seeds its inputs. The chip shows `agent → workspace`; offline and unavailable choices render disabled with a reason.
- **Open thread:** for a thread whose environment came from a provider that a registration describes, and only when the registration's plugin owns that provider, the row's machine label becomes the `agent → workspace` chip with a details popover, and the branch chip shows the workspace's branch.
- **Account chip:** a row item the pool plugin renders with its existing U1 menu. For a new thread it hands its choice to core as the existing single `pluginSubmission`, which the pool's own `message.dispatch` hook receives on the inline first attempt, including Send later.
- **File mentions:** for a worker choice and a worker thread, `@file` suggestions come from the project on the workspace host; the inserted path is relative to the project root, which is the binding's `root`, so the worker's tools resolve it without mapping.
- **Server:** no change.

## Capabilities

### New Capabilities

- `core-run-on-picker`: Run on groups over environment providers, the `agent → workspace` chip, the open-thread workspace view, and row items with a single submission.

## Impact

- **Core:** new fork files under `fork/` directories and 13 hot files, 170 added and 15 removed hot lines as built (planned: about 70; list in [design.md § Footprint](design.md#footprint-and-order)). No migration, no daemon protocol change, no dependency, no server change.
- **Release class:** UI-only by the fork's machine check (README §6 in bb-plugin-lab `docs/bb-fork/README.md`: same migration digest, daemon protocol and native dependency set). The change touches the app and fork SDK types only. Plugin-side data (account-workers bindings) is outside this class and has its own rollback note ([design.md § Release class](design.md#release-class)).
- **Plugins:** `account-workers` gains an environment provider, its first app UI and RPCs; the account-pool plugin gains a row chip, a draft account adapter and an idempotent dispatch hook. Separate task lists in [tasks.md](tasks.md).
- **Dependencies (not part of this change):**
  - D1, `core-backport-7872-send-at` (branch `core/backport-7872-send-at`): a plugin `wait` erases a scheduled send's time, because one `send_at` column holds both (diagnosis: the hold itself worked). The backport adds a fork migration, so it is data class and needs the owner. The worker path here no longer waits in a hook, so it does not depend on D1; Send later combined with any other hook that waits (e.g. a concurrency cap) does.
  - The `desktop-v0.50.1` sync. It carries six upstream migrations (0153–0158) and a daemon protocol change, so it needs the owner's data-upgrade decision. Build this change after that sync lands on `fork/main`.
