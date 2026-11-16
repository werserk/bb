# Autosay implementation and verification

## Result

Implemented on `feat/autosay-thr_kcc869cqv6`, based on `5a77b30f94be2d0ce7bf4d0ec43da626e03efa6e`. No daily installation, merge or publication. Autosay is an optional standalone plugin in `plugins/autosay`; the matching core/Composer adds the experimental scoped suggestion capability.

Tab and the touch button accept a transient candidate into an editable draft. Enter alone does not send the candidate. The host invalidates on edits (including type then erase), questions, context changes, disconnect, focus loss and renderer teardown. Generation is default-off, explicitly configured, bounded, cancellable and without tools/retries/fallbacks. CLI/RPC share the backend service.

## Checked

- `pnpm exec turbo run test typecheck lint --filter=bb-plugin-autosay --concurrency=1`: 24 tests, types/lint passed (`autosay-plugin-final.log`). Includes local real HTTP transport, no-tools/read-only SDK assertion during enabled generation, default-off/CLI validation, native settings validation and mounted late-result cancellation.
- Host/Composer final focused suite: 18 tests passed; 186 outside the selected filter. Durable question query invalidation, real TipTap Tab/Enter/undo, type-erase race, two composers, IME, renderer teardown (`autosay-host-evidence/final-host-tests2.log`). SDK suggestion/harness suite: 10 passed. Earlier broader regression: app191 and Composer103 passed, 3 existing skips; these precede the final lifecycle/layout patches.
- Narrow-layout regression1 passed; app/Composer typecheck/lint9 tasks passed under Node22 (`narrow-layout-test.log`, `narrow-types-lint.log`). Lint has existing warnings; zero errors.
- `pnpm start:worktree --dryrun` and subsequent rebuilt launch succeeded. `bb plugin build plugins/autosay` using the source CLI built the standalone server/app bundles; local lab install was running and compatible. Node22 native ABI switch initially segfaulted after replacing the loaded SQLite binary; a fresh `--check` succeeded and the subsequent normal launcher succeeded. No source workaround or shared binary overwrite was introduced.
- Actual built BB on port24951, separate marked data directory: ghost visible; Enter leaves it outside draft; Tab accepts; accepted text can be edited; delayed response during typing is discarded; narrow390 viewport and actual touchscreen.tap accept; an open durable question removes an already shown suggestion. Browser evidence: `autosay-browser-enter.json`, `autosay-browser-tab.json`, `autosay-browser-edit.json`, `autosay-browser-late.json`, `autosay-actual-touch.json`, `autosay-live-question-before.json`, `autosay-live-question-after.json`.
- Narrow screenshot exposed compact clipping, fixed by expanding while a candidate is visible and keeping the button outside a bounded text scroller. Rebuilt screenshot `autosay-narrow-final.jpg` was inspected.
- Enabled fixture generation wrote zero `plugin_kv` rows; suggestion text was absent from the isolated runtime logs (`autosay-retention-check.json`). Normal accepted drafts and deliberately saved QA evidence are outside this additional-retention claim.
- Independent spec and code reviews found no remaining source blockers. Final narrow-layout fix independently reviewed PASS.

## Limits and observations

The lab used synthetic normalized conversations labelled Codex/Claude and a local HTTP fixture. This verifies the assembled product path, not actual provider transcripts or semantic usefulness. No real generator endpoint/model was selected. Real model quality/latency, authenticated provider turns, native iOS Safari and the exhaustive live race matrix remain unverified; automated coverage is not relabelled live coverage.

A synthetic question withdrawal exercised BB's normal answer-delivery path and attempted to resume the fixture Claude session. It failed locally because `fixture-session` is not a valid session UUID; token usage reported zero. The fixture was stopped. The final open-question invalidation test left its question open instead of withdrawing it. This was not an Autosay-generated turn.

The repository verification inventory has pre-existing drift (`Unmapped CLI family: diagnostics`); no unrelated inventory rebaseline was made.

## Cleanup and next step

Autosay was disabled in the lab. Owned BB/fixture-server processes and browser session were stopped; ports24951,32951,43127 have no listeners. The isolated data and worktree are preserved for reproducibility; daily BB was untouched.

Next acceptance gate is an explicitly selected generator endpoint and model, using synthetic context first. A separate owner decision is required before updating daily BB. No API key belongs in chat or the repository; configure it through native secret settings.

Rollback: disable/remove Autosay via native plugin controls to stop new requests and clear candidates. Core has no migration/daemon protocol change. Older hosts fail closed for the UI capability; interactive suggestions require this core/Composer change. Reverting this feature commit restores the prior core source; no database rollback is required for this feature alone.
