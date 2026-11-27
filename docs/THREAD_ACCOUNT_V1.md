# thread-account.v1

The Account Pooler's public contract for a thread's account: which account a
thread may use, which one serves it, and what happened when that account hit
its limit. Registered as a discoverable plugin RPC contract by
`account-pool-prewarm` (`src/thread-account.ts`). The CLI `bb pool thread …`
and other plugins use the same service.

## Compatibility rule

`v1` never changes meaning. Within `v1`, output objects may gain optional
fields and enums may gain values; a caller ignores fields it does not know and
treats an unknown enum value as "not one of mine". A removed field, a renamed
value or a changed meaning is `thread-account.v2`, registered next to `v1`.

## Policy

| Policy | Meaning |
|---|---|
| `auto` (default, no stored row) | the pool picks the account, as for every thread before P3 |
| `named <account>` + `onLimit` | only that account serves the thread's model requests of its provider |

`onLimit` is `fallback-auto` (default) or `stop`. There is no `ask`.

- A named account is "at its limit" only at the real limit (utilization 1.0
  or an upstream quota rejection), not at the pool's switch threshold.
- `fallback-auto`: at the real limit, or when the account was deleted, the
  stored policy becomes `auto` (an audit `named-limit` row, then
  `policy auto@limit`). When the account is disabled, signed out, access
  blocked or usage restricted, that request is served by auto and the policy
  stays named (one deduplicated `named-limit … unavailable-fallback-auto` row).
- `stop`: the request gets 429 with `retry-after` at the account's reset; the
  policy stays. Retry availability for that thread waits for that account only.
- A transient upstream failure of the named account (5xx, a short 429 hold)
  is returned as is; it neither falls back nor changes the policy.
- Non-model routes (`/models`, `count_tokens`) never stop a thread.

The next model request uses a new policy; nothing restarts. A Claude session
continues on another account. A Codex session may need a new session; set it
with `newSession: true` while the thread is idle.

Threads that existed when this build first started on a `server` or `trusted`
machine keep the machine token (`grandfathered: true`), so no policy applies to
them until a `set` stores one; that `set` answers `sessionRebuild: "next-turn"`
because the thread moves to its own pass at its next turn (the context is kept;
background shells, monitors and subagents end).

## Methods

All methods take an exact `threadId`.

### `thread-account.v1.get`

Input `{ threadId }`. Output:

```json
{
  "threadId": "thr_example1",
  "provider": "claude",
  "policy": { "mode": "named", "accountId": "acct-b", "accountLabel": "Work B", "onLimit": "fallback-auto" },
  "revision": 1,
  "updatedAt": 1900000000000,
  "grandfathered": false,
  "serving": { "accountId": "acct-b", "accountLabel": "Work B", "provider": "claude", "since": 1900000001000 },
  "lastLimit": null,
  "switchContinuity": "continues",
  "note": null
}
```

`provider` is null for a thread the pool does not route. `serving` is the last
account that served a model request of the thread (null before the first one).
`lastLimit` is the latest `named-limit` event: `cause` `limit` | `deleted` |
`unavailable`, `action` `fell-back` | `served-auto` | `stopped`.
`switchContinuity` is `continues` (Claude), `may-restart` (Codex, unknown) or
`new-session` (right after a `set` with `newSession`).

### `thread-account.v1.set`

Input:

```json
{
  "threadId": "thr_example1",
  "policy": { "mode": "named", "accountId": "acct-b", "onLimit": "stop" },
  "expectedRevision": 1,
  "newSession": false
}
```

`policy` is `{ "mode": "auto" }` or `{ "mode": "named", accountId, onLimit? }`.
`expectedRevision` turns the write into a compare-and-set. On success the
output is the `get` state plus `ok: true`, `changed`, `sessionRebuild`
(`none` | `next-turn` | `new-session`) and `message`. Setting `auto` on a
thread without a stored policy changes nothing.

Refusals are `{ ok: false, reason, message, resetAt? }`, checked in this order:

| reason | when |
|---|---|
| `unknown-thread` | bb has no such thread, or it was deleted |
| `not-writable` | the thread is archived |
| `not-pooled` | named, and the thread's provider is not routed by the pool |
| `unknown-account` | no pool account has that id |
| `other-provider` | the account belongs to the other provider |
| `unavailable` | the account is disabled, signed out, blocked or restricted now |
| `at-limit` | the account is at its real limit now (`resetAt` when known) |
| `revision-conflict` | `expectedRevision` is stale, or another writer won |
| `new-session-not-codex` | `newSession` on a thread that is not Codex |
| `new-session-not-needed` | `newSession`, but the thread already runs on that account or the policy is auto |
| `not-idle` | `newSession` while the thread is busy, or bb refused the new session (the policy is put back) |

With `newSession`, the policy is stored first and then bb starts a new Codex
session; if bb refuses, the previous policy is written back
(`policy …@revert`) and the answer is `not-idle`.

### `thread-account.v1.accounts`

Input `{ threadId }`. Output `{ threadId, provider, accounts[] }` in pool
priority order; each account has `accountId`, `accountLabel`, `provider`,
`kind`, `subscriptionType`, `usable`, `reason` (`not-pooled`,
`other-provider`, `unavailable`, `at-limit` or null) and `resetAt`.

### `thread-account.v1.events`

Input `{ threadId, afterId?, limit? (1–200, default 50) }`. Output
`{ events[] }`, oldest first after `afterId`: `id`, `at`, `kind` (`select`,
`failover`, `switch`, `policy`, `named-limit`), `accountId`, `accountLabel`
and `detail`. Page with the last `id`.

## Audit rows

| reason | detail |
|---|---|
| `policy` | `<auto\|named-fallback-auto\|named-stop>@<client\|cli\|limit\|revert\|plugin-<id>>[+new-session]` |
| `named-limit` | `<limit\|deleted\|unavailable>-<fallback-auto\|stop>` |
| `switch` | none: the first request served by a newly named account |

The caller is a kind only: UI, agents and bb itself are `client`; another
plugin is `plugin-<id>` (lowercased, other characters as `-`, at most 48).

## CLI

```bash
bb pool thread show "$BB_THREAD_ID"
bb pool thread set "$BB_THREAD_ID" "Work B" --on-limit stop
bb pool thread set "$BB_THREAD_ID" auto
bb pool thread accounts "$BB_THREAD_ID"
bb pool thread events "$BB_THREAD_ID" --after 120 --limit 20
bb pool thread list
```

`set` takes an account id or a unique label; `--json`, `--expected-revision`
and `--new-session` match the RPC. `bb pool status` adds a Threads block
(named policies, threads served per account in the last 24 h, requests still
sessions selected on a machine token).

## Realtime

`thread-account-changed` with `{ threadId }` after a `set`, a fallback, a stop,
a switch or a deleted thread's policy.
