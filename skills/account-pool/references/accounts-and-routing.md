The builtin Account Pooler plugin is disabled by default. Enable it, add Claude
or Codex credentials, and inspect its proxy routes and account quota with:

```sh
bb plugin enable account-pool
bb pool account add --provider claude --login
printf '%s\n' "$CLAUDE_AUTH_CODE" | bb pool account login-complete --session <id> --code-stdin
bb pool account add --provider codex --login
bb pool account login-poll --session <id>
printf '%s\n' "$ANTHROPIC_API_KEY" | bb pool account add --provider claude --api-key-stdin [--label <text>] [--priority <n>]
bb pool account add --provider claude --api-key <key> [--label <text>] [--priority <n>]
bb pool account list [--json]
bb pool account remove <id>
bb pool account enable <id>
bb pool account disable <id>
bb pool account priority <id> <n>
bb pool account reorder <claude|codex> <id>...
bb pool account refresh <id>
bb pool status [--json]
bb pool routing <claude|codex> [--off]
bb pool config
bb pool config set <switchThreshold|parentMode> <value>
bb pool parent [proxy|isolate]
bb pool token rotate --machine <id-or-name>
bb pool bypass <thread-id> [--off]
```

Every command accepts `--json` and `--help`. `bb pool --help` lists the
commands; `bb pool <command> --help` prints that command's arguments, options,
and rules, including which flags cannot be combined. Unknown commands, unknown
flags, and stray arguments are rejected with the nearest suggestion rather than
ignored, and a failing invocation that carries `--json` also prints
`{"ok":false,"error":{"code","message","hint"}}` on stdout.

Claude `--login` starts a PKCE session, prints a browser URL and session ID,
then exits. Pipe the manual callback code to `account login-complete` with that
session ID within ten minutes. Codex `--login` prints a device verification
URL, one-time code, session ID, and an `account login-poll` command that waits
for authorization. The Claude code stays out of process arguments, and either
browser may be on a different machine from the bb server. The plugin settings
page offers the same flows as **Sign in to Claude** and **Sign in to Codex**.
Newly added or enabled accounts are available without a plugin reload. With an
enabled account whose secret file remains readable and valid, matching Claude
Code or Codex sessions receive the pool route and a distinct secret token for
their machine. Claude Code also receives `ENABLE_TOOL_SEARCH=true`, so tool
search stays on through the pool, and
`_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1`, so Opus keeps its 1M context
window instead of the 200k fallback for custom base URLs.
Codex receives `CODEX_OPENAI_BASE_URL` and the secret
`CODEX_POOL_AUTH_TOKEN`; bb applies them as in-memory app-server config.
Codex image generation and editing use the same authenticated pool route.
Tokens are never printed. `status` prunes tokens for unenrolled machines and
shows token timestamps plus recently routed threads whose machines need a
local Claude login before the pool can be disabled safely. Rotation keeps the
prior token valid for ten minutes. Agents should pipe API keys to
`--api-key-stdin`;
`--api-key <key>` is an unsafe compatibility form that exposes the key in
process arguments, shell history, and agent transcripts. OAuth accounts are
added only with `--login`, so the hub is each account's only refresh owner.
The pool never imports a CLI's existing login (`~/.claude`, `~/.codex`, a
keychain): the CLI would keep refreshing the same refresh token, and rotation
would force re-logins. OAuth quota refreshes on add or
enable and every five minutes while an account is idle. When a request finds no
eligible account, the pool first refreshes the OAuth accounts it considers
exhausted, at most once every 30 seconds per account, so a plan upgrade or an
early reset takes effect on the next turn. Use
`bb pool account refresh <id>` to request an immediate refresh for one account.
For an OAuth account in error, `refresh` also forces a new token with the stored
refresh token and clears the error when that succeeds, so a spurious error does
not require logging in again.
An account enters error when its OAuth refresh token is rejected (HTTP 400 or
401 from the token endpoint) or its API key is rejected with HTTP 401 (also
HTTP 403 for Codex). HTTP 401 on a freshly refreshed OAuth token, and Codex
HTTP 403, produce HTTP 503 and a one-minute token hold. Claude inference HTTP
403 instead persists a separate access-block observation without an OAuth
retry; it is cleared only by successful inference or diagnostic ping.
Account tables add columns for observed model-family buckets; JSON status
exposes their utilization, reset, status, observation time, and source under
`familyWeekly`. Selection skips an account whose requested family is spent
while retaining it for other families. A present `metadata.user_id` account
UUID is aligned with the selected OAuth account. Use `bb pool config` to
inspect the full routing configuration and
`bb pool config set <key> <value>` to update one value; `switchThreshold` must
be greater than 0 and at most 1. Provider upstreams (api.anthropic.com,
chatgpt.com/backend-api/codex, api.openai.com) are fixed in code and cannot be
configured.

