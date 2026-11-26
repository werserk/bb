---
name: Account Workers block
about: One block of Account Workers work (one issue, one branch, one PR)
title: "Block N: "
labels: account-workers, block
---

## Goal

<!-- The end state in one or two sentences. Link the section in docs/account-workers/. -->

## Acceptance

<!-- Checkable items. Each is proved in the PR by a command and its real output. -->

- [ ]

## Budget

<!-- Time, model/effort and spend limit set by the coordinator; what to do when it runs out. -->

## Dependencies

<!-- Issues that must be merged first; issues this one blocks. -->

## Hard rules

- Provider keys and logins stay on the worker host; never on a workspace host.
- No core change unless a probe proves the plugin SDK cannot do it; then open a `needs-owner` issue instead.
- Public repository: check every push, issue and PR for secrets and private details (tokens, keys, emails, IPs, host names, BB host ids, account names, local home paths).
- Branch `aw/<n>-<slug>` from `account-workers/main`; PR into `account-workers/main`; independent review; squash merge.
- Never write to the upstream repository; pass `-R werserk/bb` to `gh`.
