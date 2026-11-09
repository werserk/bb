# Canonical thread plan implementation

Owner-approved core apply unit, based on `7f3b96b7b65e3c39da16f8f9a3cee6c656a370f3`. The behavioral spec, consumer contract, visual approval and integration gates live in the parent WProjects OpenSpec change `core-plan-needs-input`; this document records core implementation boundaries.

## Module map

| Responsibility                             | Modules                                                                                                                           |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Event identity and validation              | domain/provider-event, thread-timeline-pending-todos; server/thread-plan-tool                                                     |
| Canonical view DTO                         | domain/thread-plan, exported through the public Plugin SDK                                                                        |
| Bounded history and native anchors         | db/data/events; server/threads/thread-plans; thread-view/thread-plan                                                              |
| Public reads                               | server-contract/public-api, server/routes/threads/interactions, sdk/areas/threads, cli/commands/thread/plans                      |
| Batch coverage, revision and native events | app/lib/thread-plan-cache; hooks/queries/thread-plans                                                                             |
| Native and plugin presentation             | ThreadPlanCard → ThreadPlanSteps → ThreadTodoCard; thread-plan-state                                                              |
| Mounted overlay focus                      | thread-plan-focus registry; ThreadPlanSteps native focus prop and SDK experimental_focusThreadPlan                                |
| Native question custody                    | plan-editor-ownership; UserQuestionInteractionContent; QuestionForm and existing question-form-draft; native interaction mutation |
| API discovery                              | API audit, Plugin Guide surfaces, CLI thread-inspection guide and command index                                                   |

The old relative-age timer and progress counters were removed from ThreadTodoCard. Its stories and focused tests use the canonical snapshot renderer. Core and plugin consumers use the same renderer and resolver. Context-clear, explicit empty-clear, archive/environment guards and service-turn failure suppression retain their existing meaning.

## Compatibility and daemon decision

No database table, migration or rewritten event history is introduced. Stable IDs live in the existing plan event JSON and are optional. Needs input is derived from native pending IDs; it is never a persisted tool status.

Protocol **259 is retained deliberately**. The implementation changes no daemon wire envelope. The previous baseline domain schemas were extracted from the exact base commit and replayed against legacy and identified/failed events: the new reader accepts old JSON, the old reader accepts additive JSON (retaining step text, failed status, note and actor), and new IDs round-trip. Bounds and duplicate IDs are rejected. The previous daemon's dynamic-tool schema accepts the new definition and its opaque tool-call argument schema preserves identified/failed arguments. The `bb_update_plan` event is written by the server, after the daemon forwards the existing opaque arguments. Nine assertions passed in the compatibility probe; the parent retains its command/output with the candidate.

This source/schema proof does not replace the parent's installed exact-pair upgrade/rollback and native lifecycle verification. No daily release, lab, e2e, merge or remote publication is performed by the core builder.

## Focused verification

Use Turbo's normal typecheck/build targets for app, server, CLI, domain, DB, thread-view and Plugin SDK. The app's normal compound test script forwards command arguments only to its second Vitest process; `test:focused` provides a scoped Turbo target for source tests. It uses the same shared-worker Vitest configuration. Tests protect identity, history/clear boundaries, off-window lifecycle anchors, complete batches and native event invalidation, container disclosure and native draft handoff. Parent integration owns product screenshots, final independent review and installed lifecycle gates.

The focus controller accepts only mounted visible native overlays for the requested thread, preferring a focused pane. It checks pending native IDs before changing local disclosure state. A monotonic request token permits repeated focus and local Skip reopening while preserving the existing native draft. Panel focus props use the same internal focus request model; absent/hidden overlays return false for the public method. No navigation, resolve or browser event is sent by focus.