Accounts run sequentially per provider: lower priority numbers first, with ties
following the order accounts were added. New conversations use the current
account until it reaches the switch threshold or fails; the pool then advances
to the next eligible account and wraps at the end. It keeps using that fallback
even when an earlier account recovers. Existing conversations stay pinned while
their account remains eligible. Short temporary rate limits wait on the same
account once; longer holds return Retry-After for pinned conversations while new
conversations can advance. A model-family limit detours only requests for that
family without moving the session's main pin or the provider cursor. The cursor
and session pins survive hub restarts. Session pins expire after 65 idle minutes,
and the pool retains the 4,096 most recently used pins.

Claude accounts with an exhausted subscription window remain eligible as a
fallback when Anthropic reports extra usage enabled with remaining allowance,
or an allowed overage response header. Accounts below the switch threshold
are preferred, including for conversations pinned to an extra-usage fallback;
those conversations return to subscription quota when it recovers. Before using
extra usage, the pool rechecks exhausted OAuth accounts (at most every 30 seconds).
Disabled, spent, or unobserved extra usage does not override subscription limits.
This does not enable extra usage or change spending limits on Claude.
`account list` and `status` show an Extra usage column; JSON and the corresponding
plugin RPCs expose `extraUsage` with status, observation time, and source.
This state survives hub restarts. Model entitlement differences between plans
are not inferred from missing quota buckets.

Codex credits use the same fallback policy and availability pill. The pool reads
`credits.has_credits` and `credits.unlimited` from usage responses and the
corresponding `x-codex-credits-*` headers. Credit-only updates are accepted;
omitted fields preserve prior observations. Workspace hard stops (the
`workspace_{owner,member}_{credits_depleted,usage_limit_reached}` limit types,
or a reached spend control) block routing even below the subscription switch
threshold and survive restarts. Other limit types, including unknown ones, do
not restrict the account. A refreshed allowance or spending-control observation can
clear the matching restriction. JSON account/status responses expose
`usageRestriction` (reason and optional reset time); the pool does not change
workspace spending controls or purchase credits. Availability is not current
billing activity.

Drag an account’s handle in Account Pooler settings (or focus the handle and use
Space, arrow keys, and Space again), or
`bb pool account reorder <claude|codex> <id>...`, to set the complete order for
one provider. Include disabled accounts too. Reordering changes the next failover
sequence without moving the current account. `bb pool account priority <id> <n>`
sets an individual priority; the same operations are available through the
`account.reorder` and `account.setPriority` plugin RPCs.

## Nested bb servers

A bb server started from inside another bb server's thread inherits that parent's
pooler routing through its environment. The parent contributes
`BB_ACCOUNT_POOL_PARENT_URL` and `BB_ACCOUNT_POOL_PARENT_TOKEN` alongside the
provider routing variables, and the nested server enables the pooler on first run
when it sees them.

`bb pool parent` reports the detected parent, the current mode, and which
providers the parent can serve. `bb pool parent proxy` and `bb pool parent
isolate` set the mode; `bb pool config` shows it as `parentMode`.

In `proxy` mode the nested server runs its own hub and mints its own machine
tokens, forwarding pooled traffic upstream with the parent's token, so the
parent's token is never handed to the nested server's agents. It reads the
parent's `/availability` endpoint and contributes routing only for providers the
parent can actually serve; if the parent is unreachable it contributes nothing
and neutralises the inherited values rather than pointing agents at a dead hub.

