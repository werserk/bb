Run an agent on one machine (the worker, which holds the provider login) while its file and shell tools act on a workspace directory on another machine; the two must be different machines. The workspace machine never receives provider credentials.

## What you get

- Workspace tools for the agent: read, write, edit, glob, grep, exec and diff, run by the BB daemon on the workspace machine. File tools are confined to the bound directory; exec starts in it but is not confined.
- Edits and writes show their change as a diff hunk in the chat.
- Stop ends the running command's process group on the workspace machine.
- The workspace's `AGENTS.md` and `CLAUDE.md` reach the agent as quoted instructions.
- The thread runs in an empty scratch directory on the worker whose settings turn off the provider's native file, shell and other tools, so nothing acts on the worker by mistake. Supported providers: Claude Code (`claude-code`, the default), OpenCode 2 (`acp-opencode`) and Codex (`codex`; the spawn first runs a no-fallback check on the worker).

## For agents and scripts

- `bb account-workers spawn --workspace-machine <machine> --path <dir> --machine <worker> --prompt <text> [--provider <id>] [--model <id>] [--account <id|label>] [--on-limit fallback-auto|stop]` starts a bound thread.
- `--account` pins the thread to one pool account (Account Pooler `thread-account.v1`) before its first message; `--on-limit` says what happens at that account's limit (default `fallback-auto`). Any refusal stops the spawn and archives the new thread; without `--account` the pool picks.
- `bb account-workers list` (with each thread's account and policy when the pool is present), `rebind`, `unbind` manage bindings.
- `bb account-workers exec --thread <id> -- <command>` runs a command through the same path as the agent's exec tool.

`workspace_exec` runs commands as the daemon user on the workspace machine; it is not a sandbox. See `docs/account-workers/architecture.md` for the design and open points.
