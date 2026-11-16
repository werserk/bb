# Prompt Suggestion

Prompt Suggestion (formerly Autosay) predicts one next user message after an eligible completed turn, independently of the working agent's provider. It invokes an explicitly selected model through BB's shared AI-generation service; provider adapters retain their own authentication. The suggestion replaces the empty editor placeholder. Tab accepts editable text; plain Enter or native Send submits through the ordinary composer path.

The plugin owns context selection, instructions, settings, cancellation and session-only diagnostics. Core owns generation admission and transient composer snapshots. No new training corpus or transcript log is retained. Default is disabled and no model is selected automatically.

See skills/prompt-suggestion/SKILL.md for settings, commands and migration. Tests use the official plugin harness with an isolated registered generation service. Packaged provider and real composer checks are required before claiming a live pilot.
