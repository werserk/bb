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
host-roles.ts decides which machines are pooled and how, thread-pass.ts issues
and checks per-thread passes, audit-log.ts keeps the append-only audit,
thread-policy.ts stores each thread's account policy and thread-account.ts
serves it as the public `thread-account.v1` contract and `bb pool thread`
(docs/THREAD_ACCOUNT_V1.md).
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
  every administrative call is trusted. Machine roles and any future thread
  policies guard against mistakes, not against a hostile caller.
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

## Machine roles

`src/host-roles.ts` owns `pool_host_role(host_id, role)`, the tenth migration in
QUOTA_MIGRATIONS. The rule is default deny: a machine is pooled only while it
has a role. A machine without one gets neutral environment contributions
(including null-thread catalog calls), is never minted a hub token or a pass,
its current and grace credentials fail authentication, rotation fails, and retry
decisions and Proxied health treat it as unpooled.

| Role | Credential in its threads' env | Nested bb servers |
|---|---|---|
| `server`, `trusted` | a pass per thread; the hub token for threads that existed at P3's first start (until a policy is set) and for sends without a thread | get the hub (parent markers, the machine's hub token) |
| `worker` | a pass per thread; a catalog pass without a thread | get nothing (markers empty) |
| none | nothing (neutral env) | get nothing |

`server` and `trusted` behave the same in this version. `HubTokenStore` takes
its predicate as a required constructor argument (`server ∨ trusted`), so a
store without one cannot exist and a worker is never minted a token.

Why: a workspace must never get a key or a pass by accident. Under the earlier
opt-out exclusion, a newly enrolled machine was pooled until someone excluded
it; with roles, it gets nothing until the owner gives it a role.

Start order: list enrolled hosts, then one transaction (the SDK migrator, the
one-time seed, reconcile, projection), then the token store and its prune.
- Upgrade from the opt-out build (the exclusion table exists, the role table
  does not): every enrolled host without an exclusion row gets `trusted`, so
  today's routing and its tokens are kept; excluded hosts get nothing, and a
  token file kept for one is deleted by the prune. A fresh store seeds nothing.
- Reconcile, every start: an exclusion row beats a role, except for `worker`
  (a worker always has an exclusion row, see Rollback). Only the previous build
  writes such a pair (an exclusion made after a rollback).
- An Include made under the previous build is not carried forward; give the
  machine a role after rolling forward.
- Role changes: to `none` or to `worker` deletes the machine's token file;
  leaving `worker` or losing the role deletes its passes; any other change
  keeps the token. Every real change writes a `role-change` audit row, after
  the revocations; a failed audit write is logged and revokes nothing less. Prune at
  start and on every `status` drops tokens of machines that are not enrolled or
  hold no token role.
- A removed machine keeps its role ("No longer enrolled, role kept") because
  the host list may be incomplete; set `none` before removing a machine.
- The pool's `server` role is the pool's own record. Moving bb's core server to
  another machine does not move it; set the roles again after such a move.

Rollback projection: `pool_host_exclusion` is no longer read for routing; it is
the previous builds' only input. `projectExclusions` rewrites it from roles on
every role change, at start and on every `status`: a row for every enrolled
machine without a role and for every `worker` (enrolled or not), none for
`server` or `trusted`. After a rollback the opt-out build routes exactly the
`server` and `trusted` machines of the last projection, and the first roles
build (P1) drops a worker's role at its start, so no older build mints a hub
token for a worker. A machine enrolled after the last projection is routed by
the opt-out build; any `bb pool status` before the rollback closes that gap.
Older migrators ignore the extra recorded migrations, so the store opens.

Existing processes keep their environment; requests authenticated earlier may
finish. Roles identify the trusted host context and token principal, not the
physical network origin. Like every administrative call, they guard against
mistakes, not a hostile caller (see Caller identity above). Roles establish no
native identity, readiness, worker registry, capacity lease or scheduling.

## Per-thread passes

