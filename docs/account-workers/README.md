# Account Workers

Account Workers lets an agent run on one machine while it works on files on another.

- A **worker host** holds the provider accounts (Claude, OpenCode, Codex): login, API keys and agent init live only there. Threads run on it in an empty scratch directory.
- A **workspace host** holds the code. It never holds provider keys; it only executes tool calls (read, write, edit, glob, grep, exec, stop) through the BB daemon already running on it.
- The **BB server** connects both: it runs the plugin's server entry and routes each tool call to the workspace host bound to the thread.

```
 agent (worker host, scratch dir)
   │  tool call: edit / exec / ...
   ▼
 BB server ── plugin server entry ── binding: thread → (workspace host, path)
   │  hosts.call(method, input, { hostId, signal, timeoutMs })
   ▼
 workspace host ── plugin host entry ── files and processes
```

It is built as a BB plugin, `plugins/account-workers`, with no core changes (see [decisions](decisions.md)).

| Document | What it holds |
|---|---|
| [architecture.md](architecture.md) | Target design, per-provider profile, built vs planned, open points |
| [decisions.md](decisions.md) | Dated owner decisions with reasons |
| [roadmap.md](roadmap.md) | Blocks and their issues |

## How to work here

Repository: `werserk/bb` (public fork of BB). Integration branch: `account-workers/main`, based on upstream `main`.

One block of work = one issue + one branch + one PR:

1. **Issue.** Each block has an issue labelled `account-workers` and `block` with goal, acceptance, budget and dependencies ([template](../../.github/ISSUE_TEMPLATE/account-workers-block.md)). Read it and the docs here first.
2. **Branch.** `aw/<issue number>-<slug>` from `account-workers/main`, e.g. `aw/1-plugin-probe-claude`.
3. **PR** into `account-workers/main` using the [PR template](../../.github/PULL_REQUEST_TEMPLATE/account-workers.md) (`gh pr create -R werserk/bb -B account-workers/main --template account-workers.md`). The body says `Closes #n`, lists the evidence (commands with real output) and names the reviewer.
4. **Review.** An independent reviewer (not the author) checks the PR against the issue's acceptance.
5. **Merge.** Squash merge into `account-workers/main`.

Rules that hold for every block:

- Provider keys and logins stay on the worker host. Never on a workspace host, including customer machines.
- No core change unless a probe proves the plugin SDK cannot do it; then open a `needs-owner` issue with the evidence instead of editing core.
- This repository is public. Before any push, issue or PR, check the content for secrets and private details: tokens, keys, emails, IPs, host names, BB host or machine ids, account names, local home paths. Use neutral names: "worker host", "workspace host".
- Pass `-R werserk/bb` to every `gh` call; never write to the upstream repository.
- Update these docs in the same PR when the design or a decision changes.
