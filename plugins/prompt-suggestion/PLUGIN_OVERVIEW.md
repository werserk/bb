# Prompt Suggestion

Prompt Suggestion (formerly Autosay) helps you direct the working agent toward the accepted goal. It offers automatic next-message suggestions and a manual Prompt helper for improving an unsent draft. Both use an explicitly selected model through BB's shared generation service. Automatic suggestions start disabled; no model is selected automatically.

## Prompt helper

Open Prompt helper in an existing thread composer to preview an improved request or, with an empty draft, a grounded next step. Advice appears separately. Replace draft or Insert applies the result as editable text; application never sends it. Dismiss preserves the original draft. Changes to the draft or conversation invalidate the preview. Structured mention identities and attachments are preserved.

The helper works while automatic suggestions are disabled and while the working agent is active. It supports existing threads without history, but not a new-thread composer without a thread ID. Open conversation questions do not block assistance; command approvals and queued messages retain their existing gates. An unsent draft is a proposal, never an accepted decision or permission.

Drafts are limited to 12000 Unicode code points; primary results to 16000 and separate advice to 2000. Oversized input and incomplete output fail without silent truncation or retries. Helper generation uses the provider-default output token limit independently of the automatic suggestion and memory limits.

## Automatic suggestions and task memory

A foreground visit tracks a thread for ten minutes, with at most eight tracked threads. Background preparation is optional. Eligible completed turns can produce a short suggestion outside persisted draft text. Tab accepts editable text; Enter and Send retain the ordinary submission behavior. Typing dismisses the candidate. Navigation detaches the local client while shared background work may continue.

Source-linked task memory separates accepted criteria from proposals, reported progress from evidence, and remaining work from blockers. Context clearing discards earlier memory; bounded history remains explicitly incomplete. Each generation receives the complete owner instructions. Missing instructions fail closed.

All three roles share the configured rolling-hour request budget, preserved across cache clearing and settings reset. Manual help preempts background memory. Memory reserves the final request for foreground work. Failed and cancelled admitted requests still count; there are no automatic retries or fallback models. Diagnostics contain counters and timing, not conversation content. The helper stores no draft or result corpus.

## CLI and details

Use `bb prompt-suggestion helper --thread <id> --draft "Unsent request"` for the same structured preview without editing or sending. Omit `--draft` for a next step. The CLI and RPC also expose suggestion generation, cancellation, tracking, state, explicit memory inspection, models, status and diagnostics.

See [the plugin skill](skills/prompt-suggestion/SKILL.md) for commands, settings and cancellation ownership, and [implementation notes](docs/implementation-notes.md) for detailed scheduling, output contracts and historical verification boundaries. Deterministic verification does not establish live model quality, installed latency or release status.
