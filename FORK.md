# werserk/bb fork

This is a maintained downstream fork of [get-bb/bb](https://github.com/get-bb/bb). `fork/main` starts at the upstream release tag `desktop-v0.48.1` and adds only downstream patches; it integrates upstream `desktop-v*` release tags, never upstream `main`. Architecture, branch model, release policy and the patch ledger live in the maintainer's repository: `docs/bb-fork/` in [werserk/bb-plugin-lab](https://github.com/werserk/bb-plugin-lab) (private).

The provider-independent visible plan tool lives in `apps/server/src/services/threads/thread-plan-tool.ts`: runtime configuration contributes `bb_update_plan` to every provider, and the authenticated tool-call route writes normalized `planSteps` into the existing timeline. Provider bridges and the todo card consume the existing contracts; this patch adds no storage or wire schema.