`src/thread-pass.ts`. A thread gets a pass bound to one thread and one machine
instead of the machine's hub token, so a leaked credential reaches one thread
and dies with it, and the hub knows which thread sent each request (the input
of the thread account policy). P2 issued passes on `worker` machines only;
P3 issues them on every role (see Grandfathering). A pass is
`pt1.<threadId>.<mac>`, where mac = base64url(HMAC-SHA256(key,
"pt1\0" threadId "\0" hostId "\0" nonce)). A send without a thread (the model
catalog) gets `pc1.<hostId>.<mac>`, which only lists models: right after
authentication, before the parent-proxy branch, every other route answers 403,
and `/availability` and `/retry-availability` refuse it.

Why a key: passes are re-derived from the key on every send and never stored.
`pool_thread_pass(thread_id, host_id, nonce, issued_at, archived_at)` holds only
a random nonce per thread, useless without the key, so the database and its
backups hold no credential. Verification is one row lookup and an HMAC compare;
a malformed pass (wrong part count, id characters or MAC length) is a 401.
- Key file: `secrets/accounts/pass-key.json` (0600, `{"version":1,"key":…}`),
  created at the first worker issue and only if it does not exist (exclusive
  create, then a hard link: an existing file always wins); never overwritten.
  Any other read or parse failure is logged once and leaves passes off until a
  restart (workers get neutral env, threads on `server` and `trusted` machines
  get the machine token, logged once when that starts and once when it ends;
  every pass is refused); hub tokens are unaffected.
- Rotation: with no worker turn running, delete the file and reload the plugin;
  every pass dies and the next send issues new ones.
- Why a row and a nonce: revoking deletes the row; a new row gets a new nonce,
  so a revoked pass never comes back.

