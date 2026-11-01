Paired exact-head independent review: module R10 (#4) and real fan-in R3 (#11)

What this change does: retires a recovery publication only after its identical
original retry is authoritatively rejected by CAS, preserving Save receipts and
live drafts while publishing a fresh capture. It also removes a transient-alert
assumption from the browser regression.

VERDICT: NO BLOCKING FINDINGS.
MODULE 3c7f0c3 AND REAL FAN-IN 80b0ede are technically clear for task04 continuation.
Both PRs remain DRAFT. This is not Electron/application/native or human acceptance.

Exact reviewed refs
PR #4 https://github.com/ejjsharpe/moonbase/pull/4
  HEAD 3c7f0c3daf337753bbca10df495264af28b280eb
  BASE 8557fdd0d7a71f93a6584c77430e6fde57668580
  base branch chore/recovery-publication-contract (#7)
  focused repair 449496961c29c90c7a2e3c44d0618f08ef504947 -> 3c7f0c3
PR #11 https://github.com/ejjsharpe/moonbase/pull/11
  HEAD 80b0ede184205b9fff1d633d19426c2bf9671688
  actual BASE 3c7f0c3daf337753bbca10df495264af28b280eb
  base branch feat/editor-module (#4)
Workspace prerequisite 38c6c551ff0ab1108077275d223a32967f32b9f6 is an ancestor.
Public native asset export a7a0d8861346e869a7fb8013ed2522cf2f578642 is included.
Unfinished app f33ed9004643a530aed7f04408751d933f3e9b52 is NOT an ancestor.
No app work was resumed or qualified by this review.

Exact editor tree at both reviewed heads:
  f09dae00cb3372620277732a7e8b2a0a116510ba
Workspace src at38c and80b:
  2ac98edd18552aa563b99f6d94ede0128b15f224
Workspace native at38c and80b:
  205471d245fa15369d0dc5fd7dfd3b3df542a156
Frozen source snapshot at38c/3c/80b:
  589d30ff51aed1e575982a21b87921c226fb6c60
Only packages/editor paths differ in449 ->3c. No contract, root manifest, native
implementation, dependency or export changed in that repair. refs.json records
ancestry, tree equality, exact local HEAD and clean tracked status.

Authority and scope
Fresh GPT-6 Astra xhigh review, one slot, no children. T3 thread binding is
Moonbase project mcp:7cbe46d8-154d-422f-969f-cfaff7f0f0dd, project root
/Users/elliotsharpe/Projects/moonbase, private origin
https://github.com/ejjsharpe/moonbase.git. Thread worktree is
/Users/elliotsharpe/.t3/worktrees/moonbase/t3-8ef923da,
branch t3/review-editor-fanin-heads, exact initial/final HEAD80b0ede.
The T3 project and thread APIs independently confirmed the binding; gh confirmed
private ejjsharpe/moonbase and both exact PR head/base refs and DRAFT state.

Read repository instructions, README/MODULES/DESIGN/GLOSSARY and overnight briefs,
prior paired review/reproductions, owner R1-R7/R9/R10 responses, editor README,
exact-publication contract, snapshot manifest/reference notes and connected
preservation/activation specifications, controller, UI/Monaco callers, memory
adapter, application handlers/runtime client, workspace store/service, public
integration tests, root/CI/native-asset changes. Scope is the independent editor
and actual WorkspaceLive fan-in at these exact refs, not future application code.
Assumed load is the specified personal workbench with independent editor clients
and concurrent file operations; no scale or physical-durability claims were added.

Prior paired P1: CAUSALLY CLEARED for both reviewed heads
Primary changed code: packages/editor/src/editor.ts:265-297.
The prior public reproduction is rerun unchanged against controller artifacts
extracted byte-for-byte from git at449 and3c. No tracked source is swapped.
- Memory uncertainty matrix: old449 3 PASS/1 FAIL; exact3c 4 PASS.
  The sole old failure is before-commit A publication plus already-started B Save.
- Real WorkspaceLive/Git/native/SQLite/live-watch delivery-before-commit probe:
  old449 FAIL, exact3c PASS.
- Actual second SQLite connection BEGIN IMMEDIATE around original publication:
  old449 FAIL, exact3c PASS.
- Actual Chromium with the old449 artifact reproduces retained pending
  publication, failed flush/Quit and absent newer durable text, with two Saves.
  The same sequence on current3c resolves, persists both newer texts/baselines,
  restarts, accepts actual Monaco typing and Saves again.
Logs: causal-results.json; module-module449.log, module-module3c.log;
real-module449.log, real-module3c.log; sqlite-module449.log, sqlite-module3c.log;
browser-results.json and browser-probes.log.

The repair checks Conflict only around the identical persistRecovery retry.
Query Conflict/null, Persistence, Unavailable and other ambiguous failures cannot
retire it. Workspace Store and memory both replay matching receipts before CAS;
changed request reuse is InvalidInput. The resolver never uses loaded revision
or equal state as proof. It retains known Save results/IDs and lets the existing
facts pipeline consume only contiguous known transitions after recoveryTail
settles. It neither repeats native Save nor installs a global application queue.
Rejected final Close/Reload returns false, drops its old destructive callback,
releases preservation and requires a new action. Exact committed receipts still
confirm the original outcome. Pending publications settle only captured Save IDs.

Fresh safety controls:17/17 real public-adapter cases PASS
Source fresh-r10.test.ts, log fresh-r10-final.log. First16 were also run against
the separately extracted exact3c controller:16/16 (fresh-r10-module3c.log).
These use public createEditor, makeEditorClient and WorkspaceLive with fresh
local Git/files/SQLite/native helper; transport gates control delivery only.
1-6. Committed metadata returns Persistence, Unavailable or Uncertain (including
     simulated response/cleanup loss), each with watchers on/off. Query Conflict
     does not dispatch a retry or retire the identity. Forced null status then
     triggers an IDENTICAL retry, obtaining the original receipt before CAS even
     after B advanced recovery. Native Save requests/inodes stay unchanged;
     texts and captured baselines survive a fresh runtime restart.
7-8. Repeated real SQLite write-lock failures after B commits, watchers on/off.
     Three resolution attempts preserve the same request, Save IDs and live
     text; Quit remains vetoed. Releasing storage allows rejection/rejoin and
     fresh durable text. All retries deep-equal the original captured input.
9-12. Rejected final Close/Reload followed by foreign Move of the actual captured
      target, watchers on/off. Old callback never executes. Draft and original
      baseline follow the known move; backend and restarted controller retain
      them; observer evidence clears only after publication. Fresh Cancel asks
      again; a later explicit Discard/Reload works. Zero Save replay.
13. C was started before A's failed publication. It commits during fresh A/B
    metadata after rejection. A/B confirmation clears only A/B IDs; C remains
    pending until its own gated publication. Three original Save requests,
    correct current text/baselines and durable restart; no tail deadlock.
14-15. Dispose while exact status or original retry is held. Watch count returns
       to zero; release produces no new publication, native Save or changed
       recovery. The process root remains usable until its own disposal.
16. Original publication delivery is still pending elsewhere and status is null.
    Failed retry transport cannot establish non-admission. Identity and Quit veto
    remain until the delayed original commits and its exact receipt resolves.
17. A rejected original plus a truly unrelated same-client metadata publication
    remains an unbridgeable gap. Retirement never adopts that latest CAS; both
    Save identities/live drafts remain, Discard/Quit veto, competitor sidebar
    metadata/revision unchanged and no extra native replacements.

Prior paired P2: CLEARED
Location packages/editor/test/workbench.spec.ts:306-338.
The updated test records immutable A/B requests, waits for B's Save to settle,
forces a competing flush and checks unchanged pending IDs/Retry Save before
reconciliation and actual typing. It no longer asserts the transient last alert.
Full supplied Chromium26/26; focused R9/R10 five repeats each10/10. An independent
browser probe deliberately issues three competing flushes on BOTH old449 and
current3c: the old 'Recovery revision gap' last-alert expectation is false, but
pending IDs/Retry Save, reconciliation, durable recovery, restart and typing/Save
all succeed. This isolates test reliability from a nonexistent behavior failure.
Logs ui-full.log, ui-repeat.log, browser-results.json. No sleeps or last-error
ordering are used to establish the repaired assertions.

Original production fan-in R1 P1: CAUSALLY CLEARED
The five-case real lost/reversed receipt/control reproduction yields oldc31
2 PASS/3 FAIL and exact3c 5 PASS. Ordinary sequential/concurrent controls pass
both. Lost A -> B -> retry A and reverse replies with/without actual watchers
recover; later recovery and Quit work. The prior21 public real-adapter tests also
pass at current integration, including three-file delivery, repeat known retries,
foreign move/copy, exact targets, observer acknowledgement, later new Save IDs,
unrelated gaps and disposal. Logs original-fanin-causality.json,
original-fanin-modulec31.log, original-fanin-module3c.log, prior-public-current.log.

Individual original22 finding dispositions: all PASS at reviewed exact code
The supplied public and Chromium suites were freshly run; each case below maps
to its actual reported scenario, not a generic claim of exhaustive correctness.
- R1.1 move destination collision: both drafts/evidence retained; own/foreign
  cases pass (editor.test.ts455).
- R1.2 checkout teardown: stale positions ignored, actual model cleanup/no page
  error passes (editor.test491, workbench.spec87).
- R1.3 definitive Save rejection: invalid payload is released for correction;
  uncertain original Save stays bound (editor.test499).
- R1.4 retained missing dirty tab: available without successful disk read;
  failed new open keeps selection (editor.test511,607).
- R1.5 checkout restoration metadata/history: order/active/view/positions and
  closed membership retained; no file-close history action (editor.test550-579).
- R1.6 restored discovery: initial open Files/Git/expanded roots populate without
  external change; closed targets do no discovery (editor.test524,579).
- R1.7 stale activation: explicit newer checkout selection wins (editor.test537).
- R1.8 lookup focus: Enter hands focus to intended Monaco; preview retains tree
  focus (workbench.spec65).
- R2.1 pre-existing persisted replacement drafts: both survive restart with
  retained collision evidence (editor.test618).
- R2.2 rejected mutation: no stuck uncertainty, Save/Close/Quit usable and no
  mutation effect (editor.test644, workbench.spec98).
- R2.3 restored survivor: loads current source/remembered view (editor.test658,
  workbench.spec112).
- R2.4 visual/recent keyboard navigation: actual typing plus tab-strip origin
  focus pass (workbench.spec122, both variants).
- R3.1 selection during publication: file/checkout/Quit keep newer selection and
  unrelated metadata live/durably (editor.test673-726, workbench.spec139).
- R3.2 keyboard Close/Reopen focus: actual typing, Cancel/failure, tree/strip,
  empty/hidden scope all pass (workbench.spec152,164,178).
- R4.1 vetoed close recovery loss: captured text retained through fallible
  preparation; exact final receipt commits choice; unknown and competing CAS
  remain safe (editor.test752,821,841,859,914; real contention/final controls).
  The changed competing-CAS assertion removes ONLY indefinite retention after
  authoritative rejection. It strengthens retained draft, fresh Cancel call,
  unchanged backend sidebar/write count, missing old receipt and continued
  unrelated-CAS veto. No weakened Discard or receipt guarantee was found.
- R4.2 background survivor: guarded activation on return preserves remembered
  view/current selection (editor.test791, workbench.spec195).
- R4.3 comparison focus: staged/unstaged modified inputs accept real typing;
  originals stay readonly (workbench.spec206, both).
- R5.1 in-flight observation versus Reload/pending Close: after-await preservation
  checks keep drafts/identities safe; no resurrection; ack stays completed
  (editor.test948,974,1030,1053).
- R5.2 absent selection during another preservation: success/Cancel/failure/exact
  resolution all retry actual selection (editor.test1004, workbench.spec237).
- R6.1 delayed Copy resurrection: confirmed destination close invalidates old
  materialization, with Cancel/rejection/new-intent controls (editor.test1076,
  1123; workbench.spec251).
- R6.2 restored dirty comparison: remembered originals/dirty baseline restored
  and modified inputs accept typing, empty/failure settling intact
  (editor.test1106,1152; workbench.spec273).
- R7.1 recreated working buffer readiness: staged/unstaged return/Refresh loads
  editable working buffer, preserves originals/baselines and enabled Save
  (editor.test1185-1239, workbench.spec288).

Fresh validation summary
-221 repository tests: application14/editor102/workspace91 + real integration14,
 zero failures/skips; all9 uncached Nx typecheck/lint/test tasks pass.
-26 supplied Chromium journeys plus10 focused repeats pass. Independent browser
 matrix has3 successful journeys and1 expected old449 reproduction, all with
 zero page errors (four contexts). Current publication and both competing-flush
 cases check backend drafts, restart, actual typing and a subsequent Save.
-38 additional real public-adapter cases pass:21 prior +17 fresh. Separate
 exact-artifact causal comparisons are detailed above; no old failure is counted
 as a current pass or hidden from evidence.
-Frozen install unchanged;40 snapshot hashes/UI/browser contracts pass;
 renderer isolation1569 inputs, no privileged/feature runtime imports;
 StyleX/Monaco font/five-worker build pass; whitespace and strict TypeScript
 diagnostics on review probe sources pass. Lint is TypeScript diagnostics.
 Existing Vite chunk-size advisory remains; startup/performance not qualified.
 Logs install.log, foundation.log, nx.log, integration.log, renderer.log,
 build.log, probes-typecheck.log and whitespace.log.

Commands from this worktree
 bun install --frozen-lockfile
 node scripts/prepare-ripgrep.mjs
 bun run check:foundation
 MOONBASE_TEST_RIPGREP="$PWD/dist/tools/ripgrep/rg" NX_DAEMON=false bunx nx run-many -t typecheck lint test --skip-nx-cache --outputStyle=static
 MOONBASE_TEST_RIPGREP="$PWD/dist/tools/ripgrep/rg" bun run test:editor-integration
 bun run --cwd packages/editor check:renderer
 bun run --cwd packages/editor build
 bun run --cwd packages/editor test:ui
 bun run --cwd packages/editor test:ui --grep 'R9 lost|R10 Resolve' --repeat-each=5
 node --experimental-strip-types --test --test-concurrency=1 dist/paired-r10-review/fresh-r10.test.ts
 REVIEW_EDITOR_SOURCE=./module3c-editor.ts node --experimental-strip-types --test dist/paired-r10-review/module-publication.test.ts
 REVIEW_EDITOR_SOURCE=./module3c-editor.ts REVIEW_SQLITE_LOCK=1 node --experimental-strip-types --test dist/paired-r10-review/publication-race.test.ts
 Use ./module449-editor.ts for the causal red runs. Artifacts came from git show,
 not live sibling working files. Browser probes require the local demo at4186:
 bun run --cwd packages/editor demo --port 4186
 node dist/paired-r10-review/browser-probes.mjs

Images opened and inspected at1600x1000
- Committed owner packages/editor/evidence/publication-rejoined.png.
- old449-publication.png: dirty text retained live, pending publication/Retry Save,
  blocked recovery/Quit confirmed by public assertions.
- current3c-publication.png: A dirty retained; B typed and saved after restart;
  resolved banner absent, Save present.
- current3c-competing-flush.png: successful restart/typed Save despite alert churn.
The independent dataset is three in-memory files with A/B initially open/dirty;
these pictures qualify component Chromium behavior, not production Electron.

Architecture/provenance/asset result
Shared application handlers and externally supplied root runtime remain intact;
WorkspaceLive owns domain validation/resources with scoped dependency composition.
The React/client graph remains browser-safe. Editor state and its existing local
facts/publication sequencing remain ordinary per-instance TypeScript, not another
application runtime/scheduler/event store. Long IO is not globally serialized.
No new import crosses editor/workspace implementation boundaries.
The source snapshot is immutable and all40 hashes match. No new copied source,
third-party application helper/schema/provider code, blanket notice or deletion
of required notices appears in the repair. Root integration registers existing
workspace packages without adding dependency versions. Native src stays exactly
at reviewed38c; a7 only exposes/documents the built helper asset. Public
require.resolve('@moonbase/workspace/filesystem') resolves executable Mach-O arm64
mode755; native-asset.json records path/hash. It is never imported as JavaScript.
Actual distribution notices, packaged resource location/signing and native app
startup remain task04 gates, not inferred from a source/native-helper test.

Nonblocking handoff correction
The live PR11 description still names the previous2f9/449 candidate,208 tests and
R9/R2 pending review. Its actual refs are correct and current committed
editor-publication-regressions.md records the14/221 candidate. Coordinator should
update that PR body to80b/3c, current checks and this review before handoff. This
metadata issue does not invalidate the independently verified code or block
technical task04 continuation. No PR body/comment was modified by this reviewer.

Hosted state and resource cleanup
One hosted inspection: PR4 at3c has2 successful modules checks, PR11 at80b has3;
both OPEN/DRAFT at exact requested bases. No polling or watch was started.
PR1,2,5,7,3,4,11 are linked to this thread; final list confirms all, watching=false.
T3 preview opened but snapshot twice returned exactly:
  Preview automation snapshot timed out after 15000ms.
The owned preview tab was closed; documented repository Playwright supplied the
browser evidence. Owned browser contexts/processes and local review server were
closed after checks. Fixtures dispose controllers, watchers, root runtimes and
SQLite handles, using only fresh temporary directories. No tracked changes,
implementation fixes, commits/pushes, PR comments/merges, child work, provider
quota, SSH/remote machine, source escode checkout, legacy store or user state.
Only ignored review/build/test artifacts were written. Final tracked tree clean.

PENDING / not checked
Actual Electron/main/preload/IPC/native UI, picker/drop/clipboard/Trash/Finder Put
Back, packaged launch/resource distribution/signing, physical power-loss/full-disk
durability, performance, full-app accessibility/VoiceOver and human acceptance.
Controlled real SQLite/native-file tests do not establish physical durability or
external exactly-once behavior. No future app acceptance is implied.
