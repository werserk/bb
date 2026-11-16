# ACP providers

First-party plugin for ACP (Agent Client Protocol) agent providers: Cursor,
opencode, omp, Grok Build and Hermes Agent.

OpenCode Go usage appears under OpenCode in the Provider usage panel for the
selected machine. It reads the official Go endpoint using the machine's OpenCode
Console account or API credentials and reports the five-hour, weekly, and monthly
windows with their reset times. Sign in to Go in OpenCode on that machine.
The same data is available through `bb settings usage --machine <id> --json`
and `bb.sdk.system.usageLimits({ hostId, providerId: "acp-opencode" })`.
Other OpenCode providers and pay-as-you-go spending are not included.

The plugin has no bridge of its own. Every agent it registers runs on the
published ACP kit, `@get-bb/plugin-sdk/provider-bridge/acp`, which its
`bb.host` entry re-exports (`src/host.ts`). That is the whole
point of the kit: a third-party plugin adds an ACP agent exactly the way this
one does, with no bb-side code. The plugin is forkable
(`docs/forkable-plugins.md`): its lint rule and the fork check prove it takes
no shortcut — no file here may import a workspace package.

What lives here:

- `server.ts` — the plugin's runtime: it reconciles one registration per
  agent, from the shipped list (`src/known-agents.ts`) plus whatever the
  `customAgents` setting declares.
- `src/agents.ts` — the agent definition and the setting's schema, built out
  of the kit's own launch-spec schema so what the setting accepts is exactly
  what the bridge parses. The setting itself is a multi-line JSON field
  (`experimental_multiline`) whose description stays at two sentences; the
  field reference — required and optional fields, the replacement rule for a
  shipped agent's id, the `acp-<id>` provider id — is the "Custom ACP Agents"
  chapter of `docs/configuration.md`.
- `src/configured-agents.ts` — resolving the setting's JSON into agent
  definitions, with a warning for each entry it cannot use.
- `src/registry.ts` and `src/registry-service.ts` — the official ACP registry:
  reading its document, turning an `npx` or `uvx` agent into a `customAgents`
  entry, and the `listRegistry` / `addRegistryAgent` / `removeAgent` RPC and
  `bb acp` CLI commands that the settings section (`app.tsx`) and the CLI share.
- `src/declaration.ts` — one agent definition becomes one
  `bb.providers.register` declaration: ids, display names, icons,
  capabilities, and the bridge options it launches with (`acpLaunchSpec`, and
  `acpDialect` for the agents whose vendor side channels the kit reads).
- `src/host.ts` — the `bb.host` artifact: the re-exported ACP bridge,
  capability probes, native-root discovery, and direct OpenRouter text generation.
- `src/ai/` — the shared text-service registration, host RPC contract and
  stateless OpenRouter transport using host-local OpenCode credentials.
- `icons/` — the provider logos, declared in `package.json` under
  `bb.branding.experimental_icons` so the packaged build ships them.

The kit itself, including the ACP wire schema, the delta translation, the
per-agent dialects and the bridge process, is `packages/provider-bridge-acp`.

## Direct OpenRouter text generation

The shared text service `opencode-openrouter` appears as **OpenCode credential ·
OpenRouter direct**. It uses OpenCode only for credential ownership: the host runs
`opencode auth export openrouter`, accepting exactly one active OpenRouter key.
Keys stay on the host, are reread for each generation, and are never persisted by
this plugin. Credential export errors and provider response bodies are not logged
or forwarded. This service does not start an ACP session or use an agent loop.

Models come from OpenRouter's exact `/api/v1/models` catalog, cached in host memory
for one minute and invalidated on unsuccessful completion responses. Capabilities
come from catalog metadata, including explicit supported reasoning efforts;
`none` is available only when advertised and reasoning is not mandatory.

The server selects latency routing. The host sends one non-streaming Chat
Completions request with role-separated messages, `max_tokens` when specified,
and `provider: {sort: "latency", allow_fallbacks: false, require_parameters: true}`.
No retries, fallback models, tools or session affinity are supported. Fast service
tiers are unsupported. Actual model, finish reason and usage come from the
response; unknown usage and actual tier remain null. Requests have bounded
credential export, catalog and response reads and share cancellation/deadlines.

Use `bb ai-gateway models` or `bb prompt-suggestion models` to discover the
qualified service/host/profile/model IDs. Select that exact ID in either plugin's
settings, or invoke `bb ai-gateway generate --model <exact-id> --prompt-stdin`.
Both plugins consume `bb.experimental_aiServices` through the shared dispatcher;
there is no separate Prompt Suggestion transport. Existing ACP agents are unchanged.

## Repository verification

Inside the bb monorepo, run `pnpm exec turbo run test:workspace
--filter=bb-plugin-provider-acp`. The repository-owned
`vitest.provider-acp.config.ts` uses shared workers for pure Node tests and
isolated workers for DOM tests and global mocks. Turbo prepares the SDK and
native modules before running it. The plugin's default `test` command and
`vitest.config.ts` remain self-contained for standalone forks; `test:workspace`
is only available inside the bb repository.
