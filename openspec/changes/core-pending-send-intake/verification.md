# Subpart A review-candidate evidence

Status: partial, not ready to ship. This local snapshot is for the same independent reviewer; Addendum15 gave cf448538 a conditional source verdict with no blocker, not an all-green/ship/live PASS; this follow-up has no delta review, release authority or client enablement. The owner-authorised one-table/API exceptions and accepted fixture prerequisite are recorded in proposal.md. No B UI/SDK/CLI or C ops implementation is included.

## Checked runtime and source boundaries

Base: .161 `53f5722472e76a7c6fc4a07fdbbec7b60900373c`. Parent before A: `c2fc9cd8346076fbedc896fe73c7358c13539347`. Actual commands, loads, exits, counts and raw logs live under `/home/werserk/.bb/thread-storage/thr_2wgqz392qb/intake-A/`; phase wrapper/results under `rebase-161/`. No install/package/lab/browser/Daily/Legacy/main/remote/release operation was performed by this author.

| Check | Observed result | Boundary |
|---|---|---|
| Full DB | 63 files,673/673,exit0 | Real migrations including generated0154 and rewind/replay; DB inputs unchanged afterward |
| Final server/contract/DB typecheck | Turbo8/8,7cached,exit0 | Server fresh; DB/contract cached unchanged |
| Worker file | 17/17,exit0 | Actual outer commit vs rollback, independent lane/legacy tail, restart/replay, late receipt fencing |
| Corrected service readiness file | 6/6,exit0 | Explicit pre-start readiness, retained-reference503 and unchanged custody; no post-stop execute |
| Final full server | 4120passed,16failed,1skipped;385passedfiles,8failed,3skipped;exit1 | Remains RED.14 exact-base matches; two additional signatures below |
| Exact .161 six-file baseline | 151passed,14failed;exit1 | Every failure name and assertion/timeout text matched both broad and final candidate logs; not an all-green verdict |
| Exact .161 scrollback file | 16/16,exit0 | One paired-disposition half only; does not reproduce the candidate full-only failure |
| Candidate scrollback half | NOT RUN,guard125 at load1=17.12 | No immediate retry; pair is incomplete |
| Standalone core build | NOT RUN | Stopped on guard refusal; upstream test-generator builds do not prove it |

The14 matched .161 signatures are HOME timeout3, shipped reference length2, runtime-config tool diffs5, old question-tool lookup1, heroes tool diff1 and plugin-agent-tools diffs2. Raw exact names/errors are in runtime-161-final-1/full-failure-multiset.json and comparison JSONs. Historical .160 results are not substituted for this proof. No unhandled-error/rejection section occurred in these latest server/baseline logs; SDK child_process/deprecation/sourcemap warnings remain retained.

All13 broad-run A compatibility cases passed the final full server run. Six seam regressions, the mode/hook-context table, command/recovery/context boundary tests and existing dispatch-hooks53/53 passed. New intake files were61/62 in that full run; the one service fixture failure was then corrected and its full file passed6/6 separately. This is selected real SQLite/service/HTTP coverage with controlled provider/plugin/executor doubles, not packaged provider/Desktop or external exactly-once proof.

## Additional full-run signatures

1. `raw send intake custody > refuses a retained service reference after stop without changing acknowledged custody`: default-ready worker legitimately entered execute in the initial microtask before the test's awaited admit returned. The admission-only/pre-start test now explicitly passes readiness=false and asserts pending/claimEpoch0. Existing503 calls, exact retained row and execute0 assertions remain. The changed file passed6/6; the earlier full run remains red and was not repeated.
2. `timeline scrollback against the server (push) > streams into a scrolled-back view and ends equal to a fresh walk`: refresh observed0 timeline signals after fixed50ms. Production scheduler permits a pause based on the preceding build duration, capped at1000ms. This is a source-backed timing hypothesis, not measured causal proof. Test/hub/timeline-window source equals exact.161. The one exact-base file run passed16/16, so no runtime baseline classification is granted. Candidate pair was refused before execution. No timeout/assertion or product timing change was made.

Former held-clear/native-notification test sources, all prior red logs and exact corrective patches remain in runtime-161-broad-1, runtime-161-contract-1 and runtime-161-final-1. No queue/group/order/hook assertion was weakened. Active inline-result lifecycle is explicitly covered even after native custody releases the lane: successor may enter while original/replay await tail; stop rejects origin; restart replays native receipt without resend; late old result cannot overwrite it.

