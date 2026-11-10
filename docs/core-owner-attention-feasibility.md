# Owner-attention pre-completion checkpoint

Status: feasibility checkpoint, not a correction feature or an available SDK API.
Baseline: `504c9a246d2c12f08ad4ba1f20a9df611f12e2a7`. Owner approved
the companion through coordinator `thr_mayigfigsx` on 2026-11-10; the
approved plugin plan is `68b7dd6fd8d2f3969059ad4cab8e9914f7c6b0fe`.
Its review-contract decision_1 does not authorize daemon protocol or database
migration changes by implication. Core release remains owner-only.

## Provider feasibility

The installed CLI reports `codex-cli 0.166.0`. The app-server schema generated
by that binary with `--experimental` exposes hook notifications, not a Stop
request to the client. This does not mean Codex lacks blocking Stop hooks.

The version-pinned upstream test
[stop_hook_can_block_multiple_times_in_same_turn](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/core/tests/suite/hooks.rs#L1312)
uses a local mock model, blocks twice, and checks that all three Stop calls have
the same nonempty `turn_id` and `stop_hook_active` is false/true/true.
The [turn loop](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/core/src/session/turn.rs#L743)
records hook feedback using the existing turn context and continues the loop.
These are inspected upstream assertions, not tests executed in this checkout.

The [release hook documentation](https://learn.chatgpt.com/docs/hooks#stop)
describes continuation feedback as a new user prompt. That description alone
does not establish a new bb logical turn: the pinned implementation and test
retain the provider turn identity. A future installed fixture must also prove
the exact mapped bb turn remains unchanged through correction and completion.

Claude already registers a blocking native Stop callback in
`plugins/provider-claude-code/src/bridge/bridge.ts` via
`plan-turn-check.ts`. That guard is local memory, not durable owner-attention
policy. Its existence proves neither persistence nor native-question race safety.

## Blocking boundary

Product policy belongs on the server (AGENTS.md). Both native Stop paths run on
the host. At this baseline:

- `plugins/provider-codex/src/bridge/bridge.ts:handleChildRequest` handles
  dynamic tools and interactive requests; hook notifications are observations.
- `packages/agent-runtime/src/runtime-provider-requests.ts` forwards tools and
  interactive requests; there is no pre-completion policy request.
- `apps/host-daemon/src/app.ts:onToolCall` and `server-client.ts:callTool`
  forward the authenticated `/session/tool-call` wire contract.
- `apps/server/src/internal/tool-calls.ts` authenticates daemon custody and
  invokes tools. It has no trusted indication that a call came from a Stop
  callback rather than a model-selected tool. Tool arguments cannot supply that
  trust. A special plugin tool would be a parallel action path and would not
  prove pre-completion refusal.
- `packages/host-daemon-contract/src/protocol.ts` is version 259.

A dedicated trusted request across this boundary adds wire meaning and needs
the protocol treatment required by AGENTS.md, plus explicit authority under
decision_1. This checkpoint does not establish that every possible compatible
transport is impossible. It identifies the authority boundary of the proposed
canonical implementation. No protocol bump or migration has been performed.
No post-idle wake, synthetic turn alias or late steer substitutes for it.

An alternative still needs investigation: a core-owned, unadvertised builtin
tool over the existing dynamic-tool transport, invoked only by the native Stop
callback. Adding a builtin tool need not automatically mean a wire change.
Before selecting it, prove that a model-selected tool invocation cannot impersonate
the callback and that Codex hook injection can reach the bridge without shared
configuration or global state. Codex command hooks would need host-local IPC;
MCP hooks are not automatically the app-server's injected dynamic tools. This
checkpoint does not rule out that transport and therefore does not prove that
a daemon protocol change is technically unavoidable. The implementation remains
unfinished, rather than provider-impossible.

## Proposed adapter contract (not shipped)

Names below are a concrete integration proposal, not capabilities a plugin may
probe successfully today. Register once; opt in individual managed threads.

```ts
experimental_threads.experimental_preCompletionCapabilities(): Promise<{
  version: 1;
  providers: Array<{
    providerId: string;
    supported: boolean;
    gaps: PreCompletionGap[];
  }>;
}>;

experimental_threads.experimental_setPreCompletionPolicy({
  threadId: string,
  enabled: boolean,
}): Promise<void>;

hooks.on("experimental_turn.preCompletion", handler);

type PreCompletionContext = {
  projectId: string;
  threadId: string;
  turnId: string;
  turnOrigin: "provider";
  providerId: string;
  finalText: string;
  truncated: boolean;
  pendingUserQuestionIds: string[];
  correctionAttempt: 0 | 1;
};

type PreCompletionDecision =
  | { action: "allow" }
  | { action: "continue"; instruction: string };

type PreCompletionGap =
  | "unsupported_provider"
  | "missing_identity"
  | "pending_questions_unavailable"
  | "policy_unavailable"
  | "policy_timeout"
  | "policy_failed"
  | "durable_guard_unavailable"
  | "continuation_failed";
```

The server derives project/thread/turn from the authenticated daemon and
assembler-mapped provider origin. Missing, raw or arrival identity allows
completion with a gap. The provider cannot select project or bb turn through
arguments. Final text is capped at 8K characters, the whole policy call at 2s,
and corrective instructions must have a small validated bound. Neither text
nor question payload belongs in coverage telemetry.

Core reads native pending `user_question` interactions and rechecks immediately
before admitting correction. Approval prompts do not count. Unknown reads fail
open with a gap. Existing pending questions suppress correction. Stop,
cancellation and provider failure bypass policy and can abort an in-flight
check. They must not wait for the plugin deadline.

The server must atomically reserve the once guard for the exact persisted bb
turn before returning a continuation. Reconnect, duplicate callback and restart
cannot admit a second continuation. Loss or uncertainty after reservation does
not retry the correction. Existing persistence must be evaluated before choosing
a storage extension; this checkpoint authorizes no migration. The host must
confirm native continuation on that same origin, not create a bb input request
for another turn. Core and plugin controls must share this action implementation.

Every enabled managed stop remains in the coverage denominator. Unsupported,
timeout and failure allow completion but never earn successful correction
credit. No runtime reports support at this checkpoint.

## Required implementation and proof after authorization

1. Implement the trusted bridge/runtime/daemon/server action, provider hook
   injection and cancellation. Protect provider hook configuration from leaking
   into shared repositories or a user's global Codex settings.
2. Implement exact-origin mapping, pending-question reads/races and durable
   once custody; prove restart/reconnect and uncertain correction outcomes.
3. Add the experimental SDK declarations, fake host, API audit and Plugin Guide
   together with implementation. Preserve sibling rotation declarations from
   `f0147c819863851e5d0c652f18073a3a3de267ec`; no shared hunks changed here.
4. Run installed isolated Claude/Codex fixtures through one correction, native
   question creation, same bb turn completion and owner Stop. No provider spend
   or installed runtime test has been performed for this checkpoint.
5. Parent arranges reviewer-critical and reviewer-codex on the same final SHA.
   No merge, release, push or PR is authorized here.

Existing bridge and assembler fixtures are useful baseline evidence; they do
not establish new guard behavior. Commands, counts and logs are retained in the
author thread storage, separate from this proposal.
