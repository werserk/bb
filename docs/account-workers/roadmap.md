# Account Workers roadmap

Each block is one issue, one branch and one PR (see [README](README.md#how-to-work-here)). Milestones on GitHub match the blocks.

| # | Block | Issue | Depends on |
|---|---|---|---|
| 1 | Plugin probe + Claude end to end | [#1](https://github.com/werserk/bb/issues/1) | — |
| 2 | OpenCode profile | [#2](https://github.com/werserk/bb/issues/2) | #1 |
| 3 | Codex profile with no-fallback probe | [#3](https://github.com/werserk/bb/issues/3) | #1 |
| 4 | Account selection: several isolated accounts per worker host | [#4](https://github.com/werserk/bb/issues/4) | #1 (best after #2, #3) |
| — | Later | [#5](https://github.com/werserk/bb/issues/5) | #1–#4 |

## 1. Plugin probe + Claude end to end

Build the plugin: workspace tools, server routing to the host entry, per-thread binding, workspace instructions ([architecture](architecture.md)). Done when a Claude thread on the worker host edits and runs code on a workspace host, with native Claude tools off and Stop ending the remote process group.

## 2. OpenCode profile

OpenCode over ACP with native tools denied by permission, using the same plugin tools.

## 3. Codex profile

Codex with file and shell work only on the workspace host: plugin tools with native tools off, or Codex's native exec-server/environments via app-server. A probe must show there is no silent local fallback (Codex issue `openai/codex#41563`).

## 4. Account selection

Several isolated accounts of a provider on one worker host; each thread gets one by a documented rule. Reuse the existing `account-pool` plugin where it fits.

## Later

- Hardening: failure modes, reconnects, limits, audit.
- Workspace hosts the owner does not control: close [G1](architecture.md#open-points) first (the BB API trusts whoever can reach it).
- Cloud mode without the owner's PC: the BB server runs elsewhere.
- Workspace switch UX mid-conversation (the mechanism is rebinding, block 1).
- Central key store.
- VM / VPN / proxy tuning for worker hosts.
