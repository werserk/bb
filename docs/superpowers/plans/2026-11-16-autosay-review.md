# Autosay independent plan review

Verdict: **GREEN — sufficient to start implementation once the owner authorizes implementation.** No blocking findings. This verdict does not authorize code changes, installation, model calls, publication or release.

Reviewer: independent Codex subagent `/root/autosay_plan_review`, same inherited model/configuration; no model-diversity claim. Review date: 2026-11-16. Review skill: `/home/werserk/.bb/runtime/global-skills/24ec6a4dfca4b5978f094a546bf9607cc84c2b3d7c97aad9647893c4ad063d2e/skills/plan-review/SKILL.md`.

Subject: `/home/werserk/.bb/plugins/environment-personal-workspace/host-data/workspaces/thr_x3bqsgmuja/docs/superpowers/plans/2026-11-16-autosay.md`, reviewed before the author's announced `.ts` → `.tsx` anchor correction.

## Typed spec used

The subject already supplies the typed spec. Review targets are `goal_1`, `scope_1`, `claim_1` through `claim_6`, `invariant_1` through `invariant_4`, `decision_1` through `decision_3`, and `deferred_1` through `deferred_3`. Affected paths are enumerated per task; affected resources are the isolated fork runtime, Composer/SDK, Autosay settings and an explicitly configured generator connection. Task 6 specifies evidence and release boundaries. These distributed fields are adequate for reviewing this plan; no competing spec or implementation was invented.

Mission fit: the plan delivers a provider-independent next-user-message suggestion, editable Tab acceptance and separate sending. Its explicit connection avoids dependence on provider title/commit helpers. Model choice and live credentials remain configuration/acceptance gates; their absence does not prevent local implementation.

## Findings

### N1 — Scope the retention claim to Autosay-owned retention

- id: `N1`
- class: `note`
- breaks: none
- locator: `claim_5`; Proposed contracts and ownership; Task 5 diagnostics
- summary: The intended no-corpus behavior is clear, but “stores no prompts, replies or suggestions” is broader than the architecture: after acceptance, text intentionally becomes an ordinary BB draft and, after sending, conversation history. Configured instructions also persist as settings. Existing SDK documentation explicitly says thread drafts persist. The plan otherwise correctly separates ghost state from ordinary draft custody.
- recommendation: Qualify claim_5 as no additional Autosay prompt/reply/suggestion retention or content logging; exempt explicit settings and ordinary BB draft/history after owner acceptance. Inspect plugin storage/logs using that boundary. This is wording precision, not an additional storage feature.

### N2 — Separate automatic composer eligibility from manual CLI generation

- id: `N2`
- class: `note`
- breaks: none
- locator: `claim_6`; Task 4 generation trigger; Task 5 `bb autosay suggest --thread`
- summary: The plan clearly intends visible-composer-only automatic calls and a deliberate CLI request that never changes a draft. The unqualified “non-visible ... cases cannot generate/accept” wording could cause a test author to forbid the intended headless CLI operation.
- recommendation: State that mounted/visible/focused/render-capability conditions gate automatic generation and all draft acceptance; give manual CLI generation its explicit applicable server guards (enabled, configured, allowed project, completed context, no blocking question/approval, bounds). Manual generation must still never accept or send.

### N3 — Correct source filename

- id: `N3`
- class: `note`
- breaks: none
- locator: Verified anchors; Task 2 modification list
- summary: `apps/app/src/components/plugin/plugin-composer-host.ts` is actually `plugin-composer-host.tsx`. The author independently identified this during review.
- recommendation: Correct both references. No architectural consequence.

## Eight-question rubric

1. **Success conditions:** Claims have concrete probes: cross-provider fixtures/live runs, real-editor interaction tests, race schedules, fake transport and storage inspection. Missing live credentials must remain missing evidence, not a successful acceptance claim. N1/N2 improve literal test boundaries.
2. **Load-bearing decisions:** Unified generation, host draft ownership, explicit HTTP connection and isolated atomic SDK/plugin development are explicit. Rejected native-first/dual-generator/internal-helper approaches and their reasons are recorded.
3. **Constraints:** Isolation, privacy, permission UI, no silent fallback, no background all-thread generation, rate/concurrency/time/output bounds and release authority are named.
4. **Deferrals:** Native Claude integration, dataset retention and benchmarking are safely deferred behind the stated boundaries. Runtime connection selection is intentionally unchosen; the plan does not pretend a live model has been verified.
5. **Evidence:** Targeted current source evidence supports the proposed integration. The controller is clearly labeled new design, not a nonexistent existing API. No implementation or performance proof is claimed.
6. **Governance:** Plan follows root AGENTS.md requirements for shared core/API actions, experimental exports/audit inventory, CLI parity, Turbo and no generated declaration commits. It preserves server product-policy ownership and avoids new daemon protocol/schema scope. Execution must still follow the cited current authoring and CLI-discoverability guidance.
7. **History:** The documented rejected native-first/helper/router approaches are not silently revived. The inspected-versus-installed base mismatch is explicit and pinned worktree resolution precedes edits.
8. **Enforcement:** Invariants name contract tests, transport/storage inspections, isolation receipts or release gates. Race checks cover type-erase, request-scoped clear, stale snapshots, two panes, context/question changes and repeated acceptance. User UX acceptance remains distinct from automated checks.

## Checked evidence and limits

Read the review subject and skill, root AGENTS.md, relevant FORK.md/system-overview sections, Composer overview, QA launch guidance, actual composer handle/host and keyboard paths, SDK composer/RPC/settings contracts, thread SDK and timeline schemas. The broad combined architecture read was output-truncated; no claim is made that every unrelated architecture section was inspected.

Read-only commands established:

- `git rev-parse 5a77b30f94be` → `5a77b30f94be2d0ce7bf4d0ec43da626e03efa6e` (exit 0).
- Targeted `git diff --stat 5a77b30f94be -- ...` for backend-contract, app-contract, plugin-composer-handle and shipped PromptBoxInternal showed only app-contract, 1 insertion and 4 deletions.
- Actual plugin host is `.tsx`; existing `createCoreComposerActions` delegates through shared draft actions.
- The editor's existing keyboard path guards composition and menus before its ordinary Escape/history/send behavior.
- SDK secret settings explicitly stay server-side in a protected file; ordinary RPC offers caller abort via `experimental_signal`. Implement request ownership/cancellation using the actual context, without assuming a distinct per-tab identity exists in `experimental_caller` (it can be simply `client`).
- QA documentation confirms worktree launchers use isolated runtime directories; plain desktop uses daily data.

No network/model calls, builds, tests, live BB mutations or product edits were performed. Only this requested review artifact was written. No relevant memory entry was used. Source checks support feasibility to start; they do not establish that the unimplemented controller, privacy checks or UX already work.
