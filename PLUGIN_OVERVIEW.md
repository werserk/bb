Keep a Claude Code or Codex thread running when one account hits its limit. The Account Pooler puts every account you own behind a local hub and picks the account for each request.

## What you get

- A pool of Claude and Codex accounts, added by importing the login already on the machine, signing in through the browser, or pasting an Anthropic or OpenAI API key.
- Accounts run one after another in priority order, with ties following the order added. New conversations stay on the current fallback even when an earlier account recovers. Existing conversations keep their own account until it becomes unavailable.
- Drag handles set the account order within each provider in settings (keyboard: Space to pick up, arrow keys to move, Space to drop, Escape to cancel), with the same operation available through `bb pool account reorder <claude|codex> <id>...`.
- Live limit windows per account and model family in the plugin's settings page, and the same numbers from `bb pool status`.
- A routing switch per provider and a bypass per thread, so one thread can go straight to its own credentials.

## How it works

The hub serves Anthropic Messages and OpenAI Responses endpoints. Routed providers report **Proxied** and receive a machine-scoped hub token. Accounts in error are skipped. The switch threshold defaults to 98 percent. Claude extra usage and Codex credits are fallbacks: usable subscription accounts take precedence, and conversations return when quota recovers. Exhausted accounts are rechecked before fallback. Codex spending-control and explicit credit-depletion restrictions block routing even below the threshold. The pool does not enable extra usage, purchase credits, or change spending limits. Settings shows “Extra usage available” only for reported allowance, never current billing activity. CLI and RPC status expose the same observations. Secrets stay on the server and tokens refresh in the background.

The pool waits once on the same account for short temporary rate limits. Longer holds return Retry-After for pinned conversations while new conversations can advance. A model-family limit detours requests for that family without moving the session’s main pin or the provider cursor. The pool commits a new account after a successful response; a failed attempt across every account retains the previous binding. The current account and session pins survive hub restarts. Session pins expire after 65 idle minutes, with the 4,096 most recently used pins retained.

The pool uses HTTP/1.1 and honors standard proxy environment variables. Connection failures log error codes without credentials or request contents.

## Per-project account order

Every project keeps access to every account; a project can only change the order its new sessions try them in. `bb pool project-priority set <project-id> <account-id>...` lists the accounts to try first, in order; the rest follow by global priority. A session that already has an account pin keeps it, and a session whose pin expired after 65 idle minutes, or whose pinned account became unavailable, picks the first usable account in its project's order. A listed account that is exhausted, in error, disabled or removed is skipped, so fallback reaches any account. Requests with no project, or from a project with no order, behave as before. Project-ordered choices do not move the global active-account cursor.

The plugin tells the hub which project a request belongs to by adding an `x-bb-project` header through `ANTHROPIC_CUSTOM_HEADERS` in the Claude Code environment; the header is never forwarded upstream. It applies to threads whose environment is resolved after the plugin update. Manage orders with `bb pool project-priority list|set|clear`.

## Nested bb servers

A bb server started inside another bb server's thread detects the parent's pooler and enables this plugin. Choose in settings or with `bb pool parent`:

- **proxy** (default): keep a local hub with its own machine tokens and forward pooled traffic to the parent, so the parent's token never reaches this server's agents. Routing is contributed only for providers the parent can serve.
- **isolate**: neutralise the inherited routing and use this instance's own accounts, or each provider's own credentials.

Proxied traffic authenticates as the parent machine's token, so the parent attributes it to itself.

## Requirements

Accounts you own and are permitted to use this way.

Experimental: routing, storage, and CLI may change.

## For agents

`bb pool account add|list|remove|enable|disable|priority|reorder`, `bb pool status`, `bb pool routing <claude|codex> [--off]`, `bb pool config`, `bb pool config set`, `bb pool parent [proxy|isolate]`, `bb pool token rotate`, `bb pool bypass <thread-id>`, and `bb pool project-priority list|set|clear`. Every command takes `--json` and `--help`; `bb pool --help` lists the commands and `bb pool <command> --help` prints its arguments, options, and rules.

## Targeted Claude ping

`bb pool ping <account-uuid> [--diagnostic] [--json]` sends one tiny Haiku request through
exactly one local Claude account. It consumes quota, refuses unavailable
accounts and parent proxy mode, never fails over, and preserves routing
cursor and session affinity. CLI and `account.ping` RPC return status, account id and model, plus bounded,
credential-redacted upstream error type/message when available on HTTP failure. See the account-pool skill reference for limitations.

An OAuth ping HTTP 401 invokes token-scoped credential refresh once within the same deadline, so stale or rate-limited usage collection cannot hide a rejected token. The result still reports the original HTTP 401; inference is not retried. A subsequent explicit ping uses the recovered token. Definitive refresh rejection marks an account error only for the rejected token; transient refresh failures retain backoff.

## Automatic retries

Provider Retry uses pool recovery times. Inspect `bb provider-retry status` or `bb provider-retry explain <thread-id>`.

## Local fork verification

Lab/test entrypoints and the pool rollback isolation boundary are mapped in
[delivery/LAB-SAFETY.md](../../delivery/LAB-SAFETY.md).

## Claude access observations

Claude inference HTTP 403 responses persist `accessBlocked` independently of enabled state and quota: status, bounded credential-redacted structured error type/message, and observation time. Malformed or non-JSON failures store only status/time. HTTP 429 remains quota/temporary hold behavior; Codex behavior is unchanged. A blocked Claude account is skipped by ordinary selection and retry availability until successful inference or diagnostic ping clears the observation. Enable and usage refresh preserve it.