## Storage and consumer integration limits

Generated migration0154 adds exactly one thread_send_intakes table plus three indexes. Nonterminal states staging/pending/preparing/failed retain lane custody; failed heads block. Terminal transferred/cancelled/rejected rows retain identity/hash/order/receipt anchors while payload compacts. Native queue/request/first-start custody or completed standalone clear settles the parent atomically; compactFirst's compact checkpoint alone does not. No schema/daemon/dependency change beyond the approved one-table migration was introduced.

C source facts and a separate source-only artifact proposal are delivered in the author's durable review evidence. No offline packaged runtime/Desktop compatibility artifact exists in this snapshot. GET send-intakes admissionVersion1 is a network contract; overlay capabilityv1 is not an intake/offline compatibility claim. C remains blocked on real artifact generation/binding/consumption and packaged verification. B must integrate canonical observation before retiring overlays. No current data directory, pointer or service was modified to establish these claims.

## Missing gates

Candidate scrollback paired half; disposition of full-only anomaly; standalone core build; same-reviewer A verdict; packaged runtime/Desktop/upgrade/live proof; approved and implemented offline artifact/C barrier; B client integration. A review-candidate commit records these limits and does not waive any of them.

## Addendum15 S1 follow-up (separate partial checkpoint)

The worker no longer installs the unconditional 30s legacy HTTP waiter timer. Genuine failed-head settlement and lifecycle stop are unchanged. The existing post-handoff legacy-tail regression now waits 60,001ms and passed. A new real-SQLite worker regression holds healthy preparation and its follower for 60,001ms, then requires their distinct original receipts and exactly one execution each, including replay. It replaces the old contract-changing timeout test.

Fresh serial guarded commands used the existing run-phase.sh with load1<16, nice19/ionice-c3 and 45min bound:

| Phase | Actual result | Limit |
|---|---|---|
| intake-161-add15-typecheck-1 | exit0,load4.12,Turbo8/8,7cached,2.828s | Before the post-run fixture correction below; DB/contract unchanged cached |
| intake-161-add15-worker-1 | exit1,load6.95,16passed/1failed,1unhandled rejection; Turbo9/10,8cached,19.834s | New healthy-head fixture timed out at15s; no baseline label |
| Remaining affected descriptor checks, candidate scrollback, standalone build, strict OpenSpec | NOT RUN | Chain stopped on failure, no heavy retry |

The failing fixture supplied invalid creq_held/creq_following IDs to a receipt schema requiring creq_ plus10 alphabet characters. Source tracing shows parsing the stored invalid receipt can throw during settle, leaving its waiter unresolved; cleanup then rejected the still-live waiter. This is a source-backed diagnosis, not a reproduced corrected runtime result. A narrow test-only correction uses the existing request-ID generator, commits the matching original receipt, and observes both results with Promise.allSettled so cleanup cannot produce an unobserved follower rejection. Exact fulfilled values, retained pending states, order, replay and single-effect assertions remain. This correction is UNVERIFIED; no timeout/assertion weakening or production alteration was added to satisfy the fixture. The prior16 passes include real failed-head bounded409 and stop/restart/late-result coverage.

S2–S5 remain explicit risks in design.md. Generator/copy/binding is NOT implemented: the four-file offline proposal did not establish the complete launched core closure. Checked source routes include Desktop ASAR/unpacked main/bridge, bb-app installed-newer update delegation, computed plugin/SDK loads and executable copied assets/plugins added after the proposed server generator. Full path/line evidence and the missing load/selection-inventory boundary are retained in intake-A/addendum15-followup-1/OFFLINE-ENTRY-BOUNDARY.md in the author thread storage. No complete-closure or packaged compatibility assertion is emitted. Missing descriptor remains incompatible for C; the FIRST A-containing release build still requires a sound generator. A standalone source build is not a release proof, and was not reached in this commission.

Historical full-server RED,14 exact .161 six-file matched signatures and full-only scrollback anomaly remain unchanged. Isolated base16/16 does not resolve that anomaly. No new full server/DB loops, package, image extraction, live or ops edits occurred.
