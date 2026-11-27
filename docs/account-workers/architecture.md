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

`bb account-workers spawn --workspace-machine <m> --path <dir> --machine <worker> --prompt … [--account <id|label>] [--on-limit fallback-auto|stop]`:

1. picks the provider profile for `--provider` (default `claude-code`, passed to BB explicitly); a provider with no profile is refused before any host call;
   with a named `--account`, it also finds the Account Pooler's `thread-account.v1` and resolves the account before anything is created (see [accounts](#accounts));
2. resolves the workspace root on its host (`resolveRoot`: realpath, `AGENTS.md`/`CLAUDE.md`);
3. creates the scratch directory on the worker through the profile (`prepareScratch`, see [provider profiles](#provider-profiles)); a refusal leaves no binding;
4. stores an unclaimed, not-ready binding (`thread_id` NULL, `ready` 0) for that scratch path, with the profile id;
5. spawns the thread on the worker with the scratch directory as an unmanaged workspace and the chosen provider and model; if that fails, the binding is released (below);
6. stamps the thread id on the binding; with `--account`, stores the thread's account policy while the dispatch hook still holds the first turn;
7. marks the binding ready unless it was released meanwhile, and asks core to re-ask the dispatch hook. Only the pool calls of `--account` leave time for a release (the ready deadline passed, or the thread was archived or deleted); then the spawn is undone and fails. Without `--account` the claim and the ready mark run with no wait between them.

`bb.agents.configure` can run before step 6 returns. It then claims the binding whose `(worker host, scratch path)` matches the thread's environment, but only while `thread_id` is NULL, so a fork or side chat that shares the directory never gets one. Bindings are looked up by thread id only.

The workspace host is never the worker host: `spawn` and `rebind` refuse it before calling either host, and every tool call refuses a binding where the two match.

`rebind` points a bound thread at another workspace: the next tool call goes there. It also clears a broken mark (see [provider profiles](#provider-profiles)). `unbind` and `list` manage bindings (`list --all` includes released ones); `exec --thread <id> -- <cmd>` runs a command through the same server path as `workspace_exec`, for testing Stop and connection loss without a model.

Two threads bound to one root, or parallel calls on one file, have no locking; `expected_sha256` is check-then-write, not atomic.

### Dispatch hold

A `message.dispatch` hook (`dispatch.ts`) decides every turn before it reaches a provider. It reads only the plugin's SQLite rows, so it answers in milliseconds and never throws: on an error, a thread this plugin created waits and any other thread proceeds.

| Thread and binding | Decision |
|---|---|
| Not created by account-workers, no binding | proceed |
| Created by account-workers, no binding yet | wait (re-asked every 2 s); refused 60 s after the thread was created |
| Binding released (tombstone) | refuse: "spawn a new thread" |
| Provider not in the profile's `providerIds` | refuse (G8) |
| Binding not ready | wait; after 60 s refuse, stop the thread and release the binding |
| Ready binding, thread still `pending`, `spawn --send-at` time still ahead | wait until that time |
| Ready binding | proceed |

Every wait names its re-ask time under the old key `sendAt`, which both cores read. A core on SDK 0.6.132 reads only that key and strips the newer `recheckAt`; from SDK 0.6.174 on, core reads `sendAt` as the old name of `recheckAt`.

**`--send-at` is the plugin's guarantee, not core's.** On a core without get-bb/bb#7872 (SDK 0.6.132 and forks of it), a plugin wait replaces the sender's `sendAt` on the queued row, and the drain after the wait rebuilds the payload without it. So a scheduled first message went out as soon as the hold let it through: live on 2026-11-27, `--send-at +1d` dispatched right after the spawn readied the binding. `spawn` now stores the requested time on the binding when it creates it, never from the queue row, and the hook keeps the thread's messages waiting until then while the thread has not started (`thread.status` is `pending` until its first message is admitted; archive and unarchive do not change it), with that time as the re-ask time. Once the thread has started, for example through Send now, the schedule has no meaning left and later messages proceed. Readiness and the schedule are two separate gates. A missing or past-due time means proceed. A release clears the time at once. An archive keeps it through the undo window, so an unarchive restores the hold, and the final release clears it. Once core keeps the sender's time under a plugin wait, this wait is redundant but harmless. **Send now** skips it like any hook. The time given to `spawn` wins over a later reschedule to an earlier time; only Send now sends earlier.

So the first session never starts before `spawn` has claimed the binding, and a released or provider-switched thread cannot start a dispatched turn. Four paths skip the hook by BB design: the user's **Send now** on a queued message, the re-send of an **edited message**, **compaction** (both work on the existing conversation), and a **disabled plugin**, which runs no hook. On those paths `configure` still gives a released or provider-switched thread no workspace tools.

### Release

A binding ends in two steps (`release.ts`):

1. **Tombstone** (`released_at`, with a reason). From then on the hook refuses turns, `configure` gives no tools and tool calls refuse. Nothing on the worker changes yet.
2. **Release on the worker**, once the tombstone is due and the thread has no live turn (`starting`, `active` or `stopping`). The host method `releaseScratch { bindingId, profile, scratchPath }` runs the profile's `release` (Codex: remove its trust keys, built from the stored scratch path), then removes `scratch/<bindingId>`. It accepts only ids the server mints (`aw_<16 hex>`), builds the path from the id and removes it without realpath, so a symlinked entry loses only the link. The row stays with `cleaned_at` as the record.

| Trigger | Tombstone | Worker release |
|---|---|---|
| `unbind` | now; refused while the thread runs ("stop it first") | at once |
| `thread.archived` | now, reason `archive` | after BB's 30 s archive undo window |
| `thread.unarchived` before the tombstone is due | removed (undo keeps the binding) | none |
| `thread.deleted` | now, reason `delete` (an unarchive cannot undo it) | after 30 s |
| `threads.spawn` fails | now, reason `spawn-failed` | at once |
| Binding never readied (hook, 60 s) | now, reason `abandoned`; the thread is stopped | when it is quiet |

A timer for the next due tombstone, plus sweeps on plugin start, `list`, every `thread.idle` and every `thread.failed`, run due releases. A failed release keeps the row with `release_error`; `list` shows it and `unbind` retries it (sweeps do not). An unarchive at or after the due time leaves the thread released, so the undo and the worker release never overlap; a binding with `cleaned_at` counts as released even without a tombstone. A sweep asked for during a pass runs once more after it. `releaseScratch` refuses a scratch path whose last segment is not the binding id.

### Instructions

`configure` is synchronous, so the workspace's `AGENTS.md` and `CLAUDE.md` are read at bind time (`spawn`, `rebind`) and served from the binding. Each file is capped at 12 000 chars with a truncation flag, deduplicated by realpath, and quoted in a fence as read-only workspace text, under a header that names the workspace host and root and says to use the workspace tools. A live provider session keeps the instructions and tool list it started with; both refresh at the next session (G5).

The workspace text is a prompt-injection surface; the tool guard below bounds what it can make the agent do on the worker.

### Thread placement and native tools (Claude)

The thread runs on the worker host in a scratch directory outside BB's data directory (BB refuses to start a thread in a path inside its managed storage): `$XDG_STATE_HOME/bb-account-workers/scratch/<bindingId>`, default `~/.local/state/…`. It holds nothing of the workspace, only `.claude/`:

- `settings.local.json` `permissions.deny` lists the native file, shell, subagent and messaging tools (`Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Task`/`Agent`, `Workflow`, `WebFetch`, `SendMessage`, `ListAgents`, worktree tools, `update_environment_directory`, …). Deny removes them from the model's tool list, also in bypass mode.
- A `PreToolUse` hook with matcher `*` is the actual allowlist. It runs `aw-guard.sh`, which starts `aw-guard.mjs` with the daemon's node, and lets through only `mcp__bb-bridge__workspace_*`, `ToolSearch`, `TodoWrite` and `bb_update_plan` (the BB progress plan, which BB asks every agent to keep). Every other tool is blocked with exit code 2: other plugins' BB tools, user MCP servers, tools added later, and the question tools (`AskUserQuestion`, `bb_ask_question`), so a bound agent asks in its reply text. Claude Code blocks a call only on exit 2; any other non-zero exit lets it through. The launcher therefore runs the guard without `exec` and maps every result other than a clean allow (exit 0) to exit 2: bad input, a missing or broken guard script, a crash or a signal, and no node at all. A hook timeout is decided by Claude Code, not the launcher (G2).
- `configure` gives the thread no tools when its environment is not the bound scratch directory on the worker, so moving the thread elsewhere (for example with `update_environment_directory`) turns the workspace tools off instead of pairing them with an unguarded directory. The same holds for every profile.

This relies on `provider-claude-code` loading project and local settings (`settingSources` includes `project` and `local`).

### Environment provider (new-thread picker)

`provider.ts` registers the environment provider `account-workers-worker` ("On a worker"), so a thread can be started on a worker from BB's own new-thread picker instead of `spawn`. The picker's machine is the worker; the provider's inputs `{ workspaceHostId, root }` name the workspace. The app entry (`app.tsx`) supplies the inputs control: a list of the project's `local_path` sources on other connected machines, from the `choices` RPC. It submits ready only for a usable choice and blocks with the reason otherwise (no project, a new machine, a workspace or worker offline, no source on another machine).

- **Contract.** Written against the v1 (thread-based) provider contract of the cores it runs on (0.49, 0.50.1), with local types; the SDK in this repository types only v2. A v2 port is a follow-up once core drops v1.
- **`validate`** resolves the workspace (machine connected, the project has a source there, `resolveRoot` on that path) within 8 s and refuses when the inputs' root is not that source. The workspace must be another machine than the worker (`SAME_HOST`).
- **Model.** `create` gets the thread, which carries no model. The `message.dispatch` hook records the model of the start attempt (`provider_starts`, by thread id) when the intent is this provider, the thread is `pending` and the attempt is `start-turn`; it refuses a provider with no profile. `create` reads it for the profile (Codex needs it) and forgets it once the binding is recorded.
- **`create`** runs the same steps as `spawn` (machine variables, workspace, `prepareScratch` on the worker, the binding row with `owner = provider`, ready at once) under one deadline (`CREATE_DEADLINE_MS`). A timeout or failure names the step, removes any scratch directory it may have made (by binding id, also when the path is not known yet), and records no binding. A reattempt for a thread that already has a live provider binding on the same worker returns it unchanged. It returns `ownsPath: false`: the scratch directory is not a checkout, so core must not run the project's setup or teardown scripts there.
- **Lifecycle.** A provider binding is the environment's resource (`{ bindingId }`). Core's retirement calls `remove`, which tombstones the binding (reason `environment`) and runs the [release](#release) on the worker; a failed release is returned as failed, so core retries it. The plugin's own archive, unarchive and delete handlers act only on `owner = cli` bindings.
- **App reads.** `threadWorkspace` (tag `workspace:<threadId>`, invalidated on create, release and rebind) shows the bound workspace with its current branch and any issue (broken, released, offline). `rebind` moves a thread to another workspace machine of the same project. `choices` is not realtime: BB has no host events for plugins, so a machine going offline shows on the next query.

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
  release?(ctx: ReleaseContext): Promise<void>; // undo writes outside the scratch dir; no-op when nothing is there
}
// ProfileContext: scratchDir (realpath, empty), bindingId, toolNames (unprefixed), providerId, model | null, signal
// VerifyContext:  scratchDir, bindingId, toolName (unprefixed), input (the zod-parsed tool args), signal
// ReleaseContext: scratchDir (the stored path; may no longer exist), bindingId, signal
```

- **All hooks run in the host entry on the worker.** `prepareScratch { bindingId, profile, providerId, model }` looks the profile up, creates and resolves `scratch/<bindingId>`, then runs `prepare` and `check`. Any throw removes the scratch directory and refuses the spawn; a profile that writes outside the scratch directory undoes its own writes. Any error a hook throws reaches the server as a refusal naming the profile and hook, so a plain `Error` in `verify` also marks the binding broken.
- **Machine variables.** The host entry's environment does not include the project's BB machine variables, which do reach the thread. Before any host call, `spawn` reads the names (never the values) of the project's and the global machine variables and refuses when one is in the profile's `refusedMachineEnv`.
- **Per-call verify.** For a profile with `verify`, every workspace tool call first goes to `verifyProfile` on the worker, then to the workspace. A refusal marks the binding broken (`broken_reason`): later calls refuse with no host call and `configure` drops the tools, until `rebind` clears it. A failed call to the worker refuses that call only, so a short disconnect does not disable a healthy binding. Profiles without `verify` cost nothing per call.
- **Provider check.** `configure` gives the tools only while the thread's provider is one of its profile's `providerIds`; otherwise it serves a short notice instead.
- **Release.** `releaseScratch` runs `release` on the worker before it removes the scratch entry; a throw keeps the entry and is recorded as `release_error` ([release](#release)).
- **Storage.** The binding has `profile` (rows from block 1 read as `claude`), nullable `broken_reason`, and from block 4 `ready`, `released_at`, `release_reason`, `release_due`, `cleaned_at` and `release_error`, and from the `--send-at` fix `send_at`, all added in place to an existing database. Older rows read as ready and live.

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

- `.codex/config.toml` turns Codex features off (`shell_tool`, `unified_exec`, `view_image`, `multi_agent`, `multi_agent_v2`, `apps`, `plugins`, `browser_use`, `computer_use`, `image_generation`, `memories`) and forces `hooks` on, so a user config that turns hooks off cannot disable the guard. It also sets `web_search = "disabled"` and disables each MCP server named in the worker's user config, read at each spawn. These are defence in depth.
- `.codex/hooks.json` declares one `PreToolUse` hook, matcher `*`, launched through block 1's fail-closed `sh` launcher. It is the barrier. It lets through only the seven `workspace_*` tools, `bb_update_plan` and `update_plan`, and blocks the rest with exit 2:
  - `apply_patch`, which no config can turn off;
  - MCP tools;
  - nested subagent and goal tools;
  - `request_user_input`;
  - other plugins' tools.

  Code-mode `exec` and `wait` stay unhooked. `exec` is a V8 isolate without fs, process or network access, and its nested calls are hooked.
- **Hook trust.** Codex reads hook trust only from the user layer. So `prepare` writes one entry per binding into the worker's `~/.codex/config.toml`: `projects."<scratch>".trust_level` and `hooks.state."<scratch>/.codex/hooks.json:pre_tool_use:0:0".trusted_hash`. The hash comes from Codex itself (`hooks/list`).
  - The write is one atomic, verified edit: a fresh read, the addition, then a parse that must show both values. The result goes to a temp file with the same mode and replaces the config by `rename`. The edit retries if the file changed meanwhile. Edits in one daemon run one at a time, and a symlinked `config.toml` is written at its target, as Codex does.
  - If `check` fails, the same edit removes the entry by its parsed keys. If the removal fails, the spawn error says so.
  - The profile refuses to run when a system or managed Codex config layer exists.
  - `spawn` refuses when `CODEX_HOME` or `BB_CODEX_BRIDGE_APP_SERVER_COMMAND`/`_ARGS` is a BB machine variable (`refusedMachineEnv`). The thread would read those, but the host entry would not, so the trust and the gate would apply to another Codex home or binary.
- **No-fallback gate.** `check` runs the canary from [probe-3](probe-3.md#the-no-fallback-test) before the spawn and refuses the spawn on any failure. The canary uses the thread's Codex binary, model and `thread/start` config, but a temporary Codex home with no credentials, a mock model and the `danger-full-access` sandbox (the widest BB grants).
  - A Codex profile spawn needs `--model`; the canary checks that model, never the config's default.
  - The worker's `models_cache.json` is passed to the canary as its model catalog (`model_catalog_json`), so a model that exists only in the cache is checked with its own tool set. Without a cache the canary uses the bundled catalog. The gate fails when the canary's catalog lacks the model, or when the catalog marks it `code_mode_only` and `exec` was not offered.
  - The result (binary, version, model, catalog, offered tools, failures) is saved to `.aw/gate.json` in the scratch directory.
- **Live check per call.** On every allowed workspace call the guard writes `tool_name`, the raw `tool_input` and `tool_use_id` to its own file in `.aw/hb/`. `verify` consumes (deletes) one fresh heartbeat, under 15 minutes old (the longest `workspace_exec` plus a margin), that matches the call's tool and its parsed input on the parsed keys. With no match the call is refused and the binding is marked broken. A refusal therefore means the guard hook did not see a workspace call: it was skipped, untrusted or replaced. This is the only check on the real thread rather than on a copy. Consumed ids go to `.aw/verified.jsonl`; stale heartbeats are deleted.

## Accounts

Several accounts per provider, one chosen per thread. **Direction chosen** (owner, 2026-11-27): the pool is the central key keeper. Each account signs in once, in BB; a worker holds agent CLIs and scratch directories but no credentials, and a workspace host gets neither.

The Account Pooler owns the account policy of every thread and publishes it as the versioned RPC contract `thread-account.v1` (`get`, `set`, `accounts`, `events`; its `docs/THREAD_ACCOUNT_V1.md`). account-workers is one caller of it (`thread-account.ts`):

- **Discovery** by method name only: exactly one running plugin must publish `thread-account.v1.set`, `.get` and `.accounts`. No pool plugin id or internal RPC is used. Without `--account` nothing is discovered or called, so account-workers works without a pool.
- **Providers**: `--account` works for the pooled providers of the contract's "Pooled providers" table (`claude-code` → `claude`, `codex` → `codex`); others are refused before any call. `set`'s own `not-pooled` refusal is handled the same way.
- **Resolution before spawn**: `accounts` lists every pool account whatever the thread, so it is called with the calling thread's id (or a fixed probe id) before any host call. Candidates are the accounts of the spawn's provider; an exact id wins, then a unique exact label. An account labelled `auto` can be chosen only by id, because `--account auto` means the pool's choice, as in `bb pool thread set`. A typo or an ambiguous label creates nothing. Unlike `bb pool thread set`, a label shared with an account of the other provider is not ambiguous.
- **Order**: the thread is spawned with its first message; the [dispatch hold](#dispatch-hold) keeps that turn waiting while the binding is not ready. account-workers then calls `set {named, accountId, onLimit}` (default `fallback-auto`), checks that the answer stores exactly that, reads `get` once, and only then readies the binding. The first model request therefore already goes through the named policy. The window runs from inside `threads.spawn` to the ready mark: two pool calls of at most 10 s each, typically well under a second.
- **Undo**: any refusal, transport error, unexpected answer or a released binding undoes the spawn: the binding is released with reason `account-refused` (the hook rejects its turns; unarchive cannot restore it, since only archive tombstones are restored), the thread's queued messages are deleted (a row already gone counts as deleted), the policy is reset to `auto` when `set` stored or may have stored it (best effort, before the archive, since `set` refuses archived threads; a failure is reported after the original cause), the thread is archived, the scratch is cleaned, and the CLI exits 1 with a code (`account_refused`, `account_pool_error`, `account_not_applied`, `spawn_abandoned`). Nothing falls back to `auto` silently. The undo does not use the CLI's abort signal, so a cancelled spawn still cleans up. The error names each cleanup step that failed, and says "nothing was sent" only when the queued prompt was actually withdrawn and no turn is running.
- **`list`** shows each live bound thread's serving account and policy from `get` (empty when there is no pool or the call fails).
- **Audit**: the pool records the setter as `plugin-account-workers`, not the agent or user that ran the CLI.
- **Switching mid-thread** is the pool's: `bb pool thread set <thread> <account>`; the next model request goes to the new account.

Dropped: per-worker account homes and a pool bypass for them (each home needed its own sign-in on each worker). Homes may return for a worker with no hub.

## Built vs planned

| Part | State |
|---|---|
| Plugin SDK seams: `registerTool` with `threadId` and Stop signal, host entry and host client `call` by `hostId`, `agents.configure` | In upstream (used, not built here) |
| `account-pool` plugin | In upstream |
| `plugins/account-workers`: tools, routing, binding, instructions, Claude scratch profile | Built, block 1 |
| Provider profile seam, OpenCode profile | Built, block 2 |
| Codex profile | Built, block 3 |
| Dispatch hold, binding release (`unbind`, archive, delete) | Built, block 4; the `--send-at` hold after A2 |
| Environment provider `account-workers-worker`, workspace inputs control, app RPCs | Built (plugin side of core-run-on-picker); the fork's `experimental_runOnProvider` registration waits for the fork core slot |
| Account selection | Built: `spawn --account` and the account in `list` through the pool's `thread-account.v1`, block A2 ([accounts](#accounts)); the policy, passes and switching are the pool's |
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
- **G6. Scratch cleanup.** Built in block 4 ([release](#release)): `unbind`, archive, delete and a failed spawn remove the scratch directory and the profile's writes outside it. Not built: a sweep of scratch directories that have no binding row (left by earlier blocks), and an automatic retry of a failed release. Binding ids stay fresh, so a scratch path is never reused (OpenCode keeps a per-directory instance).
- **G7. Worker context reaches the workspace.** The agent runs with the worker user's instructions, memory and skill list in context (G2), and the workspace's `AGENTS.md` is quoted into its instructions. A workspace the owner does not control can ask the agent to write that context into a workspace file or pass it to `workspace_exec`, and so read it. The guard does not stop this: the workspace tools are the allowed path. Like G1, this is a precondition for foreign workspaces; options are a worker profile with no personal instructions or memory, or treating workspace instructions as untrusted and not loading them.
- **G8. Provider switch.** Closed for dispatched turns in block 4: the dispatch hook refuses a turn whose provider is not one its binding's profile guards, so the new provider never starts in the scratch directory. `configure` also drops the tools. Left open: the user's Send now on a queued message, the re-send of an edited message and compaction skip hooks, and a disabled plugin runs none; each lets the new provider start with its own native tools in an empty directory on the worker. Supporting a switch would need a re-prepare.
- **G9. Codex hook trust lives in the worker's user config.** The trust entry is written outside the scratch directory. Codex writes the same file without a lock, so a Codex write between the profile's read and its rename is lost. The edit re-reads before the rename and retries; that narrows the window but does not close it. A later `provider-codex` seam that passes hook trust through `thread/start` (the session-flag layer) would remove the write, but that is a provider change. Release removes a binding's trust entry with the same edit ([release](#release)).
- **G10. Codex gate scope.**
  - The canary runs at spawn only. It does not run on resume, or after a Codex update while a binding lives.
  - The heartbeat check covers only `workspace_*` calls on the live thread; the hook's block is what stops the other calls.
  - What Codex does on a hook timeout or a missing `sh` was not checked.
  - The canary assumes the host daemon's own process environment (`CODEX_HOME`, `BB_CODEX_BRIDGE_APP_SERVER_*`) is the bridge's. BB machine variables with those names refuse the spawn.
  - An MCP server removed from the worker's config while a binding lives makes the thread fail to load its config; this fails closed.
  - The canary has no login, so it cannot see tools that Codex offers only with a Codex-backend login (`image_generation`, apps and connectors). Their features are off in the overlay; if one came back on, its tool would appear only on the real thread, where the hook still blocks it.
  - The canary's catalog is the worker's cache. A thread whose login does not match the cache's identity uses the bundled catalog or fetches a fresh one, which may differ.
  - As with Claude (G2), the worker user's own instructions, skills and hooks still load.
- **G11. Account window.** In the one live check (2026-11-27) the hold did its job: the policy was stored 39 ms before the first turn was requested. `get`'s `serving.since` is the time of the first model request, not of `set`, so it cannot date the policy. `spawn --account` relies on the dispatch hold, so the paths that skip hooks also skip the account: the user's **Send now** on the queued first message before the policy is stored sends that turn through `auto`. The spawn then still succeeds, with a warning when `get` already shows another serving account. The warning can miss a first turn of several requests whose later requests already ran on the named account; the pool's `events` would catch that and are not read yet. Closing it needs a core change (a plugin create without a first message, then `set`, then the send). A refused spawn deletes its queued messages for the same reason: after release, Send now would skip the hook in a cleaned scratch.
- **G12. Picker start.** Core 0.49/0.50.1 runs the v1 provider contract with a deprecation warning; a core that drops v1 needs the v2 port. Send now and the paths that skip hooks (G8, G11) also skip the start model record; `create` then prepares with no model, which a Codex profile refuses. `choices` does not update live when a machine connects or drops.
- **Cloud mode.** Running without the owner's PC needs the BB server off that PC; this is deployment, not plugin code (Later).
