# Composer Prompt Helper

Status: behavior and visual variant A accepted; implementation has not started.

## Intent and decisions

Help the owner express an intended request and choose the next useful action toward the conversation's accepted goal. Extend Prompt Suggestion and its goal companion rather than introduce another conversation or agent.

The owner selected preservation of draft meaning with separate advice, and preview before application. Authoritative decisions: `qst_2f9gh2pyjq` revision 1, `suggest_separately`; `qst_wfy4j6qkpc` revision 1, `preview`; `qst_byg2nc62dd` revision 1, `inline_a`. The selected visual reference is variant A in the question material snapshots, including desktop and mobile captures.

## Interaction

One small accessible composer action, labelled `Prompt helper`, opens a compact preview. Its accessible label and tooltip identify the action; the icon alone is not the only description. On desktop and compact screens, the preview expands inside the composer border above the original draft (variant A). The conversation moves above the expanded composer instead of being covered by a floating panel. The result, separate advice and apply controls remain visually grouped with the draft. It is usable by keyboard and touch; no floating helper panel or drawer is part of this selected design.

With a nonempty draft, the primary result is `Improved request`: clearer wording and structure while preserving the intended action, scope, constraints, uncertainty and tone. It may resolve references from known conversation facts, but must not invent facts, acceptance criteria or owner decisions. An ambiguous intent remains ambiguous or produces a concise clarification request; no silent choice is made.

With an empty draft, the primary result is `Next step`: one concrete message grounded in the accepted goal and remaining work. If nothing useful is supported, show a brief empty state rather than invent work.

Optional `Advice` appears separately only when a different direction would materially help. It is never appended to or substituted for the primary text. This first version offers no secondary conversation or automatic execution of advice.

Actions are `Replace draft` for an existing draft or `Insert` for an empty one, `Try again`, and `Dismiss`. The result remains editable after application. Application never sends a message. Existing ordinary Send/Enter behavior is unchanged. Closing the preview preserves the original draft. Each retry is an explicit new request, subject to the shared request limit; there are no automatic retries.

Loading leaves the original draft editable. Errors preserve it and offer a manual retry. If the draft or relevant thread context changes during generation or before application, disable application of that result and offer regeneration from the current snapshot. A thread change or composer disposal cancels/detaches the request; late results cannot apply to another composer. Failed application changes nothing.

Do not intercept Enter while the owner is editing the draft or accept a preview implicitly through Send. Moving focus into the preview must not dismiss it through the automatic-suggestion focus rules.

## Boundaries and implementation shape

The manual helper is another role in Prompt Suggestion using the existing shared model service, complete owner instructions, bounded conversation and source-linked goal memory. The draft is explicitly marked as an unsent proposal; it is not evidence of an accepted decision and cannot update task memory as an owner message. Advice may recommend clarification but cannot fabricate permission to spend, publish, release or expand scope.

Manual requests are independent of the automatic-suggestion enabled switch, but require an installed active plugin and an explicitly configured usable model. No new default model or fallback is selected. A manual click prioritizes the requested assistance over background companion memory. Existing automatic ghost suggestions remain available independently; opening the helper temporarily suppresses competing ghost text in that composer, without globally disabling automation.

Ordinary open conversation questions do not block manual assistance. A new helper request can use the latest available context while the working agent is active; a relevant context change invalidates the result for application. Command approvals retain their existing authority and interaction paths.

The UI captures a scoped draft/context snapshot. Server policy selects the role and validates a bounded structured result: editable primary text or no result, plus optional separate advice. The existing generation service owns model dispatch; provider credentials remain host-local. The role's output cap must support the input draft and must not reuse the automatic suggestion's 600-code-point limit. Oversized input is rejected clearly before inference, never silently truncated into a different request.

Applying the result uses the shared composer draft action and revision guard. Existing attachments are preserved. Mentions must retain valid structured identity; do not ship a text-replacement path that silently breaks mention metadata. The implementation plan must identify the existing SDK extension points and specify any minimal experimental extension and its core callers before editing core. No parallel plugin-only submission path is added.

Expose the manual generation action through the plugin RPC and `bb` CLI as well as the button. Headless invocation returns the same structured result and never edits a UI draft or sends a message. Preserve request cancellation, admission limits and content-free timing diagnostics across surfaces. Helper requests share the configured request budget; account for their role separately. No new transcript or draft corpus is stored.

## Acceptance

- A draft produces a meaning-preserving proposal; materially different advice remains visibly separate.
- Empty input produces a grounded next step or an honest empty state.
- Preview, dismissal, failure and retry never silently modify or send a draft.
- Only explicit application can replace/insert; edits, context changes and composer switches reject stale results.
- Existing attachments and valid mention identity survive application; ordinary submission still works.
- Keyboard and touch can open, inspect, apply and dismiss the helper; both desktop and compact layouts use the selected inline composer block.
- Open conversation questions do not disable assistance. Existing approvals are neither resolved nor bypassed.
- Manual assistance works with automatic suggestions disabled when a model is configured; automatic suggestions resume after closing the helper.
- RPC/CLI and UI share generation policy, validation and budget accounting.
- Failure paths, concurrency and application guards have deterministic tests. Semantic quality and latency must be reported separately from structural correctness.

## Scope and release constraints

This design adds no second chat, autonomous sending, persistent personal writing profile, provider/model switch, release or deployment. Existing local companion code and its previously measured speed/quality limitations remain the baseline. Previous paid pilot budgets are exhausted. Implementation and deterministic verification require a subsequent owner instruction; new paid evaluations require a separate explicit budget.

## Self-review

The design incorporates both accepted interaction choices and the selected inline desktop/mobile layout. Draft intent and alternate advice have distinct roles; generation is separate from application and sending. Existing pending-question behavior is preserved. SDK details and test execution belong to the implementation plan, not unverified claims of existing capability. No release or quality/speed target is claimed achieved by this document.
