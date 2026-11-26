# Block 3 probe report: Codex without a silent local fallback

Answers to the probe of [#3](https://github.com/werserk/bb/issues/3), checked against the Codex installed on the worker host (`codex-cli 0.167.1`, source read at tag `rust-v0.167.1`). No model calls: a local mock Responses API plays the model. Raw evidence stays with the builder because it names machines; this page carries the results.

## Verdict

**Route A works without a core or provider change: BB plugin tools reach Codex as `dynamicTools`, and native tools are off.** It needs one write outside the scratch directory, a per-binding hook-trust entry in the worker's `~/.codex/config.toml` (owner decision, see [decisions](decisions.md)). Route B is rejected.

| Route | Result | Why |
|---|---|---|
| A. Plugin tools, native tools off | **Works**: nothing acts on the worker | A scratch `.codex/config.toml` turns features off; a scratch `.codex/hooks.json` `PreToolUse` allowlist blocks everything else, including `apply_patch` and other plugins' tools. |
| B. Codex exec-server, `environments.toml` or `environment/add` | Rejected | `environments.toml` is read only from `CODEX_HOME`, so it applies to every Codex thread on the worker. Per-thread selection is a `thread/start` parameter or an `environment/add` request that only `provider-codex` can send, which is a provider change. The workspace host would also need the Codex binary and a path to the worker. And there is the known silent fallback (`openai/codex#41563`, `#50374`, `#61463`). |

## The no-fallback test

The profile's `check` runs it on the worker before every spawn ("canary"); the same code runs in vitest on a synthetic config (`profiles/codex-canary.test.ts`, skipped when `codex` is absent).

It starts a real `codex app-server`, the binary the bridge would run, against a mock model. The mock's first reply calls every way Codex could act on the worker, and each way would touch a marker in a worker-only directory:

- `exec_command`, `shell`, `shell_command` and `local_shell_call`;
- `apply_patch` in its custom and function forms;
- `view_image` of a worker file;
- code-mode `exec` running `tools.exec_command` and `tools.apply_patch`, plus escape attempts (`require`, `process`, `Deno`, `fetch file://`);
- `read_mcp_resource`;
- an MCP tool, flat and namespaced; the canary maps each MCP server name in the worker's config to a fake server that leaves a marker when it starts or is called;
- another plugin's dynamic tool, direct and nested;
- `workspace_exec`, direct and nested. These calls must reach BB.

It then calls every offered tool that is not on the allowlist, direct and nested; the nested list comes from `Object.keys(tools)` inside `exec`. **The gate refuses the spawn if:**

- any marker exists;
- the guard hook is not `trusted`;
- `workspace_exec` did not reach BB both ways;
- a non-allowlisted call reached BB;
- a call was not blocked by the hook. Only a named Codex refusal that comes before the hook counts as blocked: `apply_patch` and `read_mcp_resource` with an empty input;
- a custom or freeform tool other than `exec` and `apply_patch` is offered, since Codex hooks only function payloads by default;
- a hosted tool is offered.

Markers are secondary evidence; an unblocked call fails the gate even when its marker has not appeared yet.

It can fail, and the baseline proves it:

| Run (mock model) | Acted on the worker | `workspace_exec` reached BB | Other plugin's tool |
|---|---|---|---|
| No scratch config (what a Codex thread gets today) | `exec_command`, `apply_patch`, code-mode `exec_command`; user MCP servers started | yes | ran |
| Scratch config, hook present but **untrusted** | `apply_patch`, code-mode `apply_patch` | yes | **ran** |
| **Route A: scratch config and trusted hook** | **nothing** | yes, direct and nested | blocked |

Canary results on the worker host with Codex 0.167.1:

| Config | Model | Calls | Failures | Time (two runs) |
|---|---|---|---|---|
| Synthetic | `gpt-5.6-luna` (code mode only) | 19 | 0 | 0.8 s, 5.5 s |
| Synthetic | `gpt-5.5` (direct tools, no `exec`) | 23 | 0 | 0.5 s, 3.0 s |
| The worker's real user config (9 MCP servers), dry run | the config's default | 27 | 0 | 7.3 s, 5.2 s |

Hook-trust discovery adds 0.2–1.2 s. The dry run left the real `config.toml` byte-identical. The canary runs with a temporary `CODEX_HOME` that holds only the tool- and trust-relevant keys and no credentials, and with a minimal environment.

## Facts this rests on (0.167.1 source and runs)

1. **Unlisted tools still run.** A code-mode-only model is offered `exec`, `wait` and `request_user_input`, yet direct calls to `exec_command` and `apply_patch` ran. A tool missing from the list can still run: this is the fallback class the test targets.
2. **Project config loads in BB threads.** `thread/start` auto-trusts the cwd when it has no trust entry and the effective permissions can write it. BB's `workspace-write` and `danger-full-access` both qualify. The profile writes the project trust itself, so the thread's own `thread/start` does not rewrite the file.
3. **Features off by project config:** `shell_tool`, `unified_exec`, `view_image`, `multi_agent`, `apps`, `plugins`, `browser_use`, `computer_use`, `image_generation` and `memories`, plus each user MCP server by name. These are defence in depth, not the barrier:
   - `multi_agent = false` removes the direct subagent tools but not the nested `multi_agent_v1__*` tools inside code-mode `exec`. With an untrusted hook, a nested `spawn_agent` starts a subagent; the trusted hook blocks it.
   - `memories = false` is load-bearing: the memory consolidation subagent runs with a reduced hook set.
   - Hosted `web_search` cannot be hooked, so `web_search = "disabled"` removes it.
   - An MCP name in the scratch config that is missing from the user config breaks config loading (`invalid transport`). This fails closed.
4. **`apply_patch` cannot be turned off by config.** Only the model catalog's `apply_patch_tool_type` gates it, and every catalog model has `freeform`. A project `model_catalog_json` is parsed but not used for tools (`openai/codex#60069`). The hook blocks it.
5. **Hooks need trust from the user layer.** `PreToolUse` covers function tools, `apply_patch`, MCP and nested code-mode calls, but not the `exec` carrier itself. Code-mode `exec` is a V8 isolate where `require`, `process`, `Deno` and `fetch` are undefined; it reaches only nested tools.

   Hook trust is read only from the user and session-flag layers: `hooks.state."<hooks.json>:pre_tool_use:0:0".trusted_hash`. So a project cannot trust its own hook. The hash covers the hook declaration, not the script.

   An untrusted hook is skipped silently. A hook that exits non-zero other than 2, or exits 2 without stderr, counts as a failure and the tool proceeds. So the launcher maps every failure to exit 2 with a reason, as in block 1.
6. **BB tool names in Codex are plain** (`workspace_exec`) and sit next to every other plugin's tools as `dynamicTools`. The hook sees the same plain names for direct and nested calls. The plugin cannot remove other plugins' tools, so the hook blocks them.
7. **Hook input** carries `tool_name`, the raw `tool_input` (unknown keys kept) and `tool_use_id`. The live per-call check uses this input (see [architecture](architecture.md#codex)).

## Workspace host

Every connected machine held a Codex login. The owner chose to log Codex out on the workspace host used for acceptance. After `codex logout`:

- `auth.json` is absent;
- `codex login status` says "Not logged in";
- no keyring item exists, and the store setting is the default `file`;
- no `OPENAI_API_KEY` or `CODEX_API_KEY` is set in the exec environment.

All of this was checked by name only. Codex's MCP OAuth store (`.credentials.json`) is not a provider login and was left in place.

## Acceptance

| Item | Result |
|---|---|
| Spawn through the real gate on the worker host | Pass, twice (two bindings). `bb account-workers spawn --provider codex` ran `prepare` and the canary on the worker and created the binding. The scratch `.codex/` files and the trust entry (project trust plus one hook-trust key) are in place. The Codex thread started in the scratch directory and sent its first model request. |
| No-fallback canary on the worker's real user config | Pass (dry run, see above); the config stayed byte-identical. |
| Codex edits and runs code on the workspace host, decoy untouched, local tools blocked (R1) | **Not run yet.** Two attempts were refused before any sampling: first `429` (both Codex subscription accounts on the worker had used their weekly quota), then a quota/billing refusal on the owner-approved API-key account, which was disabled again right after. No tool call ran, and the workspace and decoy files are unchanged, so the attempts give no evidence either way. |
| Stop ends the remote process group (R2) | **Not run yet**, for the same reason. The Stop path itself is shared with blocks 1 and 2. |
| Native tools unavailable, other plugins' tools blocked | Covered by the canary, against the real `codex app-server` with a mock model. The live check is pending R1. |
