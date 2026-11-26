# Block 2 probe report

Answers to the questions of [#2](https://github.com/werserk/bb/issues/2) and its acceptance results. They were checked on the same two machines as [block 1](probe-1.md): a worker host that runs the BB server and has the OpenCode login, and a workspace host with only the BB daemon. The worker ran OpenCode v2.2.7 and a BB release with plugin SDK 0.6.132; the branch's tests also pass against the workspace SDK. The agent under test was OpenRouter DeepSeek V4.1 Flash through OpenCode. It ran twice; the third allowed run was not used. Raw evidence (commands, outputs, hashes) stays with the builder because it names machines. This page carries the results.

## Probe questions

| # | Question | Answer | How it was checked |
|---|---|---|---|
| 1 | Where can a plugin turn off OpenCode's native tools without a core or provider-plugin change? | In the session directory. OpenCode 2 reads `.opencode/opencode.json` and `.opencode/plugins/*.js` from the working directory and its ancestors, with no trust prompt. The profile writes both into the scratch directory ([architecture](architecture.md#opencode)). | OpenCode v2.2.7 source; a no-model probe in a fresh scratch directory: the scratch config is listed as a source, the guard plugin is `active`, and no removed plugin is loaded. |
| 2 | Is a permission deny enough? | No. Upstream BB patches the session to allow `edit`, `shell`, `webfetch` and `external_directory` for `*`, after the config rules, so those four would end up allowed. The profile therefore removes the tool plugins, which takes the tools away whatever the rules say. | No-model probe: per-agent rules from `/api/agent` for every agent, including the hidden compaction, title and summary agents. The running BB leaves exactly the allowlist allowed. With upstream's patch appended, only those four actions are allowed by rule, and their tools are not loaded. The upstream case is computed from the probe's rules, not run against upstream BB. |
| 3 | What does the model see? | Only the eight allowed tools: the seven `bb-bridge_workspace_*` tools and `bb-bridge_bb_update_plan`. With `execute` denied, OpenCode offers MCP tools directly instead of through code mode. | Live run 1: the agent listed exactly those eight tools. |
| 4 | Does the seam take a third profile without touching shared code? | Yes. A profile is one file plus one entry in `profiles/index.ts`. `prepare`, `check` and `verify` run on the worker. A `check` refusal removes the scratch directory and creates no binding; a `verify` refusal marks the binding broken until `rebind`. | Unit tests: generic prepare/check/cleanup, unknown profile, spawn refusal before any host call, per-call verify with a fake profile (pass, refusal marks broken, transport failure does not), configure on a provider mismatch and on a broken binding, migration of a block 1 binding database. |
| 5 | Does Claude still get exactly block 1's files? | Yes. | Golden unit test against block 1's output. Without a model: a deferred Claude spawn wrote `.claude/` files byte-identical to block 1's apart from the scratch and node paths, with the launcher mode unchanged; the thread was then deleted. |

## Acceptance

| Item | Result |
|---|---|
| An OpenCode thread on the worker reads, edits and runs a command in a repo on the workspace host via the plugin tools | Pass. The agent used `workspace_read` to read `AGENTS.md` and quoted the marker only that file asks for. It fixed a failing test with `workspace_edit` and ran the tests with `workspace_exec` (`OK`); `uname -n` printed the workspace host's name. The file's sha256 changed on the workspace host, and `git status` there shows only that file modified (plus the test run's `__pycache__`). |
| A file at the same absolute path on the worker is untouched | Pass. The decoy repo on the worker has the same sha256 before and after. |
| Each native OpenCode file/shell tool is denied, one failed attempt per tool class | Pass. The agent was asked to call each of `read`, `write`, `edit`, `glob`, `grep`, `bash`, `shell`, `webfetch`, `websearch`, `task`, `subagent`, `skill`, `execute`, `rtk_shell`, `update_environment_directory` and `agent_plugins_call` once. Every attempt failed before a call could be issued: the name is not among the tools OpenCode offers, so the model reported "no such tool available to me". The timeline holds no call other than the workspace tools and `bb_update_plan`. Unit tests cover the guard plugin for calls that do get issued: it rejects any other tool, including code-mode inner calls, and forces deny on any other permission. |
| Stop ends the remote process group | Pass. Live run 2: `bb thread stop` during `workspace_exec sleep 300`. `ps` on the workspace host showed the group one second before the stop and nothing five seconds after it. |
| Rebind behaves as in block 1 | Pass, without a model. After `rebind` to a second root on the workspace host, `bb account-workers exec` ran there. A rebind to the worker was refused with the same-machine message, and the binding was unchanged. After a rebind back, exec ran in the first root again. |
| No provider login on the workspace host | Pass. `test -e` on the usual Claude and OpenCode paths: all absent. No `claude` or `opencode` CLI. No provider key variable names in the exec environment (checked by name only). The workspace host still has a Codex CLI with no Codex login (block 3). |
| No worker files in the scratch directory after the run | Pass. It holds only `.opencode/`. |
| The profile is documented | [architecture](architecture.md#provider-profiles), [decisions](decisions.md). |

## No-model probe recipe

OpenCode's tool list is not exposed by any API, so the check reads what decides it:

1. Build the scratch directory with the branch's host code (`prepareScratch`, profile `opencode`), under a fresh binding id.
2. `opencode debug config` in that directory: the scratch `.opencode/opencode.json` is a source.
3. `GET /api/plugin` on OpenCode's background service with `x-opencode-directory` set to the scratch directory, polled until it settles. `account-workers.guard` is `active`; no `opencode.tool.*`, `opencode.tools*`, `opencode.browser` or `opencode.config.command` plugin is listed.
4. `GET /api/agent` for that directory: each agent's last matching rule allows exactly the allowlist and denies `*`. Then append upstream BB's session rules and check again.
5. Remove the scratch directory.

The background service caches an instance per directory: re-creating a deleted directory at the same path returns the old instance. Hence the fresh id (bound threads are not affected; each ACP session starts its own server).

## Findings on the way

- OpenCode 2 ignores `OPENCODE_PERMISSION`, the only setting the running BB passes; the permission rules come from config and from upstream BB's session patch.
- A plugin that fails to load is skipped, so the guard fails open; removal and the deny rules do not depend on it.
- The host entry runs with the daemon's environment, not the project's BB machine variables, which do reach the thread. A machine variable such as `OPENCODE_DISABLE_PROJECT_CONFIG` would make OpenCode skip the scratch config entirely, so `spawn` also checks the project's and the global machine variable names (found in the diff review; unit-tested, not run live).
- The workspace host keeps a Codex CLI and Codex's MCP OAuth token store, which `workspace_exec` can reach. It is not a provider login; it is accepted for the owner's own machine.
- An OpenCode Console integration source (providers only) sometimes appears in `debug config`; it carries no tools or permission rules.
- What still runs on the worker without a tool call is listed under G2, and the provider-switch gap under G8, in [architecture](architecture.md#open-points).
