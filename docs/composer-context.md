# Composer context

The thread footer presents passive work and context in one 32px summary joined to
the editor. Its disclosure opens above the summary without contributing to footer
height. A full thread and an embedded panel use the same composition.

`ThreadScreen` owns one `ComposerContextProvider` per thread. Only the footer plan,
question navigator and `FollowUpPromptBox` banner sources enter
`ComposerContextSources`. Transcript content and active native approval/question
editors are outside the passive collection scope. Only the footer composer opts
into `contextHost`; sent-message and queued-message editors cannot attach a
second dock or replace its focus/navigation handlers.

`ComposerContextItem` registers typed presentation metadata and renders its native
content into a stable portal target. `ComposerContextDock` places those targets in
a structured work/attention overview or a selected section. Native React providers,
local state, handlers and data subscriptions remain with each source. Closing the
disclosure detaches its content targets; it does not unmount their native React
subtrees. Store/source scopes end inside a contribution, so an inline queue editor
cannot become a second host for the thread's context. Unmounting a source removes
its fact, and changing threads replaces the store. No context facts are persisted.

Native stack cards pass explicit category/icon metadata through `PromptStackCard`;
uncategorized extension content has an accessible context fallback. The plan and
native question navigator explicitly opt into the overview; mount order does not
let child threads or machine status replace them. Native detail rerenders publish
summary metadata only when that metadata changes. No labels or
rendered text are parsed to infer product state. The extension host observes its
own content root for child presence, matching the native empty-card behavior:
a plugin returning null, or a dialog that only portals elsewhere, creates no badge. Bundled Git/PR context segments and
composer banner extensions keep their current SDK registration paths. This is an
internal app presentation change with no public SDK or CLI additions; plan,
questions, queue and commands continue to use their existing read/action APIs.

The panel uses the existing nonmodal Radix positioning primitive to escape footer
clipping, anchored to the summary at full composer width. This is an attached
composer disclosure, including at narrow widths, rather than a navigation menu.
It neither adds app-root inertness nor moves the editor. Escape closes it and
restores the opening control. Opening it leaves editor focus alone; native Answer
navigation closes it without reclaiming focus from the question form.

`ThreadComposerPlan` uses the native plan query/cache, pending interactions and
focus registry. The summary retains failure/waiting signals. Answer controls refer
only to pending native questions and delegate to the existing native form owner;
they do not duplicate its editor. Programmatic plan focus opens the disclosure and
focuses the failed row when present. Background/service turns do not create a
running spinner. Archived/destroyed-environment plan facts stay hidden.

Verification lives in `ComposerContextDock.test.tsx`, `ThreadComposerPlan.test.tsx`
and the existing footer, question, plugin and banner integration suites.
`FollowUpPromptBox.stories.tsx` provides the Before/After component scenes with the
production composer, queue, child-thread and context renderers. These scenes are
frontend fixtures, not live-server or release acceptance.

Clicking a selected summary section collapses its disclosure and leaves focus on
that summary button, including when the section was selected from the panel
footer. Clicking another summary section switches the content without closing.
Footer buttons remain selectors; programmatic focus/reveal always opens its
section. The main disclosure button closes to itself, while Escape and the header
collapse action restore the recorded opening control. Footer selection records
the matching summary button (or main disclosure for sections not in the summary)
as its external return target. The panel uses the shared
popover layer (z-index 50), above the split workspace panel controls (40), and its
header actions have 32px hit targets.
