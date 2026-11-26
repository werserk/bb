# Account Workers decisions

Owner decisions, newest first. Each entry says what was decided and why.

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
