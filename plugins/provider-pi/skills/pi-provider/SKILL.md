---
name: pi-provider
description: "Inspect BB Pi provider support for message editing and context compaction."
---

# Pi provider

Pi supports editing and rerunning eligible user messages and compacting idle or
errored threads through the core `bb thread edit-message` and `bb thread compact`
commands. Inspect the thread first and use live command help for arguments.
Provider confirmation determines whether the operation completed.

Use the target host's provider catalog for available models and execution options.

## Native text generation

The shared AI service uses authenticated Pi ModelRuntime, independently of agent turns.
In plugin settings, `nativeGenerationRouting` accepts `default` (initial value) or
`lowest-latency`. The same setting is available through the SDK plugin settings API
and `bb plugin config provider-pi set nativeGenerationRouting lowest-latency`.
On compatible OpenRouter completions routes, lowest latency sends provider routing
`sort: latency`, `require_parameters: true`, `allow_fallbacks: false`. Other providers
retain native behavior. This setting never changes agent-turn routing.

Use only advertised reasoning efforts. Explicit `none` is advertised only when
Pi can serialize reasoning off; unsupported efforts fail before generation.
Null retains Pi's existing default behavior, which can emit `reasoning.effort: none`
on OpenRouter. Temperature and service tier remain unsupported. Session affinity
is supported only on compatible OpenRouter routes and is an opaque hint, not a
credential or a guarantee of a cache hit.

`bb pi-generation status` and the `nativeGenerationStatus` plugin RPC report requested routing and the last successful host-applied mode. `inapplicable` means the selected route is not a compatible OpenRouter route; null means no completed generation was observed in this plugin process. No content or credentials are included.
