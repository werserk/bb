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
- **Stop keeps refreshes.** Once `hub.stop()` begins, no new token refresh
  starts; refreshes already in flight get up to the refresh timeout plus 5 s to
  finish and store the new token before the transport closes. A refresh still
  running after that bound is cut off.
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

## Retired native cells

The native-cell controller (cell registry, immutable bindings, resident slots,
the `message.dispatch` hold and `pool native`) was removed on 2026-11-27 by the
owner's decision. Why: a cell kept its own provider login next to the pooled
account, so two processes could refresh the same OAuth grant and invalidate each
other. The hub is now the only refresh owner for every pooled account; a machine
that must use its own login is excluded under Machine routing instead.

Migration nine (`NATIVE_POOL_MIGRATION` in `store.ts`) stays byte-identical at
its index. The SDK checks every applied migration by index and statement hash,
so editing or dropping it would make existing stores refuse to open, and keeping
its tables lets the previous build open the same store on rollback. Nothing
reads those tables now. `store.test.ts` pins the recorded hashes; new
migrations are appended after it.

The Plugin SDK dependency is still the locally packed
`vendor/bb-plugin-sdk-native-pool.tgz` (version `0.6.132+werserk.artifacts.3`,
SHA256 `7581557bb54002e7a3ae2d0a68ac5545185dd0d546692900d0836fe80087a4d0`),
kept unchanged with the lockfile; replacing it is separate work.
