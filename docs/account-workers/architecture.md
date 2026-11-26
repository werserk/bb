# Account Workers architecture

Status: **block 1 built** (Claude). Code: [`plugins/account-workers`](../../plugins/account-workers). Terms are defined in the [README](README.md).

## Shape

One BB plugin, `plugins/account-workers`, with two entries:

| Entry | Runs on | Does |
|---|---|---|
| Server entry (`server.ts`) | BB server | Registers the workspace tools, keeps the per-thread binding in the plugin database, routes each call to the bound host, selects tools and instructions per thread with `bb.agents.configure`, and serves the `bb account-workers` CLI |
| Host entry (`host.ts`) | Every daemon | On a workspace host: file and process operations under the bound root. On a worker host: creates the scratch directory |

### Tool call path

```
agent on worker host ──tool call──▶ BB server: registerTool execute(params, ctx)
  (cwd = scratch dir)                ctx = { threadId, projectId, signal }
                                     binding[threadId] → { workspace host, root }
                                          │
                                          ▼
              hosts.experimental_client({ contract }).call(method, input,
                                          { hostId, signal, timeoutMs })
                                          │
                                          ▼
                       workspace host: host entry runs the operation in root
```

- **Tools.** `workspace_read`, `workspace_write`, `workspace_edit`, `workspace_glob`, `workspace_grep`, `workspace_exec`, `workspace_diff`, registered with `bb.agents.registerTool`. Claude sees them as `mcp__bb-bridge__workspace_*`. Paths are relative to the workspace root; absolute paths inside it also work.
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

1. resolves the workspace root on its host (`resolveRoot`: realpath, `AGENTS.md`/`CLAUDE.md`);
2. creates the scratch directory on the worker (`prepareScratch`);
3. stores an unclaimed binding (`thread_id` NULL) for that scratch path;
4. spawns the thread on the worker with the scratch directory as an unmanaged workspace;
5. stamps the thread id on the binding.

`bb.agents.configure` can run before step 5 returns. It then claims the binding whose `(worker host, scratch path)` matches the thread's environment, but only while `thread_id` is NULL, so a fork or side chat that shares the directory never gets one. Bindings are looked up by thread id only.

The workspace host is never the worker host: `spawn` and `rebind` refuse it before calling either host, and every tool call refuses a binding where the two match.

`rebind` points a bound thread at another workspace: the next tool call goes there. Deleting the thread drops its binding. `unbind` and `list` manage bindings; `exec --thread <id> -- <cmd>` runs a command through the same server path as `workspace_exec`, for testing Stop and connection loss without a model.

Two threads bound to one root, or parallel calls on one file, have no locking; `expected_sha256` is check-then-write, not atomic.

### Instructions

`configure` is synchronous, so the workspace's `AGENTS.md` and `CLAUDE.md` are read at bind time (`spawn`, `rebind`) and served from the binding. Each file is capped at 12 000 chars with a truncation flag, deduplicated by realpath, and quoted in a fence as read-only workspace text, under a header that names the workspace host and root and says to use the workspace tools. A live provider session keeps the instructions and tool list it started with; both refresh at the next session (G5).

The workspace text is a prompt-injection surface; the tool guard below bounds what it can make the agent do on the worker.

### Thread placement and native tools (Claude)

The thread runs on the worker host in a scratch directory outside BB's data directory (BB refuses to start a thread in a path inside its managed storage): `$XDG_STATE_HOME/bb-account-workers/scratch/<bindingId>`, default `~/.local/state/…`. It holds nothing of the workspace, only `.claude/`:

- `settings.local.json` `permissions.deny` lists the native file, shell, subagent and messaging tools (`Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Task`/`Agent`, `Workflow`, `WebFetch`, `SendMessage`, `ListAgents`, worktree tools, `update_environment_directory`, …). Deny removes them from the model's tool list, also in bypass mode.
- A `PreToolUse` hook with matcher `*` is the actual allowlist. It runs `aw-guard.sh`, which starts `aw-guard.mjs` with the daemon's node, and lets through only `mcp__bb-bridge__workspace_*`, `ToolSearch`, `TodoWrite` and `bb_update_plan` (the BB progress plan, which BB asks every agent to keep). Every other tool is blocked with exit code 2: other plugins' BB tools, user MCP servers, tools added later, and the question tools (`AskUserQuestion`, `bb_ask_question`), so a bound agent asks in its reply text. Claude Code blocks a call only on exit 2; any other non-zero exit lets it through. The launcher therefore runs the guard without `exec` and maps every result other than a clean allow (exit 0) to exit 2: bad input, a missing or broken guard script, a crash or a signal, and no node at all. A hook timeout is decided by Claude Code, not the launcher (G2).
- `configure` gives the thread no tools when its environment is not the bound scratch directory on the worker, so moving the thread elsewhere (for example with `update_environment_directory`) turns the workspace tools off instead of pairing them with an unguarded directory.

