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

OpenCode over ACP with native tools off, using the same plugin tools. **Built**: the provider profile seam and the OpenCode profile ([architecture](architecture.md#provider-profiles), [probe-2](probe-2.md)).

## 3. Codex profile

Codex with file and shell work only on the workspace host: plugin tools with native tools off, or Codex's native exec-server/environments via app-server. A probe must show there is no silent local fallback (Codex issue `openai/codex#41563`). **Built**: route A, plugin tools as `dynamicTools` with native tools off and a trusted `PreToolUse` allowlist hook; Codex exec-server rejected ([architecture](architecture.md#codex), [probe-3](probe-3.md)).

## 4. Account selection

Several isolated accounts of a provider on one worker host; each thread gets one by a documented rule. Reuse the existing `account-pool` plugin where it fits. **Built so far**: the binding lifecycle it needs, a dispatch hold and release on `unbind`, archive and delete ([architecture](architecture.md#release)). Account choice moved to the pool as the central key keeper (per-thread passes, the thread policy and switching, its `thread-account.v1` contract). **Built (block A2)**: `spawn --account` and the account in `list` through that contract ([architecture](architecture.md#accounts)).

## Later

- Hardening: failure modes, reconnects, limits, audit.
- Workspace hosts the owner does not control: close [G1 and G7](architecture.md#open-points) first (the BB API trusts whoever can reach it; worker context can be read back through the workspace).
- Cloud mode without the owner's PC: the BB server runs elsewhere.
- Workspace switch UX mid-conversation (the mechanism is rebinding, block 1).
- Central key store.
- VM / VPN / proxy tuning for worker hosts.
