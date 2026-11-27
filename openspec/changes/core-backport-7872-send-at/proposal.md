# Backport get-bb/bb #7872: keep a scheduled send's time under a dispatch wait

## Why

A queued message had one `send_at` column with two meanings: the sender's earliest time and a `message.dispatch` plugin's re-ask time. When a hook answered `wait`, core wrote the plugin's time (or nothing) over the sender's. A later drain rebuilt the payload without any time. So a message scheduled for later could be sent as soon as the plugin let it through.

Observed on the fork: a new thread spawned with `--send-at +1d` by a plugin whose hook holds the first message until a workspace binding is ready. The hook answered `wait`, the row lost its day, and the plugin's `recheck()` sent it within a second. Every route that dispatches through `attemptDispatch` is exposed whenever a hook votes `wait`: thread spawn, thread send, the UI scheduled send, a cleared or orphaned plugin wait, and host-offline requeue.

Upstream fixed the class in get-bb/bb 89f1e507d6 (#7872, migration `0162`, plugin SDK 0.6.174). The fork is based on `desktop-v0.49.0`, which does not have it.

## What changes

- The upstream source change, unchanged: a `recheck_at` column and partial index on `queued_thread_messages`; `send_at` keeps only the sender's time; a hook's `wait` carries `recheckAt`, and the legacy `sendAt` field still maps to it (setting both fails the attempt); a drain hands the sender's time back to the attempt; a cleared plugin wait and a host-offline requeue keep it.
- The migration is fork migration `drizzle/fork/0007_queued_message_recheck_at`, byte-identical to upstream `0162`, with a reconciliation step so the later upstream sync neither fails nor applies the change twice (design.md).
- A spawn-path regression: a new thread's scheduled first message held by a plugin wait at creation.
- `PLUGIN_SDK_VERSION` stays 0.6.132.

## Out of scope

- A strict (`.strict()`) hook decision schema. It is a behaviour change for any installed plugin that returns extra keys. Follow-up (design.md).
- The plugin side: a plugin that relies on this needs an honest engine floor or a capability check. That is a plugin change.
- Release. This change is a branch only; it is not merged into `fork/main` and no candidate is built.

## Release class

`data-protocol`: a database migration with a data move, and an additive plugin contract field. See design.md for rollback.
