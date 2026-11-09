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
| Mounted plan focus                         | thread-plan-focus registry → useThreadPlanFocus; native/SDK focus props and experimental_focusThreadPlan                          |
| Available form height                      | thread-plan-layout observes external pane/scrollport height and real container width, with viewport fallback                      |
| Native question custody                    | plan-editor-ownership; UserQuestionInteractionContent; QuestionForm and existing question-form-draft; native interaction mutation |
| Visible editor eligibility                 | plan-surface-visibility checks mounted ancestors for both plan and native editor claims; shared by the focus controller           |
| API discovery                              | API audit, Plugin Guide surfaces, CLI thread-inspection guide and command index                                                   |

The old relative-age timer and progress counters were removed from ThreadTodoCard. Its stories and focused tests use the canonical snapshot renderer. Core and plugin consumers use the same renderer and resolver. Context-clear, explicit empty-clear, archive/environment guards and service-turn failure suppression retain their existing meaning.

## Compatibility and daemon decision

No database table, migration or rewritten event history is introduced. Stable IDs live in the existing plan event JSON and are optional. Needs input is derived from native pending IDs; it is never a persisted tool status.

Protocol **259 is retained deliberately**. The implementation changes no daemon wire envelope. The previous baseline domain schemas were extracted from the exact base commit and replayed against legacy and identified/failed events: the new reader accepts old JSON, the old reader accepts additive JSON (retaining step text, failed status, note and actor), and new IDs round-trip. Bounds and duplicate IDs are rejected. The previous daemon's dynamic-tool schema accepts the new definition and its opaque tool-call argument schema preserves identified/failed arguments. The `bb_update_plan` event is written by the server, after the daemon forwards the existing opaque arguments. Nine assertions passed in the compatibility probe; the parent retains its command/output with the candidate.

This source/schema proof does not replace the parent's installed exact-pair upgrade/rollback and native lifecycle verification. No daily release, lab, e2e, merge or remote publication is performed by the core builder.

## Focused verification

Use Turbo's normal typecheck/build targets for app, server, CLI, domain, DB, thread-view and Plugin SDK. The app's normal compound test script forwards command arguments only to its second Vitest process; `test:focused` provides a scoped Turbo target for source tests. It uses the same shared-worker Vitest configuration. Tests protect identity, history/clear boundaries, off-window lifecycle anchors, complete batches and native event invalidation, container disclosure and native draft handoff. Parent integration owns product screenshots, final independent review and installed lifecycle gates.

The focus controller accepts only mounted visible native overlays for the requested thread, preferring a focused pane. It checks pending native IDs before changing local disclosure state. A monotonic request token permits repeated focus and local Skip reopening while preserving the existing native draft. Panel focus props use the same internal focus request model; absent/hidden overlays return false for the public method. No navigation, resolve or browser event is sent by focus.

The component's optional positive `focusSerial` is consumed once per changed value, including counter wrap. With `focusInteractionId` it waits for both the plan and native payload; without an ID it needs only the plan, then targets its current failed step or disclosure. Legacy ID-only requests remain supported. Hidden/stale/foreign requests are refused. Data refresh and container resize cannot reopen or refocus a consumed request, and a hidden component cannot redirect its request into another overlay.

Escape flushes the disclosure collapse and native editor custody handoff before focusing the disclosure. The native fallback form mounts with textarea autofocus during handoff; focusing before that commit allowed the fallback to steal focus. Regression tests include the real AppCommandProvider, question host, fallback banner, native draft and composer command handler for both anchored and unbound questions.

Form height comes from the external owning chat pane or scrollport, never the plan's content height. Panel/embedded roots retain their own width measurement for the 640px cutoff. ResizeObserver tracks the width source and external height owner; viewport resize also updates the bounded fallback when no observer or pane exists. Long question bodies retain bounded scrolling. Installed panel geometry and Escape acceptance remain parent gates.

## React Compiler store boundary

Editor custody requires a mounted visible surface. The shared eligibility hook observes only the editor root and its ancestor chain for visibility attributes, classes/styles, reparenting and closed details, plus viewport resize; it never scans the document or polls. Hidden/maximized surfaces release claims and native fallbacks use the same eligibility rule. Visibility is independent of the editor body's height so an empty native wrapper can become eligible before its form mounts. Hiding drops an old requested priority and consumes its focus intent; showing can reacquire normal custody without replay. Plan form mounts do not autofocus: explicit focus requests use the shared controller, while the native form keeps its existing autofocus policy. Real form/command tests preserve drafts across requested panel → visible panel → native fallback and back, including initial hidden mount and unmount cleanup. These source/compiled tests do not establish installed visibility acceptance.

The plan cache publishes immutable snapshots containing plan data, errors, loaded IDs and active subscription membership. `useThreadPlans` derives every returned data/coverage field from the snapshot returned by `useSyncExternalStore`; no mutable cache or membership read participates in rendering. Discarding that hook result allowed React Compiler to reuse the initial loading result even after successful responses and store notifications.

The normal `test:compiled` target applies the same `cachedReactCompiler` preset as the app build and includes the plan hook and editor-ownership regression tests. The hook tests protect initial load, same-ID plan/native-input updates, error recovery, graph changes and cached remount coverage. The ownership hooks return their observed boolean directly; compiled priority, enabled/key and unmount handoff coverage protects that boundary. Source-only tests did not expose the original compiler memoization failure. Installed browser acceptance remains a parent gate.
