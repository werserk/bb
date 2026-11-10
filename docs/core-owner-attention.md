# Owner-attention core candidate

This is the core companion of the approved `owner-attention-stop-triage` change.
It implements the shared server policy, Claude Stop callback and Codex 0.166
session-local Stop activation with private IPC. Source and CLI fixture support
are not installed bb runtime proof or seven-day acceptance.
The earlier feasibility checkpoint remains historical; this document owns the
implemented contract.

## Plugin contract

```ts
const capabilities =
  bb.experimental_threads.experimental_preCompletionCapabilities();
bb.experimental_threads.experimental_setPreCompletionPolicy(
  threadId,
  async (context) => {
    return { action: "allow" };
  },
);
bb.experimental_threads.experimental_setPreCompletionPolicy(threadId, null);
```

The callback receives `PluginPreCompletionContext`: authenticated project and
thread, assembler-mapped bb `turnId`, `turnOrigin: "provider"`, provider ID,
`finalText` (at most 8192 UTF-16 code units), `truncated`, native
`pendingUserQuestionIds`, `correctionAttempt: 0`, and an AbortSignal.
It returns allow or `{ action: "continue", instruction }` (1–1000 trimmed code
units). Policy/classification belongs to the plugin. Only threads explicitly
registered by that plugin run its policy. A second plugin cannot replace its
registration. Disposal or server restart removes registrations; the plugin must
re-register its managed threads on startup. Core keeps no project-membership
classifier or scheduler.

Capabilities version 1 reports a 2000ms policy deadline, 8192 final text limit,
both Claude and Codex `requires-matching-bridge`. This describes source
support; it does not prove the host has the matching bridge. The fake plugin
host rejects native policy registration instead of simulating successful support.

## Shared core action and custody

`packages/domain/src/pre-completion.ts` owns the reserved builtin name.
Claude's native Stop callback calls that builtin through the existing dynamic
tool channel. Both provider bridges reject model-selected calls of the reserved
name before forwarding. The callback reads its query's origin, not the arriving
active turn. The runtime maps that origin with the existing assembler and sends
`turnOrigin: provider` only for a mapped ID. Missing/raw/arrival identities cannot
admit a correction. The authenticated daemon route verifies host custody, then
calls `apps/server/src/services/threads/pre-completion.ts`; the SDK only
registers policy, and cannot invoke a separate plugin correction action.

The daemon wire request and response shapes and meanings remain ordinary
builtin-tool calls; no new field, RPC, protocol version, table or migration is
introduced. A builtin addition uses the same route as existing core plan and
environment tools. Trust is the existing authenticated host/provider-bridge
boundary. A model selecting the reserved tool name is explicitly refused.

The server checks that the exact persisted bb turn started and remains open.
It reads pending/resolving native interaction rows strictly, including corrupt
row detection. Approval prompts do not count as `user_question`. A question
present before policy or appearing while it awaits suppresses correction.
No question payload or final text is written to diagnostics.

One reservation in existing `plugin_kv`, under core-owned
`__bb_pre_completion_v1__` and the JSON `[threadId, turnId]` key, is atomically
inserted before returning a corrective instruction. A conflicting callback
allows completion. Policy reload, server restart and event pruning do not erase
this reservation. Uncertainty after reserving does not retry. It records an
attempt, not proof that the provider consumed the response. Keys are retained;
rollback leaves them inert, rather than deleting or replaying them. The plugin
cannot access this namespace through its own namespaced storage API.

Each opted-in callback writes a normal `system/operation` observation with
operation `pre_completion`, action/reason/gap and version, with no text payload.
Unverified identities use thread scope. The CLI's existing thread event reads
expose the same records. Once custody does not depend on retained event history.
An unavailable observation write fails open; it cannot fabricate a receipt.

Timeout, policy failure, corrupt/unavailable native questions, invalid input,
missing identity, unavailable reservation or observation storage and unsupported
provider permit completion with typed gap responses. Cancellation and ended
turns permit completion; the bridge also checks retirement and query origin
again before returning a native block. Existing plan Stop behavior uses the same
native callback after owner-attention allows; the new policy does not replace it.
Every unsupported or uncovered stop stays in the plugin's measurement denominator.
No observation or capability is a successful correction receipt.

## Checked and missing

Targeted core fixtures cover opt-in, one reservation through policy reload,
concurrent callbacks, native question race versus approval, corrupt interaction
reads, Stop during policy, timeout, failed/invalid policy, model-spoof rejection,
Claude origin mapping and completion without another assembled turn, bounded
text and old-host responses. They use real migrated SQLite and simulated native
provider streams. Existing Codex question and identity fixtures remain relevant
baseline checks, not proof of a Codex correction.

## Pending question across a daemon replacement

A provider's native question is answered through a continuation held in the
replaced daemon's memory (`apps/host-daemon/src/interactive-request-registry.ts`),
so a new daemon instance cannot receive its answer. Opening a session with a
different `instanceId` interrupts the host's pending interactions with a
"Host daemon restarted" reason; a socket replacement by the same instance keeps
them pending. The interrupted row keeps its thread, turn and provider request
identity and is returned by id, but `thread interactions list` shows only
`pending`/`resolving` rows, so a list-based observation reads "absent". A late
answer is refused as already interrupted, repeated replacement changes nothing,
and the once guard of the ended turn is untouched. Answering after replacement
would need a resume contract (a new turn carrying the answer), which is a
separate decision; none exists, and no answer is bound to a different root.