In `isolate` mode the nested server contributes empty routing variables, which
overrides the inherited values so threads fall back to that instance's own
accounts or to each provider's own credentials.

Proxied traffic authenticates as the parent machine's token, so `bb pool status`
on the parent attributes it to the parent host rather than to the nested
instance.

## Automatic retries

Provider Retry discovers Account Pooler’s `provider-retry.v1.availability` RPC. It accepts `{ threadId, requestId }` and reports `not-routed`, `ready`, `blocked` with `retryAt` in epoch milliseconds, or `unavailable` with a reason. Pool routing must have been recorded when the provider environment was prepared. The request must still be the thread’s latest request; its recorded model determines which quota windows apply. The pool uses the same recovery calculation for its HTTP 429 response and this RPC. Parent pools expose the authenticated `/retry-availability?provider=claude|codex&family=<family>` endpoint.

The retry plugin remains responsible for queueing, maximum waits, and attempt limits. Inspect a skipped decision with `bb provider-retry explain <thread-id>` and pending work with `bb provider-retry status <thread-id>`.

## Targeted Claude ping

`bb pool ping <account-uuid> [--diagnostic] [--json]` sends one fixed, non-streaming
`claude-haiku-4-5-20251001` Messages request (`Hi`, `max_tokens: 1`) through exactly that
local Claude account. It consumes quota. The matching plugin RPC is
`account.ping`, input `{ "id": "<account-uuid>" }`; output is
`{ accountId, model, status, ok }` plus optional `error` below. CLI exits nonzero when unavailable or HTTP
fails; successful response content and credentials are never returned. On HTTP failure,
JSON may include `error: { type, message }` from a structured upstream error,
bounded and credential-redacted. Non-JSON, malformed, truncated or slow error
bodies omit `error`. No raw body or headers are returned.

Normal ping rejects access-blocked accounts, parent proxy mode, stopped hubs, unknown/disabled/non-Claude
accounts, credential errors, usage restrictions, unexpired holds, and exhausted
shared or Haiku quota. Extra usage does not make a ping eligible. It refreshes
only target usage/credentials, observes target quota/temporary holds. Claude HTTP 403 persists a separate accessBlocked observation; HTTP 429 never creates one. It never fails over, retries inference,
creates session affinity or changes the ordinary routing cursor. Each ping has
a 30-second deadline. A successful HTTP request alone does not prove a
subscription reset moved; inspect fresh provider usage separately.

For OAuth ping HTTP 401, the hub refreshes the specifically rejected token once
within the same deadline, even if usage collection is rate-limited. The ping
still reports its original HTTP 401 and never repeats inference. A later explicit
ping uses the recovered token. A definitive refresh rejection records a credential
error only if the rejected token is still current; transient failures retain
backoff without a permanent error. API-key HTTP 401 and Claude HTTP 403 do not
invoke this recovery.

Claude usage HTTP 401 likewise invokes token-scoped refresh and retries only
the usage GET once. Definitive refresh rejection or a second usage HTTP 401 is
reported in account.error. Usage HTTP 403/429 retains cached observations;
refresh command acceptance alone is not proof of fresh telemetry.

## Per-project account order

`bb pool project-priority list|set|clear` (also `projectPriority.*` RPC) manages an
ordered list of Claude account ids per bb project (`proj_...`).

- `set <project-id> <account-id>...` replaces the project's list; unlisted accounts
  follow by global priority. Ids must be Claude accounts of this pool, without
  duplicates. `clear <project-id>` restores the global order. `list` shows all.
- Only new or cold sessions use the order: a live session pin (idle under 65
  minutes) always wins. Exhausted, errored, disabled or removed accounts are
  skipped, so every account stays reachable.
- The hub learns the project from the `x-bb-project` request header that the plugin
  adds via `ANTHROPIC_CUSTOM_HEADERS`; no header or no order means the global order.
  The header is not forwarded upstream. Threads started before the plugin update have
  no header until their environment is resolved again.
- Project-ordered choices never advance the global active-account cursor.
- Parent proxy mode forwards the header to the parent hub, which applies its own order
  for that project id if it has one.
