---
name: account-pool
description: "Configure or diagnose Account Pooler accounts, authentication, quota routing, and failover through bb pool."
---

# Account Pooler

Use `bb pool` for this plugin's accounts and routes. Inspect current state with
`bb pool status --json` and `bb pool account list --json` before changing routing.
Use `bb pool --help` for available commands.
For explicit machine-wide exclusions from central Claude and Codex pooling,
inspect `bb pool machine list --json`; see the machine routing section in the
routing reference before `machine exclude <host-id>` or `machine include <host-id>`.
An exclusion is policy, not native-account readiness.

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
