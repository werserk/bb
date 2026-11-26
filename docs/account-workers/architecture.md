# Account Workers architecture

Status: **planned**. Nothing of `plugins/account-workers` is built yet; block 1 ([#1](https://github.com/werserk/bb/issues/1)) writes it. Terms are defined in the [README](README.md).

## Shape

One BB plugin, `plugins/account-workers`, with three entries:

| Entry | Runs on | Does |
|---|---|---|
| Server entry (`bb.server`) | BB server | Registers the workspace tools, keeps the per-thread binding, routes each call to the bound host, contributes workspace instructions |
| Host entry (`bb.host`) | Every daemon; used on workspace hosts | Executes file and process operations under the bound path |
| App entry (optional) | BB app | Binding picker; a diff view of the workspace |

### Tool call path

```
agent on worker host ──tool call──▶ BB server: registerTool execute(params, ctx)
                                     ctx = { threadId, projectId, signal }
                                     binding[threadId] → { hostId, path }
                                          │
                                          ▼
              hosts.experimental_client({ contract }).call(method, input,
                                          { hostId, signal, timeoutMs })
                                          │
                                          ▼
                       workspace host: host entry runs the operation in path
```

- **Tools.** `read`, `write`, `edit`, `glob`, `grep`, `exec`, `stop`, registered with `bb.agents.registerTool`. Paths are relative to the bound workspace path; the host entry refuses anything outside it.
- **Stop.** `ctx.signal` aborts when the call is cancelled, the thread is stopped or deleted, or the plugin is disposed. The abort travels as the `signal` of the host call; the host entry kills the whole process group it started.
- **Timeouts.** A host call defaults to 30 seconds and is capped at 30 minutes. Long `exec` runs as a background job on the host, reported and stopped through `exec`/`stop`.
- **Binding.** The workspace for a thread (host id + path) is plugin state, not the thread's BB environment. Moving work from one machine to another (for example from a desktop to a laptop) is a rebinding; the next tool call goes to the new host.
- **Instructions.** The workspace's `AGENTS.md` / `CLAUDE.md` reach the agent through `bb.agents.contributeInstructions`. That callback is synchronous, so the plugin reads the files at bind time and serves a cached copy. A live provider session keeps the instructions it started with.
- **Tool set.** Tools registered while a session runs appear at the next session start.

### Thread placement

The thread itself runs on the worker host, in an empty scratch environment: the provider's working directory holds nothing of the workspace, so a native tool that slips through finds nothing to act on. Provider accounts, keys and login exist only on the worker host.

## Provider profiles

| Provider | How it gets the tools | Native file/shell tools | Status |
|---|---|---|---|
| Claude | BB tools through the `bb-bridge` MCP server, as today | Off: `--tools ""` or `disallowedTools` in `provider-claude-code`; else an isolated worker | Block 1 |
| OpenCode | BB tools over ACP | Denied by permission | Block 2 |
| Codex | Plugin tools, or Codex's native exec-server/environments via app-server | Off, with a probe for silent local fallback (`openai/codex#41563`) | Block 3 |

## Accounts

Several isolated accounts per worker host, one chosen per thread (block 4). The upstream `account-pool` plugin already routes Claude and Codex API traffic across account pools; block 4 reuses it where it fits and documents what is new.

## Built vs planned

| Part | State |
|---|---|
| Plugin SDK seams: `registerTool` with `threadId` and Stop signal, host entry and host client `call` by `hostId`, `contributeInstructions` | In upstream (used, not built here) |
| `account-pool` plugin | In upstream |
| `plugins/account-workers` (tools, routing, binding, instructions) | Planned, block 1 |
| OpenCode and Codex profiles | Planned, blocks 2–3 |
| Account selection | Planned, block 4 |
| Earlier core implementation (PlacementService, queue, storage, cross-host runtime) | Frozen in `archive/aw/*` tags; see [decisions](decisions.md) |

## Open points for the block 1 probe

1. **Native provider tools off.** `provider-claude-code` has `disallowedTools`; check it can turn off every native file and shell tool for these threads. Otherwise run the worker isolated so native tools see only the scratch directory.
2. **Diff panel.** BB's native diff panel shows the thread's environment, which is the worker's scratch directory. A plugin diff view of the workspace is likely needed.
3. **Stop.** Process-group kill on the workspace host when `signal` aborts, including background jobs.
4. **Instructions.** Cached workspace instructions and when they refresh.
5. **Cloud mode.** Running without the owner's PC needs the BB server off that PC; this is deployment, not plugin code (Later).
