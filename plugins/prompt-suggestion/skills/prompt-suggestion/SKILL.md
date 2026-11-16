---
name: prompt-suggestion
description: Configure or inspect next-message suggestions using connected BB generation models.
---

Prompt Suggestion (formerly Autosay) predicts an editable next user message after an eligible completed turn. It uses BB's shared experimental AI-generation service, independently of the working agent's provider. It starts disabled; choose a model in the plugin's Suggestion model picker, then enable it. Existing provider authentication stays in the provider adapter; this plugin has no API URL or key setting.

Use `bb prompt-suggestion models` for supported model IDs and their connection identity, `bb prompt-suggestion status` for configured selection and enabled state, and `bb prompt-suggestion diagnostics` for session-only counters and last latency. Configured means a model ID is saved; an unavailable saved model fails without switching to another model. Refresh the picker after connecting a provider or changing the primary machine.

Native settings control instructions, context character limit, timeout, output token limit, hourly request limit and allowed project IDs. The configured provider receives recent conversation text bounded by the context limit. Output token limit 0 uses the provider default; a positive value requires advertised provider support and otherwise fails before dispatch. No retries or fallback models are selected by Prompt Suggestion. Remote usage/cost follows the selected provider; timeout ends local waiting but cannot guarantee remote billing stops.

`bb prompt-suggestion suggest --thread <id>` generates once for an idle eligible thread and prints JSON; it does not insert or send. Optional `--request <UUID> --token <UUID>` creates a cancellable request; cancel using `bb prompt-suggestion cancel --request <UUID> --token <UUID>`. These are transient cancellation identifiers, not provider secrets.

Automatic calls require a focused visible empty composer, successful completed root turn, no queued message or open question/approval, and no upload/voice operation. Draft/context/settings changes cancel or invalidate pending results. The candidate replaces the placeholder: Tab accepts editable text; plain Enter or native Send accepts and submits once through the usual host path. Typing/Escape dismisses it. Unsupported custom composers remain off.

Instructions live in src/instructions.ts, with a native setting override. No transcript/suggestion corpus or model content log is added. Existing BB drafts and sent history keep their ordinary retention. Dataset export and background sending are outside this plugin.

When upgrading Autosay, inspect its non-secret settings, disable the old plugin before enabling Prompt Suggestion, and choose a native model explicitly. Direct API configuration does not map automatically to a BB connection. Do not silently migrate credentials or leave both composer controllers active.