| Event | Effect |
|---|---|
| `thread.archived` | works until archived + 30 s (core's archive undo grace; a turn may still run) |
| `thread.unarchived` within 30 s | the same pass works again |
| `thread.unarchived` later | the row goes; the next send issues a new pass |
| `thread.deleted` (soft delete, no undelete) | revoked at once |
| `experimental_host.deleted` | every pass of the machine is revoked |
| role leaves `worker`, or `none` | every pass of the machine is revoked (an issue running meanwhile writes nothing) |
| `bb pool pass revoke <thread>` | revoked; the next send issues a new pass |
| thread moves to another machine | the next send issues a new pass; the old one dies |

An existing row is marked archived whatever the roles (a later build may have
issued it on any role). An archive that lands before the thread's first issue
still writes an archived row while some machine is a worker or the thread may
hold a pass (created after the pass epoch, or with a policy row), so a racing issue
cannot leave a live pass behind; a role change while a pass is issued leaves
no row and no credential (the role is checked again after the awaits); a send to a thread whose
row is archived asks bb whether an unarchive was missed. Events missed while
the plugin was down are caught by a reconcile at start and every 15 minutes
(`pass-reconcile` service): it deletes rows of role-less machines, rows past
the grace, rows of machines `hosts.get` answers 404 for, and rows of deleted or
404 threads. An SDK error keeps the row for the next round, so the window for a
missed event is at most 15 minutes. There is no per-request thread lookup.

Role-agnostic seam: the module knows no roles. `mayHoldThreadPass` decides who
is issued thread passes (P2: `worker`; P3: any role), `mayHoldCatalogPass` who
gets the catalog pass (`worker`: other roles keep the machine token for sends
without a thread), `mayPresent` whose passes are accepted (any role, since P2).
A host revoke bumps a per-host counter, so an issue that started before it
writes nothing even though the role check still passes. Rolling back to P2
keeps passes of `server` and `trusted` threads valid (P2 accepts them) until
their process env is rebuilt with the machine token. A pass presented to a
build older than P2 is a 401.

### Grandfathering (P3)

`pool_pass_epoch(id = 1, started_at)` records P3's first start and never
changes. On `server` and `trusted` machines a thread uses a pass when it has a
policy row or bb's `createdAt` is at or after that time; otherwise, or when bb
cannot describe the thread, the env is byte-identical to P2's (machine token).
Why: a changed credential makes Claude and Codex rebuild the session at the
next turn, which ends background shells, monitors and subagents; threads
running when P3 arrives must not pay that. A `set` that stores a policy for
such a thread says so (`sessionRebuild: "next-turn"`). The creation time is
cached per thread (10 000 entries).

## Thread account policy (P3)

`src/thread-policy.ts`, `pool_thread_policy(thread_id, mode, provider,
account_id, on_limit, revision, updated_at)` plus `pool_pass_epoch`, the
thirteenth migration (index 12). No row is `auto` at revision 0; every write is
a compare-and-set on the revision. `named` carries the provider, so a named
Claude account never applies to Codex requests of the same thread.

The hub reads the policy per model request of a thread principal (a pass).
Named: only that account is tried, inside the normal loop, with the affinity
binding rebound to it (an inherited binding never overrides the pin) and the
active account untouched. When it cannot serve:

| State | `fallback-auto` | `stop` |
|---|---|---|
| real limit (utilization 1.0, or an upstream quota rejection) | CAS to `auto`, `named-limit limit-fallback-auto` + `policy auto@limit` | 429 + `retry-after`, `named-limit limit-stop` |
| account deleted | CAS to `auto`, `deleted-fallback-auto` | 429, `deleted-stop` |
| disabled, error, access blocked, restricted | served by auto, policy kept, one `unavailable-fallback-auto` row per stretch | 429, `unavailable-stop` |
| transient failure (5xx, short hold) | returned as is | returned as is |

Why the real limit and not the switch threshold (D1): the owner chose that
account. Why only a limit or a deletion persists `auto` (D2): a disabled or
blocked account is the owner's own switch or a temporary state. A CAS loser
re-reads the policy (at most three reads). `named-limit` rows that change
nothing are deduplicated per thread, revision and detail until the named
account serves again. The first request served by a newly named account writes
`switch` instead of `select`; the previous serving account comes from an LRU
filled from the audit log's latest `select` or `switch` row, so this survives a
restart. A `failover` row is written before its attempt, so it does not count
as serving. Every real change of the serving account, under any policy,
publishes `thread-account-changed`; the same account again publishes nothing.
The env hook stores the credential each routed turn got under the plugin KV
key `thread-route:<threadId>` (`pass` or `machine-token`, deleted when a turn
gets no central routing); `get` reports it as `route`. Policies of deleted
threads are dropped on `thread.deleted` and by the reconcile; archived threads
keep theirs.

Rollback to P2: P2's migrator ignores the extra migration, its audit read
returns the new reasons as they are, and its hub ignores policies (threads go
back to auto). Rows stay for a later roll forward.

## Audit log

`src/audit-log.ts`, `pool_audit(id, ts, reason, provider, thread_id, host_id,
account_id, detail)`, the twelfth migration. Append-only; ids, a reason and a
fixed-vocabulary detail only, never prompt content, model names, headers,
tokens or passes. Reasons: `select`, `failover`, `limit` (with `quota`,
`rate-limit`, `auth`, `upstream`), `pass-issued`, `pass-revoked` (with
`archived`, `deleted`, `restored`, `manual`, `role`, `host-removed`,
`reconcile`), `role-change` (`<from>-><to>`) and, since P3, `switch`,
`policy` and `named-limit` (details in docs/THREAD_ACCOUNT_V1.md). The reason is checked in code,
so a new reason needs no table rebuild; reads return unknown reasons and
details as they are, so `bb pool audit` keeps working after a rollback from a
build that writes more; a row that breaks the id and time invariants or holds
an overlong or control-character value is skipped and counted (`skipped`).

`select` is written once per account change of a session, not per request: the
key is [provider, thread (or machine for hub-token requests), session], held in
memory (10 000 keys, least recently used first out), and only for model
requests (not `/models`, not `count_tokens`). Requests forwarded to a parent
pool are logged by the parent, which selects the account. Retention: 90 days
and 200 000 rows, pruned at start and every 15 minutes. Read-only access:
`bb pool audit` (filters `--thread`, `--host`, `--account`, `--reason`,
`--since`, `--limit`, `--json`) and RPC `audit.list`.

## Retired native cells

The native-cell controller (cell registry, immutable bindings, resident slots,
the `message.dispatch` hold and `pool native`) was removed on 2026-11-27 by the
owner's decision. Why: a cell kept its own provider login next to the pooled
account, so two processes could refresh the same OAuth grant and invalidate each
other. The hub is now the only refresh owner for every pooled account; a machine
that must use its own login gets no role under Machine routing instead.

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
