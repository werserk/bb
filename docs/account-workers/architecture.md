# Account Workers architecture

Status: **blocks 1–2 built** (Claude, OpenCode, provider profile seam). Code: [`plugins/account-workers`](../../plugins/account-workers). Terms are defined in the [README](README.md).

## Shape

One BB plugin, `plugins/account-workers`, with two entries:

| Entry | Runs on | Does |
|---|---|---|
| Server entry (`server.ts`) | BB server | Registers the workspace tools, keeps the per-thread binding in the plugin database, routes each call to the bound host, selects tools and instructions per thread with `bb.agents.configure`, and serves the `bb account-workers` CLI |
| Host entry (`host.ts`) | Every daemon | On a workspace host: file and process operations under the bound root. On a worker host: creates the scratch directory through the thread's provider profile, and runs the profile's per-call check when it has one |

### Tool call path

```
agent on worker host ──tool call──▶ BB server: registerTool execute(params, ctx)
  (cwd = scratch dir)                ctx = { threadId, projectId, signal }
                                     binding[threadId] → { workspace host, root, profile }
                                     broken binding → refuse
                                     profile.verify? → verifyProfile on the worker
                                          │
                                          ▼
              hosts.experimental_client({ contract }).call(method, input,
                                          { hostId, signal, timeoutMs })
                                          │
                                          ▼
                       workspace host: host entry runs the operation in root
```

- **Tools.** `workspace_read`, `workspace_write`, `workspace_edit`, `workspace_glob`, `workspace_grep`, `workspace_exec`, `workspace_diff`, registered with `bb.agents.registerTool`. Claude sees them as `mcp__bb-bridge__workspace_*`, OpenCode as `bb-bridge_workspace_*`. Paths are relative to the workspace root; absolute paths inside it also work.
- **Results.** The host contract returns `{ ok: true, … }` or `{ ok: false, error }`. A refusal (path outside the root, missing file, stale `expected_sha256`, ambiguous edit) is a tool error with the reason. A rejected host call (host gone, timeout, worker crash) is a tool error too: for `read`/`glob`/`grep`/`diff` it says nothing changed; for `write`/`edit`/`exec` it says the outcome is unknown, that the command may still be running until its exec timeout, and to re-read before retrying. No write is ever replayed: only the read-only methods are marked `experimental_retryable`. `write` and `edit` return a short unified hunk of the change (3 lines of context, at most 60 diff lines), so every change shows in the chat.
- **Confinement.** Every call re-checks that the stored root still resolves to itself (a root swapped for a symlink is refused), then resolves the path lexically and by `realpath` of its nearest existing ancestor; both must stay inside the root. Dangling symlinks are refused. `glob` uses `fs.glob` and re-confines each match; `grep` runs `rg` (or `grep -rn`) with `execFile`, `-e` and `--`, without a shell. Hardlinks that point outside the root are a known limit.
- **`workspace_exec` is not confined.** It runs `bash -c` in the root as the daemon user and can read anything that user can. Confinement guards the file tools; exec is a guardrail, not a sandbox.
- **Stop.** `ctx.signal` aborts when the tool call is cancelled or the thread is stopped. The server passes it to the host call; BB forwards the cancel to the host entry, whose handler gets `ctx.signal`. `exec` starts `bash` in its own process group, sends `SIGTERM` to the group, then `SIGKILL` after 2 s, and settles on the child's `exit` (not on stream close, so a grandchild holding stdout cannot stall it). That stays under the daemon's 5 s limit after which it kills the host worker. Processes that leave the group (`setsid`, double fork) survive (G3). The group is signalled only on cancel or timeout: a child left running with `&` after the command exits normally keeps running.
- **Timeouts.** `exec` defaults to 120 s and is capped at 600 s; its host call gets 15 s more. Other calls have a 60 s host-call budget.
- **Connection loss.** When the workspace host drops, the pending host call rejects and the tool call fails with "outcome unknown"; the turn goes on. The daemon runs host calls without the session's abort signal, so the remote command keeps running until its own exec timeout.
- **Limits.** Reads: 4 MiB per file, 2000 lines by default, 2000 chars per line. Tool text: 60 000 chars, clipped head and tail. Glob: 1000 files.

### Binding

A binding maps a thread to `(worker host, scratch path)` and `(workspace host, root, instructions)`. It lives in the plugin's own SQLite database, not in thread metadata (which the thread's agent can write).

`bb account-workers spawn --workspace-machine <m> --path <dir> --machine <worker> --prompt …`:

