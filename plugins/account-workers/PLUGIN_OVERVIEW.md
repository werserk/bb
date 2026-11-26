Run an agent on one machine (the worker, which holds the provider login) while its file and shell tools act on a workspace directory on another machine. The workspace machine never receives provider credentials.

## What you get

- Workspace tools for the agent: read, write, edit, glob, grep, exec and diff, executed by the BB daemon on the workspace machine inside the bound directory.
- Stop ends the running command's process group on the workspace machine.
- The workspace's `AGENTS.md` and `CLAUDE.md` reach the agent as quoted instructions.
- For Claude, the thread runs in an empty scratch directory on the worker whose settings turn off native file, shell and other tools, so nothing acts on the worker by mistake.

## For agents and scripts

- `bb account-workers spawn --workspace-machine <machine> --path <dir> --machine <worker> --prompt <text>` starts a bound thread.
- `bb account-workers list`, `rebind`, `unbind` manage bindings.
- `bb account-workers exec --thread <id> -- <command>` runs a command through the same path as the agent's exec tool.

`workspace_exec` runs commands as the daemon user on the workspace machine; it is not a sandbox. See `docs/account-workers/architecture.md` for the design and open points.