This relies on `provider-claude-code` loading project and local settings (`settingSources` includes `project` and `local`).

## Provider profiles

| Provider | How it gets the tools | Native file/shell tools | Status |
|---|---|---|---|
| Claude | BB tools through the `bb-bridge` MCP server | Off: scratch-local settings deny plus `PreToolUse` allowlist | Block 1, built |
| OpenCode | BB tools over ACP | Denied by permission | Block 2 |
| Codex | Plugin tools, or Codex's native exec-server/environments via app-server | Off, with a probe for silent local fallback (`openai/codex#41563`) | Block 3 |

## Accounts

Several isolated accounts per worker host, one chosen per thread (block 4). The upstream `account-pool` plugin already routes Claude and Codex API traffic across account pools; block 4 reuses it where it fits and documents what is new.

## Built vs planned

| Part | State |
|---|---|
| Plugin SDK seams: `registerTool` with `threadId` and Stop signal, host entry and host client `call` by `hostId`, `agents.configure` | In upstream (used, not built here) |
| `account-pool` plugin | In upstream |
| `plugins/account-workers`: tools, routing, binding, instructions, Claude scratch profile | Built, block 1 |
| OpenCode and Codex profiles | Planned, blocks 2–3 |
| Account selection | Planned, block 4 |
| Earlier core implementation (PlacementService, queue, storage, cross-host runtime) | Frozen in `archive/aw/*` tags; see [decisions](decisions.md) |

## Open points

- **G1. The BB API trusts whoever can reach it.** The `bb` CLI on any BB machine reaches the server with full rights given only its URL. Anything running on a workspace host, `workspace_exec` included, can therefore spawn a thread on a worker and ask it to print the worker's credentials. Stored keys never reach the workspace, but the workspace can obtain them through the API. On the owner's own machines, which already share that trust, this is accepted. **It is a hard precondition for any workspace host the owner does not control.** Options, cheapest first:
  1. Network: workspace hosts reach only the daemon endpoint, not the user API (ACL or reverse proxy). Deployment only, if the endpoints can be separated; check that first.
  2. Server auth: scoped caller tokens; a daemon credential carries no user-API rights. Core change.
  3. A restricted "workspace-only" daemon role: serves plugin host calls, no thread runtime, no user API. Core change.
  4. The workspace host is not a BB machine: a thin plugin-owned connector with a per-binding capability. No core change, but it rebuilds the transport.
- **G2. Guard coverage.** The allowlist blocks every tool it does not name, but it holds only while Claude Code honours the scratch `.claude/` settings and hooks. A provider or settings change that skips project settings would reopen native tools; the live check in block 1 is the evidence for the current version. What Claude Code does when the hook itself times out (default 60 s) was not checked. What still runs on the worker without a tool call: Claude Code loads the worker user's own instructions, memory and skill list into context, runs the user's own hooks, and starts the user's MCP server processes (their tool calls are blocked).
- **G3. Process escapes.** `setsid` or a double fork leaves the process group, and Stop does not reach it.
- **G4. Diff panel.** BB's native diff panel shows the thread's environment, which is the worker's scratch directory. `workspace_diff` shows the workspace in the chat; a panel view is not built.
- **G5. Instruction refresh.** Workspace instructions are read at `spawn`/`rebind` and refresh in the agent at the next session.
- **G6. Scratch cleanup.** Deleting a thread or `unbind` drops the binding but leaves the scratch directory (`.claude/` only, no workspace data) on the worker. A cleanup on delete, or a sweep of directories with no binding, is not built.
- **G7. Worker context reaches the workspace.** The agent runs with the worker user's instructions, memory and skill list in context (G2), and the workspace's `AGENTS.md` is quoted into its instructions. A workspace the owner does not control can ask the agent to write that context into a workspace file or pass it to `workspace_exec`, and so read it. The guard does not stop this: the workspace tools are the allowed path. Like G1, this is a precondition for foreign workspaces; options are a worker profile with no personal instructions or memory, or treating workspace instructions as untrusted and not loading them.
- **Cloud mode.** Running without the owner's PC needs the BB server off that PC; this is deployment, not plugin code (Later).