1. picks the provider profile for `--provider` (default `claude-code`, passed to BB explicitly); a provider with no profile is refused before any host call;
2. resolves the workspace root on its host (`resolveRoot`: realpath, `AGENTS.md`/`CLAUDE.md`);
3. creates the scratch directory on the worker through the profile (`prepareScratch`, see [provider profiles](#provider-profiles)); a refusal leaves no binding;
4. stores an unclaimed binding (`thread_id` NULL) for that scratch path, with the profile id;
5. spawns the thread on the worker with the scratch directory as an unmanaged workspace and the chosen provider and model;
6. stamps the thread id on the binding.

`bb.agents.configure` can run before step 6 returns. It then claims the binding whose `(worker host, scratch path)` matches the thread's environment, but only while `thread_id` is NULL, so a fork or side chat that shares the directory never gets one. Bindings are looked up by thread id only.

The workspace host is never the worker host: `spawn` and `rebind` refuse it before calling either host, and every tool call refuses a binding where the two match.

`rebind` points a bound thread at another workspace: the next tool call goes there. It also clears a broken mark (see [provider profiles](#provider-profiles)). Deleting the thread drops its binding. `unbind` and `list` manage bindings; `exec --thread <id> -- <cmd>` runs a command through the same server path as `workspace_exec`, for testing Stop and connection loss without a model.

Two threads bound to one root, or parallel calls on one file, have no locking; `expected_sha256` is check-then-write, not atomic.

### Instructions

`configure` is synchronous, so the workspace's `AGENTS.md` and `CLAUDE.md` are read at bind time (`spawn`, `rebind`) and served from the binding. Each file is capped at 12 000 chars with a truncation flag, deduplicated by realpath, and quoted in a fence as read-only workspace text, under a header that names the workspace host and root and says to use the workspace tools. A live provider session keeps the instructions and tool list it started with; both refresh at the next session (G5).

The workspace text is a prompt-injection surface; the tool guard below bounds what it can make the agent do on the worker.

### Thread placement and native tools (Claude)

The thread runs on the worker host in a scratch directory outside BB's data directory (BB refuses to start a thread in a path inside its managed storage): `$XDG_STATE_HOME/bb-account-workers/scratch/<bindingId>`, default `~/.local/state/…`. It holds nothing of the workspace, only `.claude/`:

- `settings.local.json` `permissions.deny` lists the native file, shell, subagent and messaging tools (`Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Task`/`Agent`, `Workflow`, `WebFetch`, `SendMessage`, `ListAgents`, worktree tools, `update_environment_directory`, …). Deny removes them from the model's tool list, also in bypass mode.
- A `PreToolUse` hook with matcher `*` is the actual allowlist. It runs `aw-guard.sh`, which starts `aw-guard.mjs` with the daemon's node, and lets through only `mcp__bb-bridge__workspace_*`, `ToolSearch`, `TodoWrite` and `bb_update_plan` (the BB progress plan, which BB asks every agent to keep). Every other tool is blocked with exit code 2: other plugins' BB tools, user MCP servers, tools added later, and the question tools (`AskUserQuestion`, `bb_ask_question`), so a bound agent asks in its reply text. Claude Code blocks a call only on exit 2; any other non-zero exit lets it through. The launcher therefore runs the guard without `exec` and maps every result other than a clean allow (exit 0) to exit 2: bad input, a missing or broken guard script, a crash or a signal, and no node at all. A hook timeout is decided by Claude Code, not the launcher (G2).
- `configure` gives the thread no tools when its environment is not the bound scratch directory on the worker, so moving the thread elsewhere (for example with `update_environment_directory`) turns the workspace tools off instead of pairing them with an unguarded directory. The same holds for every profile.

This relies on `provider-claude-code` loading project and local settings (`settingSources` includes `project` and `local`).

## Provider profiles

A provider profile turns off one provider's worker-side tools in the scratch directory. Each profile is one file in `plugins/account-workers/profiles/`; adding a provider is that file plus one entry in `profiles/index.ts`.

| Profile | BB provider ids | How it gets the tools | Native file/shell tools | Status |
|---|---|---|---|---|
| `claude` | `claude-code` | BB tools through the `bb-bridge` MCP server | Off: scratch-local settings deny plus `PreToolUse` allowlist ([above](#thread-placement-and-native-tools-claude)) | Block 1, built |
| `opencode` | `acp-opencode` | BB tools as the ACP session MCP server `bb-bridge` | Not loaded: tool plugins removed in the scratch config, `*` denied, a guard plugin ([below](#opencode)) | Block 2, built |
| `codex` | `codex` | BB plugin tools as Codex `dynamicTools` | Off: scratch `.codex/config.toml` turns features off, a `PreToolUse` allowlist hook trusted in the worker's Codex config blocks the rest; a no-fallback canary before the spawn and a heartbeat check on every call ([below](#codex)) | Block 3, built |

### Profile seam

```ts
interface ProviderProfile {
  id: string;                         // stored on the binding
  providerIds: readonly string[];     // BB provider ids it guards
  refusedMachineEnv?: readonly string[];        // BB machine variable names that refuse the spawn
  prepare(ctx: ProfileContext): Promise<void>;  // write scratch files (or worker config)
  check?(ctx: ProfileContext): Promise<void>;   // gate after prepare; throw to refuse the spawn
  verify?(ctx: VerifyContext): Promise<void>;   // before every workspace call; throw to refuse it
}
// ProfileContext: scratchDir (realpath, empty), bindingId, toolNames (unprefixed), providerId, model | null, signal
// VerifyContext:  scratchDir, bindingId, toolName (unprefixed), input (the zod-parsed tool args), signal
```

- **All hooks run in the host entry on the worker.** `prepareScratch { bindingId, profile, providerId, model }` looks the profile up, creates and resolves `scratch/<bindingId>`, then runs `prepare` and `check`. Any throw removes the scratch directory and refuses the spawn; a profile that writes outside the scratch directory undoes its own writes. Any error a hook throws reaches the server as a refusal naming the profile and hook, so a plain `Error` in `verify` also marks the binding broken.
- **Machine variables.** The host entry's environment does not include the project's BB machine variables, which do reach the thread. Before any host call, `spawn` reads the names (never the values) of the project's and the global machine variables and refuses when one is in the profile's `refusedMachineEnv`.
- **Per-call verify.** For a profile with `verify`, every workspace tool call first goes to `verifyProfile` on the worker, then to the workspace. A refusal marks the binding broken (`broken_reason`): later calls refuse with no host call and `configure` drops the tools, until `rebind` clears it. A failed call to the worker refuses that call only, so a short disconnect does not disable a healthy binding. Profiles without `verify` cost nothing per call.
- **Provider check.** `configure` gives the tools only while the thread's provider is one of its profile's `providerIds`; otherwise it serves a short notice instead.
- **Storage.** The binding has `profile` (rows from block 1 read as `claude`) and nullable `broken_reason`, added in place to an existing database.

### OpenCode

OpenCode 2 starts its own server in the session's working directory and reads project config from that directory and every ancestor, with no trust prompt. The profile writes two files into the scratch directory:

- `.opencode/opencode.json`:
  1. `plugin: ["-opencode.tool.*", "-opencode.tools", "-opencode.tools.*", "-opencode.browser", "-opencode.config.command"]` removes the built-in plugins that register native tools (shell, read, edit, write, patch, glob, grep, webfetch, websearch, subagent, skill, todo, question, schedule, artifact, image generation, session and worktree tools, MCP resources), the browser tools, and config commands (whose `!cmd` interpolation runs on the worker). A tool whose plugin is removed is not registered, whatever the permission rules say. `opencode.tool.input.repair` goes too; it only repairs tool input.
  2. `permission: { "*": "deny", "bb-bridge_workspace_read": "allow", …, "bb-bridge_bb_update_plan": "allow" }` with every allowed name spelled out, at top level and again under `agent.{build,plan,general,explore}`. Rules are last-match-wins and a tool whose last match is a whole deny is hidden, so this hides everything else: code mode's `execute` (and so its `fetch`), other BB tools (`rtk_shell`, `agent_plugins_call`, `update_environment_directory`, questions), the worker user's MCP servers and plugin tools, and tools added later. With `execute` hidden the MCP tools become direct tools.
  3. `default_agent: "build"`, `snapshots: false`.
- `.opencode/plugins/aw-guard.js`: a `tool.execute.before` hook that rejects any tool not on the same list (it also sees code-mode inner calls), and a `permission.evaluate` hook that forces deny on any other action.

`check` refuses the spawn when the worker's OpenCode is not 2.2 or a later 2.x (v1 reads this config differently; 2.0 and 2.1 were not probed), when `OPENCODE_CONFIG_CONTENT`, `OPENCODE_CONFIG`, `OPENCODE_DISABLE_PROJECT_CONFIG` or `OPENCODE_CONFIG_PROJECT_DISABLE` is set in the daemon's environment (checked by name; these load after the scratch config or switch it off), or when `/etc/opencode` exists (managed config, loaded last). The same four names set as BB machine variables, for the project or globally, refuse the spawn on the server (`refusedMachineEnv`).

**Two BB variants.** The BB this was built on only sets `OPENCODE_PERMISSION`, which OpenCode 2 ignores. Upstream BB also patches the session's rules after start: `edit`, `shell`, `webfetch` and `external_directory` allowed for `*`, ahead of the session's own rules. Effective rules are the agent's followed by the session's, so under upstream those four actions end up allowed by rule. They stay closed because their tools are not loaded (layer 1) and the guard denies them (layer 3). The no-model probe checks the rules for both variants; the upstream case is inferred from that, not run.

The layers fail differently: removal silently if OpenCode renames its plugin ids, the rules for four actions under upstream BB, the guard open if it fails to load (OpenCode skips a broken plugin). Shell on the worker needs removal and the guard to fail together.

"Denied" for OpenCode therefore means "not registered": the live run showed only the eight allowed tools, and a call to any other name cannot be issued.

### Codex

Codex gets the workspace tools as `dynamicTools`, as it gets every BB plugin tool. The scratch directory holds `.codex/` and `.aw/`. Probe and evidence: [probe-3](probe-3.md).

- `.codex/config.toml` turns Codex features off (`shell_tool`, `unified_exec`, `view_image`, `multi_agent`, `apps`, `plugins`, `browser_use`, `computer_use`, `image_generation`, `memories`). It also sets `web_search = "disabled"` and disables each MCP server named in the worker's user config, read at each spawn. These are defence in depth.
- `.codex/hooks.json` declares one `PreToolUse` hook, matcher `*`, launched through block 1's fail-closed `sh` launcher. It is the barrier. It lets through only the seven `workspace_*` tools, `bb_update_plan` and `update_plan`, and blocks the rest with exit 2:
  - `apply_patch`, which no config can turn off;
  - MCP tools;
  - nested subagent and goal tools;
  - `request_user_input`;
  - other plugins' tools.

  Code-mode `exec` and `wait` stay unhooked. `exec` is a V8 isolate without fs, process or network access, and its nested calls are hooked.
- **Hook trust.** Codex reads hook trust only from the user layer. So `prepare` writes one entry per binding into the worker's `~/.codex/config.toml`: `projects."<scratch>".trust_level` and `hooks.state."<scratch>/.codex/hooks.json:pre_tool_use:0:0".trusted_hash`. The hash comes from Codex itself (`hooks/list`).
  - The write is one atomic, verified edit: a fresh read, the addition, then a parse that must show both values. The result goes to a temp file with the same mode and replaces the config by `rename`. The edit retries if the file changed meanwhile.
  - If `check` fails, the same edit removes the entry.
  - The profile refuses to run when a system or managed Codex config layer exists.
- **No-fallback gate.** `check` runs the canary from [probe-3](probe-3.md#the-no-fallback-test) before the spawn and refuses the spawn on any failure. The canary uses the same Codex binary, model, model cache, `thread/start` config and sandbox as the thread, but a temporary Codex home with no credentials and a mock model.
- **Live check per call.** On every allowed call the guard appends `tool_name`, the raw `tool_input` and `tool_use_id` to `.aw/heartbeat.jsonl`. `verify` consumes one fresh heartbeat, under 5 minutes old, that matches the call's tool and its parsed input on the parsed keys. With no match the call is refused and the binding is marked broken. A refusal therefore means the guard hook did not see a workspace call: it was skipped, untrusted or replaced. This is the only check on the real thread rather than on a copy.

## Accounts

Several isolated accounts per worker host, one chosen per thread (block 4). The upstream `account-pool` plugin already routes Claude and Codex API traffic across account pools; block 4 reuses it where it fits and documents what is new.

## Built vs planned

| Part | State |
|---|---|
| Plugin SDK seams: `registerTool` with `threadId` and Stop signal, host entry and host client `call` by `hostId`, `agents.configure` | In upstream (used, not built here) |
| `account-pool` plugin | In upstream |
| `plugins/account-workers`: tools, routing, binding, instructions, Claude scratch profile | Built, block 1 |
| Provider profile seam, OpenCode profile | Built, block 2 |
| Codex profile | Built, block 3 |
| Account selection | Planned, block 4 |
| Earlier core implementation (PlacementService, queue, storage, cross-host runtime) | Frozen in `archive/aw/*` tags; see [decisions](decisions.md) |

## Open points

- **G1. The BB API trusts whoever can reach it.** The `bb` CLI on any BB machine reaches the server with full rights given only its URL. Anything running on a workspace host, `workspace_exec` included, can therefore spawn a thread on a worker and ask it to print the worker's credentials. Stored keys never reach the workspace, but the workspace can obtain them through the API. On the owner's own machines, which already share that trust, this is accepted. **It is a hard precondition for any workspace host the owner does not control.** Options, cheapest first:
  1. Network: workspace hosts reach only the daemon endpoint, not the user API (ACL or reverse proxy). Deployment only, if the endpoints can be separated; check that first.
  2. Server auth: scoped caller tokens; a daemon credential carries no user-API rights. Core change.
  3. A restricted "workspace-only" daemon role: serves plugin host calls, no thread runtime, no user API. Core change.
  4. The workspace host is not a BB machine: a thin plugin-owned connector with a per-binding capability. No core change, but it rebuilds the transport.
- **G2. Guard coverage.** The allowlist blocks every tool it does not name, but it holds only while Claude Code honours the scratch `.claude/` settings and hooks. A provider or settings change that skips project settings would reopen native tools; the live check in block 1 is the evidence for the current version. What Claude Code does when the hook itself times out (default 60 s) was not checked. What still runs on the worker without a tool call: Claude Code loads the worker user's own instructions, memory and skill list into context, runs the user's own hooks, and starts the user's MCP server processes (their tool calls are blocked).
  For OpenCode the guard holds while OpenCode reads the scratch `.opencode/` config and plugins; the live check pins version 2.2.7. What still runs on the worker without a tool call: the user's global config, global plugins (their code runs, and the MCP servers they add start; their tools are hidden and blocked) and skill roots; `AGENTS.md` and config files from ancestors of the scratch directory (none today); provider requests. A custom agent the user defines globally can allow a permission in its own rules, which load after the top-level deny; for it only plugin removal and the guard hold. Saved approvals cannot override a configured deny. The env and machine variable checks run at spawn only: a variable set later reaches the thread's next session unchecked. A later OpenCode 2.x minor is accepted without a new probe.
- **G3. Process escapes.** `setsid` or a double fork leaves the process group, and Stop does not reach it.
- **G4. Diff panel.** BB's native diff panel shows the thread's environment, which is the worker's scratch directory. `workspace_diff` shows the workspace in the chat; a panel view is not built.
- **G5. Instruction refresh.** Workspace instructions are read at `spawn`/`rebind` and refresh in the agent at the next session.
- **G6. Scratch cleanup.** Deleting a thread or `unbind` drops the binding but leaves the scratch directory (profile files only, no workspace data) on the worker. OpenCode's background service keeps a per-directory instance, so a scratch path is never reused: binding ids are fresh. If `threads.spawn` fails after `prepareScratch`, the binding is removed but nothing undoes a profile's writes outside the scratch directory (none for Claude and OpenCode; block 3's Codex trust entry would stay); a `release` hook can be added when a profile needs it. A cleanup on delete, or a sweep of directories with no binding, is not built.
- **G7. Worker context reaches the workspace.** The agent runs with the worker user's instructions, memory and skill list in context (G2), and the workspace's `AGENTS.md` is quoted into its instructions. A workspace the owner does not control can ask the agent to write that context into a workspace file or pass it to `workspace_exec`, and so read it. The guard does not stop this: the workspace tools are the allowed path. Like G1, this is a precondition for foreign workspaces; options are a worker profile with no personal instructions or memory, or treating workspace instructions as untrusted and not loading them.
- **G8. Provider switch.** A bound thread that changes provider in BB loses the workspace tools at the next session (`configure` checks the provider against the profile), but its scratch directory holds only the old provider's guard. The new provider then runs with its own native tools in an empty directory on the worker. BB's CLI has no provider switch for a thread today; a UI switch would need a re-prepare, or a profile that guards every provider.
- **G9. Codex hook trust lives in the worker's user config.** The trust entry is written outside the scratch directory. Codex writes the same file without a lock, so a Codex write between the profile's read and its rename is lost. The edit re-reads before the rename and retries; that narrows the window but does not close it. A later `provider-codex` seam that passes hook trust through `thread/start` (the session-flag layer) would remove the write, but that is a provider change. Trust entries of deleted bindings stay until cleanup (G6).
- **G10. Codex gate scope.**
  - The canary runs at spawn only. It does not run on resume, or after a Codex update while a binding lives.
  - The heartbeat check covers only `workspace_*` calls on the live thread; the hook's block is what stops the other calls.
  - What Codex does on a hook timeout or a missing `sh` was not checked.
  - The canary assumes the host daemon sees the same `BB_CODEX_BRIDGE_APP_SERVER_*` environment as the bridge.
  - An MCP server removed from the worker's config while a binding lives makes the thread fail to load its config; this fails closed.
  - As with Claude (G2), the worker user's own instructions, skills and hooks still load.
- **Cloud mode.** Running without the owner's PC needs the BB server off that PC; this is deployment, not plugin code (Later).
