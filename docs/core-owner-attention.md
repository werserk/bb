# Owner-attention core candidate

This is a partial companion of the approved `owner-attention-stop-triage` change.
It implements the server policy and Claude Stop path. Codex native hook injection
is unfinished and reported as unsupported; the combined feature cannot pass
claim_1 or seven-day acceptance. Source support is not installed-runtime proof.
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
Claude `requires-matching-bridge`, and Codex `unsupported`. This describes source
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

Missing: Codex native Stop injection and bridge calibration, installed
Claude/Codex same-logical-bb-turn correction and native-question proof,
installed reconnect/restart/rollback and upgrade gates, per-host runtime
capability proof, final independent reviewer-critical and reviewer-codex on the
same SHA, and owner-authorized core release. No live model call or installed lab
was used to establish this candidate. No merge, release, push or PR is implied.

The installed Codex 0.166.0 local configuration probe discovered an untrusted
Stop hook in session flags and returned its native key/hash without a model
request. This establishes a possible injection route; it does not establish
trusted hook activation or safe bridge IPC. The pinned upstream same-turn test
linked in the feasibility checkpoint was inspected, not executed here.
