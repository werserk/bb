# Autosay

Autosay suggests one next user message after an eligible completed turn, regardless of whether the working agent is Claude, Codex or another provider. A separately configured text generator receives bounded current-thread context. Tab or Use suggestion accepts into an editable draft; sending remains a separate action.

The plugin owns context selection, no-tools HTTP inference, settings, cancellation and session-only diagnostics. BB owns transient suggestion snapshots and atomic acceptance; the shipped Composer renders them without inserting ghost text into its editor document. Nothing is retained as a training corpus. Default is disabled.

See `skills/autosay/SKILL.md` for settings, commands and operational limits. Tests use local HTTP fixtures and the official plugin harness. A configured real generator and live BB interaction evidence are required before claiming a completed live pilot.
