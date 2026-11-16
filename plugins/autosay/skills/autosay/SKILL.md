---
name: autosay
description: Configure or inspect Autosay next-message suggestions without sending messages.
---

Autosay predicts an editable next user message for any working-agent provider. It requires the experimental composer suggestion capability and the shipped Composer renderer. It starts disabled and uses no working-agent tools.

Use `bb autosay status` for readiness and `bb autosay diagnostics` for in-memory session counters/last latency. Use native plugin settings to set Enable Autosay, Generator API base URL (including /v1 where needed), Generator model, API key, instructions, context/output/time/request bounds and allowed project IDs (comma separated; empty means all). The configured generator receives bounded conversation text; its credentials/billing are separate from the working agent. No automatic model/endpoint selection or fallback occurs. Only HTTPS and explicit local loopback HTTP are allowed.

`bb autosay suggest --thread <id>` performs an explicit guarded generation and returns JSON; it never inserts or sends. To make this invocation cancellable from another process, provide `--request <UUID> --token <UUID>` and use `bb autosay cancel --request <UUID> --token <UUID>`. Do not put API keys in these options. The request token is a transient cancellation capability, not the generator credential. Invalid UUID options are rejected.

Automatic calls require an eligible focused visible thread composer, empty draft and successful completed root turn with no queue, question/approval, uploads or voice operation. Manual CLI calls need no visible composer but retain server eligibility and bounds. Tab accepts the candidate into an ordinary draft, Escape/typing dismisses, Enter sends only actual draft text. Use suggestion is the touch equivalent. Unsupported custom composers remain off.

Runtime generator instructions live only in `src/instructions.ts`, with a user override in settings. This skill does not duplicate or execute the predictor. Errors produce no suggestion; inspect diagnostics instead of retrying blindly. Requests and counters are scoped to the running plugin session, not a durable dollar budget. Timeout aborts local waiting but cannot guarantee the remote service stops billing.

Autosay stores no additional transcript/suggestion corpus and logs no model content. Ordinary accepted BB drafts and sent history retain their normal behavior. Dataset export, native Claude backends and automatic sending are outside this version.
