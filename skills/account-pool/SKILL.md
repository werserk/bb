---
name: account-pool
description: "Configure or diagnose Account Pooler accounts, authentication, quota routing, and failover through bb pool."
---

# Account Pooler

Use `bb pool` for this plugin's accounts and routes. Inspect current state with
`bb pool status --json` and `bb pool account list --json` before changing routing.
Use `bb pool --help` for available commands.
Only a machine with a role gets central Claude and Codex pooling. Inspect
`bb pool machine list --json`; see the machine roles section in the routing
reference before `machine role <host-id> <server|worker|trusted|none>`.
A role is policy, not native-account readiness. Threads get per-thread passes
(threads older than per-thread policy keep the machine token until a policy is
set): inspect or revoke them with `bb pool pass list|revoke`, and read routing
and access decisions with `bb pool audit`; the routing reference has both and
how to enrol a worker.
To pin a thread to one account or see which account serves it, use
`bb pool thread show|set|accounts|events <thread-id>` (agents pass
`"$BB_THREAD_ID"`); `docs/THREAD_ACCOUNT_V1.md` in the plugin has the rules.

For account login, secret handling, quota refresh, routing settings,
ordering, or failover, read
[references/accounts-and-routing.md](references/accounts-and-routing.md).

Use stdin or the supported login flows for credentials; never put secret values
in command arguments or chat. Confirm the resulting account and routing state.
Do not enable the plugin or change accounts unless the requested task calls for it.

Pooled rate-limit failures can be retried by Provider Retry using the pool’s
earliest usable account, even if the provider omits structured quota events.
Inspect `bb provider-retry explain <thread-id> --json` for the last decision
and `bb provider-retry status <thread-id> --json` for pending retries.

For a tiny request through one specified local Claude account, use `bb pool ping <account-uuid> [--diagnostic] [--json]`; see the targeted ping section in the routing reference. It consumes quota and never fails over.
