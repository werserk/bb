# Block 1 probe report

Answers to the probe questions of [#1](https://github.com/werserk/bb/issues/1), checked on two machines: a worker host that runs the BB server and holds the Claude login, and a workspace host with only the BB daemon. The plugin ran on a BB release with plugin SDK 0.6.132; the branch's tests also pass against the workspace SDK. The agent under test was Claude Haiku 5.5 (three runs). Raw evidence (commands, outputs, hashes) stays with the builder because it names machines; this page carries the results.

## Probe questions

| # | Question | Answer | How it was checked |
|---|---|---|---|
| 1 | Native Claude tools off without changing `provider-claude-code`? | Yes. The thread's scratch directory holds `.claude/settings.local.json` with a `permissions.deny` list and a `PreToolUse` allowlist hook ([architecture](architecture.md#thread-placement-and-native-tools-claude)). | Live run: `Bash` → "No such tool available"; `Task`/`Agent` not offered; `update_environment_directory`, another plugin's shell tool and other BB tools → blocked by the hook with its reason. Guard exit codes unit-tested, including bad input and missing node. |
| 2 | Does BB's diff panel show the workspace? | No: it shows the worker's scratch directory. `workspace_diff` shows `git status` and `git diff HEAD` of the workspace in chat; a panel view is open point G4. | Design; not built. |
| 3 | Does Stop end the remote process group? | Yes, within 3 s, including a backgrounded child. Processes that call `setsid` escape (G3). | Live run: `bb thread stop` during `sleep 300`; `ps` on the workspace host 3 s later shows no process. Same through the debug CLI with `sleep 300 & sleep 301`. Unit test: a group that ignores `SIGTERM` and a grandchild holding stdout settle in under 5 s. |
| 4 | Instructions from a synchronous callback? | `bb.agents.configure` (synchronous) serves the workspace `AGENTS.md`/`CLAUDE.md` read at bind time, capped at 12 000 chars each. | Live run: the agent ended with the marker line that only the workspace's `AGENTS.md` asks for; the same-path decoy file on the worker asks for a different marker, which did not appear. |
| 5 | Host calls cap at 30 minutes: background jobs? | Not needed for block 1. `exec` defaults to 120 s and is capped at 600 s; there is no `stop` tool, Stop is the call's abort signal. | Unit tests for timeout and cancel; live Stop above. |

## Acceptance

| Item | Result |
|---|---|
| Claude thread on the worker reads, edits and runs a command in a repo on the workspace host | Pass. The agent fixed a failing test with `workspace_edit` and ran the tests with `workspace_exec`; tool output names the workspace host. The file's sha256 changed on the workspace host. |
| A file at the same absolute path on the worker is untouched | Pass. sha256 of the decoy identical before and after. |
| No provider keys, login or agent init on the workspace host | Pass. `test -e` on the usual Claude paths: all absent; no `claude` CLI; no `ANTHROPIC_*`/`CLAUDE_*` variable names in the daemon, its host workers or the exec environment (checked by name only). See G1 for what the BB API still allows. |
| Native file/shell tools unavailable | Pass (question 1). |
| The agent cannot reach worker files through the plugin tools | Pass. `workspace_read` of a file that exists only on the worker → refused, outside the workspace root; `workspace_exec cat` of it → "No such file or directory" on the workspace host. |
| Stop ends the remote process group | Pass (question 3). |
| Connection loss mid-command fails the call and finishes the turn | Pass. The workspace daemon was paused (`SIGSTOP`) for 50 s, then resumed. After about 30 s (the server's lease timeout) the call failed with "Host is not connected. Outcome unknown … may still be running …"; the agent reported it and the turn finished. The remote command kept running until it ended by itself, as documented. A pause shorter than the lease timeout is not a drop: the call completed normally after the resume. |
| Rebinding changes where the next tool call runs | Pass, without a model: `bb account-workers rebind` to another host, then `bb account-workers exec` (the same server path as `workspace_exec`) reported the other host's name; rebinding back restored it. |
| Gaps needing a core change are separate issues | G1 needs a product decision before any foreign workspace; it is documented, not filed as a core change in this block. |

## Findings on the way

- BB refuses to start a thread in a directory inside its managed data directory, so the scratch directory lives under the user's XDG state directory.
- Host RPC input must be JSON: an optional field sent as `undefined` is rejected, so the server omits unset fields.
- A personal-workspace project accepts only personal workspaces; bound threads go to a standard project.
- What still runs on the worker without a tool call is listed under G2 in [architecture](architecture.md#open-points).