- The header value is merged with `ANTHROPIC_CUSTOM_HEADERS` from the plugin process
  environment, not with host or thread environment settings.

## Access-block diagnostics

`bb pool ping <id> --diagnostic` or `account.ping` with `{ "id": "<uuid>", "diagnostic": true }` sends one minimal request even for a disabled, exhausted, held or access-blocked local Claude account. It does not enable the account or change cursor/affinity. Credential errors, unknown/non-Claude targets, parent proxy mode and stopped hubs still reject. The flag must be a boolean over RPC and defaults to false.

Settings retains blocked accounts and offers Diagnostic retry (consumes quota). The stored observation includes actual HTTP status (403 or the exact verification-required 400 below), structured error type/message when safely parseable, and timestamp. Other HTTP failures preserve an existing block; only successful inference or diagnostic clears it. Quota refresh, enable and restart preserve it. Compact usage inventory includes only enabled accounts regardless of operational status; blocked enabled accounts show usage errors. Disabled accounts disappear from inventory, and stale fetches fail on the next normal refresh.


## Identity verification required

Claude HTTP 400 with exact error type `invalid_request_error` and exact message `Identity verification is required to continue.` is persisted as status `verification-required`, displayed as Requires verification (400). It is excluded from ordinary selection; compact visibility depends only on enabled. It remains in settings even when disabled, and clears only on successful inference or diagnostic. A generic 400, a different type, or a different message does not block an account. Ordinary generic 400 response bodies and headers remain unchanged.

For rollback after recording verification 400 observations, restore the original pre-feature runtime backup from the deployment receipt. It ignores the separate observation table; no data cleanup is required. Do not restore the intermediate 403-only runtime, whose observation schema cannot read 400.

## Hermes and other Anthropic-compatible clients

See PLUGIN_OVERVIEW.md → Anthropic-compatible clients for authenticated `/models`.
`/v1/models` remains the Codex catalog. Catalog access does not establish that a
third-party client can use subscription inference; upstream entitlement remains
a separate requirement. Do not synthesize client identity to change that result.

## OpenAI API keys

Pipe OPENAI_API_KEY to `bb pool account add --provider codex --api-key-stdin`
with an optional label/priority. UI: Codex → Add account → Add API key.
RPC: account.add with provider codex and source {kind: "api-key", apiKey}.
The key uses its OpenAI Platform project's allowance. Treat model access and
billing availability as unverified until a request succeeds. The pool does not
read a dollar balance. API keys follow existing account priority and affinity;
they do not automatically become last-resort accounts.

See PLUGIN_OVERVIEW.md → OpenAI Platform API keys for routing and error recovery.

## Machine roles

Default deny: only a machine with a role gets central Claude and Codex pooling.
The roles are `server`, `worker` and `trusted`; they currently behave the same.
Use `bb pool machine list [--json]` to see enrolled machines and removed machines
that kept a role. `bb pool machine role <host-id> <server|worker|trusted|none>
[--json]` sets the exact ID's role; `none` removes it, including for a machine
no longer enrolled. Unknown IDs cannot get a role. Names are display only.

Settings → Advanced → Machine routing and RPC `hostRole.list` (null input),
`hostRole.set` (`{hostId, role}`) use the same persisted service.
Without a role, environment contributions carry no Pooler endpoint, auth or
parent markers, including catalog calls with no thread, and no
ANTHROPIC_CUSTOM_HEADERS, preserving opaque target-host headers byte-for-byte.
Preexisting arbitrary project-header cleanup belongs to the separately
configured VM launcher. The machine must use its own provider login.

No hub token is minted for a machine without a role. Setting `none` deletes its
token file, so current and grace tokens fail newly performed authentication;
already authenticated requests may finish and running processes keep their
environment. A change between roles keeps the token. A role is not proof of
native login or capacity; no registry/scheduler is created.
A removed machine keeps its role until it is set to `none`: set `none` before
removing a machine. Roles survive reload. The exclusion table is kept as the
rollback input of the previous version and rewritten from roles; after a
rollback that version routes exactly the machines that had a role.
