# Account Pooler runtime map

Entry: ../PLUGIN_OVERVIEW.md. Agent operations: ../skills/account-pool/SKILL.md.
Development source is this repository. The installed plugin runs from a
separate candidate directory built from one commit; local tests do not update it. Verification artifacts are held in
the originating BB thread storage.

## Structure

server.ts registers CLI/RPC/HTTP and constructs hub.ts. Hub owns authenticated
machine access, account selection, quotas, affinity, refresh, streaming and
parent delegation. Provider adapters own upstream credentials and wire format;
upstreams.ts fixes the provider hosts they send to.
GET /models selects Claude and maps to upstream /v1/models. GET /v1/models
selects Codex. Parent forwarding retains the public alias; only the final adapter
maps it. Queries and upstream errors are preserved. The adapter supplies the
standard Anthropic API version when absent, preserving an explicit caller version.

## Operations

bb pool status --json inspects routing; bb plugin build builds the package;
bb plugin reload account-pool-prewarm reloads it. Tests run with no inherited BB
routing; test-isolation.mjs enforces this boundary. Logs/secrets/data.db live in
the bb data directory under
plugins/account-pool-prewarm. Tokens never enter code or test artifacts.

## Security decisions (P0, 2026-11-27)

- **Provider upstreams are code.** `src/upstreams.ts` holds api.anthropic.com,
  chatgpt.com/backend-api/codex and api.openai.com/v1. Earlier builds let a
  config setting change the Anthropic and ChatGPT upstreams, so a config write
  could redirect account tokens. Adapters no longer see config when they build
  a URL, and `mountedUpstreamUrl` refuses a request path that would change the
  origin. The only override is the test-only
  `createAccountPoolPlugin({ upstreams })` option; the shipped default export
  passes no options, and no RPC, CLI, plugin env or stored config reaches it.
  A stored config that still has `anthropicUpstreamBaseUrl` or
  `codexUpstreamBaseUrl` loads; the keys are dropped and logged once, naming
  (never printing) a stored value that differed from the old default. The host
  is fixed in code; the network path still follows the daemon's proxy and TLS
  environment (`HTTP(S)_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`), which is the
  operator's trust boundary.
- **No import of a CLI login.** Accounts are added only by the hub's own login
  (Claude OAuth, Codex device code) or as API keys. Importing a live CLI login
  gave an account two refresh owners; with refresh-token rotation one side
  invalidates the other and forces re-logins. Accounts imported by earlier
  builds are ordinary OAuth records and keep working unchanged; while their
  source CLI stays logged in and in use, it is still a second refresh owner.
- **Stop keeps refreshes.** `hub.stop()` waits (bounded) for in-flight token
  refreshes before the transport closes, so a reload or reinstall does not lose
  a rotated refresh token.
- **Caller identity is still open.** Plugin RPC carries no caller identity, so
  every administrative call is trusted. Host exclusions and any future roles
  or thread policies guard against mistakes, not against a hostile caller.
  Closing this needs a core change and is tracked outside this repository.

## Rationale

A real catalog fixes Hermes model verification without changing the Codex route
or inferring entitlement from static picker entries. Inference remains subject
to upstream billing rules. An experimental synthetic Claude Code envelope was
removed after full-profile Hermes traffic explicitly required extra usage.
No new proxy daemon, identity codec or Hermes core patch remains.

## OpenAI API routing

Operations accepts the existing api-key secret kind for both providers. CLI/RPC
and each provider's Add account menu share that creation path. Codex adapter
chooses Platform /v1 or ChatGPT upstream per selected account; hub passes account
identity into endpoint resolution at every attempt. Public compact routes to
/v1/responses/compact. API request body bytes are opaque, API headers exclude
ChatGPT identity and internal headers, and response streaming stays in the hub.

Explicit Platform insufficient_quota uses the existing persisted credential-error
store to remove a key from selection until the owner enables it after replenishing
allowance. No new storage/schema or admin billing credential is introduced.
Model-access 403 remains a request failure; 401 remains credential failure.
Mixed accounts share the existing priority/cursor/affinity policy to avoid a
second paid-routing mechanism. API catalogs remain native Platform payloads.

## Machine-wide routing exclusion

`src/host-exclusion.ts` owns explicit policy in `pool_host_exclusion(host_id)`;
missing row preserves existing routing. This additive eighth migration shares
QUOTA_MIGRATIONS and the existing database. RPC, CLI and settings use the same
service; retained exclusions outlive host unenrollment until explicitly removed.
The policy gates provider environment contributions (including null-thread
catalog), token mint/rotation/current and grace authentication, retry decisions
and Proxied health. Post-await checks prevent stale positive results.

Excluded env contributions empty both providers' routing and parent markers,
without contributing ANTHROPIC_CUSTOM_HEADERS. Opaque target-host headers are
preserved byte-for-byte; any preexisting project attribution cleanup belongs
to the separately configured VM launcher.
Existing processes keep their environment. New authentication is denied while
excluded; requests authenticated earlier may finish. Policy identifies the
trusted host context/token principal, not physical network origin.

An older plugin ignores exclusion rows and may route again. Rollback therefore
is not preserved isolation; enrolled native machines need independent launcher
or network confinement before rollback. This feature establishes no native
identity, readiness, worker registry, capacity lease or scheduling guarantee.

## Personal native pool (disabled candidate)

`native-pool.ts` owns the cell registry, immutable bindings, durable submission
custody and resident slots. Migration nine is appended to QUOTA_MIGRATIONS in
the existing SQLite database. No lease expiry frees capacity. `native-adapter.ts`
composes typed SDK spawn/send/queue/idle-release with authenticated host status;
`native-surface.ts` shares controller operations between RPC and `pool native`
CLI. `native-workers.tsx` renders the settings section.

`native-host.ts` probes a fixed lock inode, validates the participating launcher
receipt against kernel FLOCK PID/device/inode, process start identity and boot
identity. `worker/native-launcher.py` is an explicit deployment input, not
installed by the plugin build. Status performs no provider CLI or quota probe.
Missing configuration and unverifiable holders retain unknown holds. Ordinary
owner SSH remains unrestricted. Runtime workspace and SSH target are separate.

The source adapter depends on a locally packed candidate Plugin SDK; see
`NATIVE_POOL.md` for provenance and qualification boundaries. Default server
policy and new cells are disabled/unqualified. No production settings or
installation are changed by this source candidate. This separates process and
custody proof from later live qualification and account enrollment.

Capacity-change handling rechecks BB's plugin-held continuation queue before
pumping new intents. Released bindings can thereby reacquire their original cell
when its resident becomes idle. Reservation and pumping share eligibleCells;
disabled, unqualified or centrally included free cells never hide an eligible
idle resident. No timer or second runnable continuation queue is introduced.

Explicit Stop issues owned-row cleanup and thread interruption independently:
a consumed queue row or failed cleanup cannot suppress interruption. Both
outcomes remain visible in the cancelling intent; neither acknowledgement frees
capacity. Cancellation during exact create recovery also interrupts the late
bound thread without transferring its initial input.