Settings retains blocked accounts, showing Access blocked (403), reason, observation time and Diagnostic retry. `bb pool ping <id> --diagnostic` and `account.ping` input `{ id, diagnostic: true }` bypass local enabled/quota/hold/access gates for one minimal Haiku request. They preserve enabled state, cursor and affinity, never fail over or retry inference, and retain credential, parent proxy and stopped-hub safeguards.

The compact panel uses `src/usage-source.ts` discoverable `provider-usage.v1.listResources` and `getResource` RPCs. Only enabled accounts appear in the resource inventory; disabled accounts disappear and stale fetches fail. Enabled accounts remain visible regardless of operational health or exhausted quota. Access blocks are reported as usage errors. The native provider-usage consumer relists resources on its next normal refresh (mount, focus or the two-minute refresh) and removes cached measurements for disappeared IDs, so rows, counts and indicators use the filtered inventory. Plugin account-change realtime events refresh settings; compact inventory updates follow the consumer's refresh cadence.

The stored observation lives in the separate `account_access_block` table, created by an additive migration that leaves legacy `account_quota` columns unchanged for rollback. Quota writes, quota headers and usage refresh preserve it; only hub inference observation writes or clears it. The new nullable field defaults to null at RPC boundaries so older status caches remain readable.

## Claude identity verification

A Claude HTTP 400 is an access failure only when its structured error is exactly `invalid_request_error` with message `Identity verification is required to continue.`. The same predicate classifies ordinary inference and diagnostic ping. It persists the actual status 400, type, message and timestamp, exposes status `verification-required` and settings label Requires verification (400), and follows the same routing and successful-diagnostic recovery rules as HTTP 403. Compact visibility depends only on enabled. Generic HTTP 400, including either mismatched field, is unchanged. Ordinary inference inspects a clone within the existing 1 KiB/250 ms error-detail budget; generic error bodies, headers and streams remain available to the client intact.

For a full rollback, use the original pre-feature runtime backup recorded in the deployment receipt. That version ignores the separate `account_access_block` table, so no observation cleanup or reverse migration is needed. The intermediate 403-only version rejects persisted 400 observations and is not a safe rollback target once verification failures have been recorded.

## Account enablement and operational state

The persisted enabled boolean controls participation in routing and visibility in the compact panel, for both Claude and Codex. Disabling never replaces operational status: ready, exhausted, held, error, verification-required and access-blocked remain independent. Settings retains all accounts and shows a separate Disabled badge. CLI and RPC expose enabled alongside status, and account enable/disable commands change only the participation flag. Routing still applies all existing health gates to enabled accounts. No error automatically changes owner enablement.

## Claude usage authentication recovery

`src/claude-adapter.ts` retries a rejected OAuth usage GET once after requesting token-scoped recovery through `AdapterUsageContext.freshSecret` in `src/provider-adapter.ts`. `src/hub.ts` owns the existing credential singleflight, refresh backoff and rejection guard. A definitive refresh rejection or a second usage HTTP 401 becomes an account credential error, applied only if the rejected token is still current; a late response cannot poison replacement credentials. Transient refresh failures retain backoff without a permanent error. Usage HTTP 403/429 and other collection failures retain cached telemetry; command acceptance does not prove a new observation. Inference is never retried by this recovery path. Account enablement, routing cursor and affinity are preserved.

## Anthropic-compatible clients

Authenticated `GET /models` forwards the selected Claude account's catalog to
Anthropic `/v1/models`, preserving pagination queries and errors. `/v1/models`
remains the Codex catalog. A catalog entry is not proof of current inference quota.

Use the hub root as Hermes's base URL, `anthropic_messages` transport and the
machine hub token. Do not append `/v1`: that selects the Codex model catalog.
The adapter supplies `anthropic-version: 2023-06-01` only when absent.
It does not synthesize Claude Code identity, prompts or subscription entitlement.
Full Hermes requests can be rejected by Anthropic's third-party extra-usage
requirement even when Claude Code works on the same account. Integration status
and operations are kept in the owner's setup notes (`HERMES-BB-POOL.md`),
outside this repository.

## OpenAI Platform API keys

In the Codex section choose Add account → Add API key. Keys use OpenAI Platform
billing and the same account priority, cursor and affinity policy as other accounts.
The key's project must have access to the requested model. API key accounts expose
no subscription windows or inferred dollar balance.

The Codex adapter chooses https://api.openai.com/v1 for API keys and the configured
ChatGPT upstream for OAuth on each request attempt. It preserves request bodies,
queries and streamed response bytes, and strips ChatGPT identity/internal headers
from API-key requests. Responses, compact, images and model listing use the same
credential-aware routing. Catalog payloads remain upstream-native; the pool does
not claim that a Platform model listing is a ChatGPT Codex catalog.

An explicit insufficient_quota error persists an account error and triggers
failover. After restoring project allowance, enable the account to retry. A 401
invalidates the key; a 403 can represent model/project access and does not persist
an account-wide credential error. Temporary 429 follows the existing hold policy.

## Machine routing

Settings → Advanced → Machine routing lists enrolled machines, including those
without a minted token, plus retained exclusions for removed machines. Exclude
applies to central Claude and Codex pooling together. The machine must use its
own provider credentials; the setting is not observed native readiness.

`bb pool machine list --json`, `bb pool machine exclude <host-id> --json` and
`bb pool machine include <host-id> --json` share `hostExclusion.list` and
`hostExclusion.set` RPC policy. IDs are exact; names are display labels.
New environment contributions clear Pooler routes and parent markers. Existing
process environments are unchanged; new machine-token authentication is denied,
including grace tokens, while already authenticated requests may finish.
Explicit Include restores normal policy without verifying native credentials.
See [the architecture map](docs/ARCHITECTURE.md) for persistence and rollback limits.
