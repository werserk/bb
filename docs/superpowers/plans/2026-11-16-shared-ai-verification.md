# Shared AI generation verification

## Scope and environment

This record covers the native shared text API, Codex/Pi adapters, AI Gateway and the Autosay-to-Prompt-Suggestion migration. Evidence is in thread storage for `thr_kcc869cqv6`. Isolated app/server port 24951 and daemon port 32951 belong to the marked worktree lab; daily ports 38900/38901 are excluded from fixtures.

No model is selected automatically. Prompt Suggestion is installed enabled as a plugin, but its generation setting defaults off. The previous Autosay installation was disabled before its source directory was renamed; its stored settings were preserved.

## Automated evidence

- Consumer Turbo typecheck/lint/test: 13 tasks succeeded; Prompt Suggestion 21 tests and AI Gateway 19 tests passed (`shared-ai-consumers-checks3.log`).
- Provider Turbo typecheck/lint: 9 tasks succeeded; Pi 7 tests and Codex 39 tests passed (`shared-ai-providers-final-checks.log`, `shared-ai-pi-final-tests.log`, `shared-ai-codex-final-tests.log`).
- Shared dispatcher: 16 tests passed (`shared-ai-sdk-final-tests.log`).
- SDK fake host: 102 tests passed (`shared-ai-fakehost-final-tests.log`).
- Server AI behavior, native Bearer/token routes and bundled catalog: 113 tests passed (`shared-ai-server-final-tests2.log`). Existing helper-task and voice behavior remains covered.
- Packaged Pi host imported and listed zero models in an empty isolated HOME outside workspace dependency resolution (`shared-ai-pi-packaged-smoke.log`).

Commands use Node 22.19 and Turbo with the named package filters; full invocations and output are retained in those logs. Initial failed runs exposed stale SDK build ordering, a test callback type error and missing bundled catalog metadata. Those causes were fixed and the relevant checks rerun successfully.

## Independent review

`/root/ai_contract_review` reviewed the plan, shared contract, provider boundaries, consumers and packaging. Three findings were fixed: native aliases now remain separate from requested selection identity; all qualified-model consumers share the 12,288-character bound; native model-setting writes validate that bound before storing. Final source/packaging verdict: PASS. Review did not claim live runtime acceptance.

## Verification boundary

The repository-wide verification inventory currently reports the pre-existing unmapped `diagnostics` CLI family (`shared-ai-inventory.log`). This task uses focused recipes for plugin settings, composer interactions, CLI/SDK parity and authentication. It does not claim an exhaustive BB verification-map pass.

The immutable release receipt remains a separate deployment check. Initial supported generation routes are default primary-host Codex and standalone Pi configured models. Claude/ACP, custom Codex routes, streamed completions, tools, images, Responses API and embeddings are not advertised as supported by this release.

## Assembled runtime evidence

The optimized worktree build and dry run succeeded. Both plugins were automatically installed from bundled artifacts and reported running; Prompt generation started off. In the isolated lab, the unchanged OpenAI SDK passed seven discovery/completion/authentication/unsupported-input checks (`shared-ai-openai-smoke.json`); the native CLI stdin completion passed (`shared-ai-cli-smoke.json`). Gateway settings displayed the expected URL and Copy API key control without rendering the token.

The original lab inherited the current agent's account-pool environment. The Codex adapter correctly rejected the mismatched catalog/generation route. Restarting with only `CODEX_OPENAI_BASE_URL` and `CODEX_POOL_AUTH_TOKEN` removed yielded eight real Codex models; production daemon lacks those variables. No credentials or native config changed. Pi has no native auth file, so live Pi inference is not claimed (`shared-ai-native-catalog-diagnosis.json`).

A real default Codex GPT-6.1-Sol request through the unchanged OpenAI SDK returned the exact synthetic marker, correct model and actual usage in 6474 ms (`shared-ai-real-smoke.json`). Prompt Suggestion's real controller produced a Russian suggestion from a synthetic conversation, with successful generation latency 7328 ms (`shared-ai-real-suggestion15.json`, `shared-ai-real-suggestion-diagnostics.json`). An initial 8-second attempt failed; the default was raised to 15 seconds while retaining the 30-second cap. Independent review approved this evidence-based adjustment; all 10 final Prompt Turbo tasks passed (`shared-ai-prompt-final-checks.log`).

Browser input verified the model picker and persistence after reload, empty-editor placeholder, Tab acceptance followed by editing, and Enter's exact send payload in Codex/Claude fixture threads. Enter was intercepted before provider dispatch, so no ordinary agent work was started (`shared-ai-browser-model-selected.json`, `shared-ai-prompt-placeholder.json`, `shared-ai-prompt-tab.json`, `shared-ai-prompt-enter.json`). Fixture responses are labeled synthetic and are not evidence of inference quality. Screenshot retry scripts initially reloaded immediately after enabling and therefore cancelled the request; the one-attempt-per-turn guard behaved as designed.

The final browser capture shows a real GPT-6.1-Sol suggestion in the empty composer (`shared-ai-real-prompt-ui.json`, `prompt-suggestion-preview.jpg`). The response took 8002 ms, supporting the increased default. Lab generation was disabled and its model cleared after verification; the synthetic provider was disabled. Neither the fixture nor its settings are part of the release.
