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
a compact work/attention overview or a selected section with attention. Native React providers,
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

The Ledger strip labels each section and renders counts in tabular numerals.
Selected buttons join the raised panel visually; hover and keyboard focus remain
distinct. On narrow composers secondary labels yield to icons and counts while
accessible names and title hints retain the full label. Horizontal overflow stays
inside the strip, and sources beyond its five summaries are selectable through
its +N disclosure. Arrow keys, Home and End move between summary controls without
changing the selected section.

Clicking the selected summary collapses the panel and returns focus to that
button. Clicking another switches content in place. Escape restores the opening
summary, or the main disclosure for overflow selections. Programmatic reveal
always opens the requested section. The preferred attention source remains visible
beside any selected content. Native question actions still hand focus to their
existing form owner.

The panel has no duplicate title bar or footer navigation. The child-thread source
omits its internal disclosure chrome only inside the dock; its native rendering
elsewhere is unchanged. The panel uses the shared popover layer (z-index 50),
above split workspace controls (40). The external disclosure has a 32px hit target.
Opening and section switching use short fades only when reduced motion is off.