## Codex activation and private IPC

`plugins/provider-codex/src/bridge/pre-completion.ts` creates a private 0700
session directory, a 0600 Node hook client with a random session credential and
a Unix socket. Before injecting flags, an unmodified app-server probe reads `config/read`
with the actual workspace cwd and `includeLayers: true`, then `hooks/list`.
Any existing hooks declaration, or explicit `features.hooks=false`, in any source
layer, including a disabled layer, prevents new activation. Trust state alone in
the user layer (`hooks.state` entries with only `trusted_hash`/`enabled`, no
declaration) does not: Codex merges session configuration into the user table, a
probe on Codex 0.166 showed a user hook's trust surviving beside the session Stop
trust, and a discovered hook still prevents activation. The owner's own
`config.toml` carries such an entry, so a lab that links it was refused silently
before this rule.
Discovered hooks outside TOML (such as hooks.json and plugin hooks), unknown
source layers, missing config information
and discovery warnings/errors also prevent activation. This conservative path
leaves configured launch arguments, declarations and trust state unchanged,
regardless of whether the server policy is enabled. Nonactivation does not emit
a visible provider warning: the bridge has no plugin opt-in information. For an
opted-in thread, absence of a server pre_completion observation remains a coverage
gap in the acceptance denominator; it never counts as successful coverage.

Only a clear configuration allows that session's app-server to receive
`features.hooks` and `hooks.Stop` through launch flags. Before thread/start,
resume or fork receives new trust state, the same source-layer/discovery check
runs again, allowing only the exact generated session-flags declaration with
no prior declaration or explicit hook opt-out. `hooks/list` supplies the exact
declaration hash; a second list on the loaded thread must report trusted. A
recheck refusal or loaded-thread verification failure fails construction
explicitly, closes private IPC, removes its script and terminates the child
before returning the error. The bridge does not continue with forced hook flags
pointing at a deleted client. A fresh construction starts with the original
configured arguments. Only the generated declaration is trusted. No global or repository hook configuration is written;
existing hooks and trust are never replaced to obtain correction coverage.

The bridge requires a native synchronous sessionFlags Stop-start notification
from the discovered source path and display order, exact provider session ID,
an open provider turn and a session credential. Each native run is consumed
once. Model-selected reserved tool calls remain rejected. Foreign, replayed,
retired and interrupted origins cannot block. A correction-active Stop allows
completion without another policy correction. The server's persisted once
guard also prevents reconnect/restart from admitting another correction.

The client accepts at most 128 KiB of native stdin, trims candidate text before
IPC, sends at most 8192 text units to policy, and exits fail-open after 3s.
The socket accepts at most eight concurrent clients, 128 KiB per request and
one request per connection. Policy transport is aborted after 2500ms, removes
its pending bridge request, and ignores late replies. Owner Stop cancels this
work before asking Codex to interrupt. Normal terminal events, session release,
replacement and child exit retire the corresponding custody. Release/exit also
remove the socket and script. Abrupt process kill may leave an inert temporary
directory; there is no listening service or reusable credential after restart.

The credential is private host-process custody, not an OS sandbox against a
malicious process with the same uid or unrestricted filesystem access. Native
notification gating additionally prevents ordinary model tool calls and direct
socket traffic outside the exact native Stop window from invoking policy.
Windows activation is currently fail-open/unsupported. Old CLIs and preflight
discovery failures retain the unmodified connection and allow normal completion
without a visible warning. Once hook activation has started, trust recheck or
verification failure explicitly fails construction and cleans up the child.
Matching source capability alone never establishes coverage on a particular host.

## Checked and missing runtime evidence

The opt-in native fixture (`BB_CODEX_NATIVE_STOP_FIXTURE=1`, Turbo loose env)
launches installed Codex 0.166 against an ephemeral loopback Responses mock and
isolated CODEX_HOME, with pool routing cleared. It proves trusted hook execution,
actual bridge IPC, the corrective text reaching a second model request and one
provider turn.open/turn.boundary pair with identical origin. It also interrupts
an in-flight policy and verifies no corrective second model request. It does
not spend model quota or install a bb candidate. Four further installed CLI fixtures configure a trusted existing Stop through
launch flags or an isolated user config, each with enabled/disabled policy
responses. They prove the original hook executes once, no correction call is
emitted, no provider warning is shown and the user config is unchanged. Further
native fixtures preserve explicit user/launch hook opt-out without policy calls.
Unit fixtures reject declarations/trust and explicit hook opt-out across every
known source layer and unknown discovery. Construction fixtures introduce a
conflict before thread trust configuration or reject loaded-thread trust,
verifying an explicit error, exited children, no private script or writer lock,
and successful clean reconstruction with the original arguments.
Unit fixtures also execute the real generated client and cover authentication,
bounded text, replay, cross-session
and turn rejection, malformed/unavailable policy, deadline and cancellation.
Shared server fixtures exercise both provider IDs against real migrated SQLite.

Missing: installed bb daemon/server/end-to-end Claude/Codex correction and native
question creation, process restart/reconnect/rollback and upgrade acceptance,
Windows support, per-host deployment proof, reviewer-critical and reviewer-codex
on the final SHA and owner-authorized core release. No full feature PASS or
seven-day result is claimed. No merge, release, push or PR is implied.
