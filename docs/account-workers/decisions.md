# Account Workers decisions

Owner decisions, newest first. Each entry says what was decided and why.

## 2026-11-27 — Environment provider for the new-thread picker

- **Decision.** account-workers registers the environment provider `account-workers-worker` with a workspace inputs control, so a worker thread starts from BB's picker. It uses the v1 provider contract with `ownsPath: false`; its bindings carry `owner = provider` and are released through the provider's `remove`, not the plugin's archive and delete handlers. The dispatch hook records the start model for `create`.
- **Why.** Provider ids allow only `[a-z0-9-]`, so `account-workers.worker` from the proposal is invalid. The running cores (0.49, 0.50.1) call v1 providers with the thread, and the thread has no model, so the hook is the only place that sees it. `ownsPath: true` would make core run the project's setup scripts in a directory that is not a checkout. Core owns the environment's lifetime, so a second release path from plugin events would race it.

## 2026-11-27 — Block 4: binding lifecycle; accounts through the pool

- **Decision.** Block 4 ships the binding lifecycle: a `message.dispatch` hold that keeps a thread's turns back until its binding is ready and refuses released bindings and unguarded providers, and a two-step release (tombstone, then worker cleanup) on `unbind`, archive and delete. Account choice moves to the pool as the central key keeper: one sign-in per account in BB, a per-thread pass, a per-thread account policy and switching mid-thread. Per-worker account homes and the pool bypass are dropped; #4 is re-scoped to that design.
- **Why.** The owner wants one sign-in per account in one place, since many sign-ins carry a ban risk, and wants to switch the account mid-thread. Per-worker homes need a sign-in per worker and lose session history on a switch. The lifecycle is needed either way, and it closes G6 and G8 for dispatched turns ([architecture](architecture.md#release)).

## 2026-11-26 — Codex hook trust in the worker's user config (block 3, D2)

- **Decision.** The Codex profile writes one trust entry per binding into the worker's `~/.codex/config.toml`: the scratch project's trust and its guard hook's trusted hash. Two conditions from the plan review apply:
  - A live check on every call: before each workspace call, the server calls `verify`, which consumes the guard hook's heartbeat for that call.
  - One atomic, verified edit: a fresh read, the addition, a parse, then `rename`. No lock and no `config/value/write`.
- **Why.** Codex reads hook trust only from the user and session-flag layers. A project cannot trust its own hook, and Codex skips an untrusted hook silently. The session-flag route needs a `provider-codex` change, so it stays a later seam ([architecture](architecture.md#open-points), G9). The heartbeat check makes a skipped hook visible on the real thread, not only in the canary.

## 2026-11-26 — No Codex login on the acceptance workspace host (block 3, D1)

- **Decision.** Codex was logged out on the workspace host used for block 3 acceptance. The owner signs in again himself if he wants Codex there.
- **Why.** Every connected machine held a Codex login, and keys stay only on worker hosts. The logout was checked by name only ([probe-3](probe-3.md#workspace-host)).

## 2026-11-26 — Block 2: provider profile seam and the OpenCode profile

- **Decision.** Each provider's worker-side lock-down is a profile in `plugins/account-workers/profiles/` with `prepare`, an optional `check` (refuses the spawn) and an optional `verify` (refuses one tool call and marks the binding broken). The binding stores its profile. `spawn` picks the profile from `--provider`; omitted means `claude-code`, now passed to BB explicitly; a provider with no profile is refused. `configure` gives the tools only to the provider the profile guards. For OpenCode the scratch directory gets an `.opencode/` config that removes the built-in tool plugins and denies every tool except the workspace tools and `bb_update_plan`, plus a guard plugin that rejects anything else; the spawn is refused on OpenCode other than major 2, on config-overriding env vars and on managed config. No core or provider-plugin change.
- **Why.** Blocks 2 and 3 needed one place to add a provider without touching routing, storage or the host contract; Codex also needs a gate and a per-call check, so the seam carries both. OpenCode reads project config from the session directory with no trust prompt, so scratch files are enough. A permission deny alone is not: upstream BB patches the session to allow `edit`, `shell`, `webfetch` and `external_directory`, and those rules come last. Removing the tool plugins does not depend on rule order, the deny covers tools from other sources, and the guard covers an OpenCode change that makes removal a no-op ([architecture](architecture.md#opencode)).

## 2026-11-26 — Block 1 design as built (plan approved after independent review)

- **Decision.** Instructions and the per-thread tool set come from `bb.agents.configure`, not `contributeInstructions`. There is no `stop` tool and no background jobs: Stop is the tool call's abort signal, and `exec` is bounded by its timeout (default 120 s, max 600 s). Native Claude tools are off through settings in the thread's scratch directory, a deny list plus a `PreToolUse` allowlist hook, with no change to `provider-claude-code`. The scratch directory lives outside BB's data directory.
- **Why.** `configure` is the SDK's per-thread seam and can drop the tools when a thread leaves its scratch directory. The abort signal already reaches the host entry. The plan review showed BB refuses thread paths inside its managed storage, and that a plain deny list misses tools added by other plugins and MCP servers; an allowlist does not. G1 (the BB API trusts whoever can reach it) is accepted on the owner's machines and documented as a precondition for foreign workspaces ([architecture](architecture.md#open-points)).

## 2026-11-26 — Build as a BB plugin on upstream main

- **Decision.** Account Workers is a BB plugin (`plugins/account-workers`) with no core changes. Core is touched only if a probe proves a gap the plugin SDK cannot cover, and then only after an owner decision.
- **Why.** Upstream's plugin SDK already has the seams: `bb.agents.registerTool` (per-call context with the thread id and a Stop signal), a host entry on each daemon reachable by `hostId`, and `bb.agents.contributeInstructions`. A plugin rebases with upstream; a core fork does not.
- **Base.** `account-workers/main` starts from upstream `main`, not from the earlier fork branches.

## 2026-11-26 — Earlier core work is frozen

- **Decision.** The earlier core implementation (PlacementService, ordinary queue changes, placement storage and migrations, cross-host managed runtime, protocol revisions .270/.271) is frozen. It is kept only in `archive/aw/*` tags on this repository; the integrated pin is `archive/aw/pin-a2-canon-75d6385094`.
- **Why.** It changed core across about 160 commits on top of the fork branch, was never pushed or merged, and went deep before a thin end-to-end path existed. The plugin route reaches the same goal without carrying that diff. Read the tags for ideas; do not merge them.

## 2026-11-26 — Repository and flow

- **Decision.** Work happens in public `werserk/bb` with issues enabled: one issue per block, branch `aw/<n>-<slug>`, PR into `account-workers/main`, independent review, squash merge.
- **Why.** Several threads must work in parallel without stepping on each other; issues and PRs give each block a visible owner, acceptance and review.

## 2026-11-26 — Keys only on the worker host

- **Decision.** Provider keys, logins and agent init exist only on worker hosts, never on a workspace host, customer machines included.
- **Why.** A workspace host may belong to someone else; it should receive tool calls, not credentials.

## 2026-11-26 — Workspace tools are ordinary BB agent tools

- **Decision.** Workspace tools (read, write, edit, glob, grep, exec, stop) are BB agent tools routed by the server to the workspace host's BB daemon. Each provider receives them the way it already receives BB tools, with its native file and shell tools off. The engine's working directory is an empty scratch directory on the worker host. VM, VPN and proxy setup are later tuning.
- **Why.** One tool surface for all providers; nothing provider-specific runs on the workspace host.

## 2026-11-26 — Order and course

- **Decision.** Providers in order Claude → OpenCode → Codex. A thin end-to-end path first, depth later.
- **Why.** Claude already receives BB tools through the `bb-bridge` MCP server, so it proves the path with the least new work.
