# Native Reload preservation follow-up — PENDING independent review / HUMAN ACCEPTANCE

Base: standalone `4dd148ade5f279e2b3820df0325313ee08ce4f8d` (PR14).
Product/test checkpoint: `c487c8d5da7f72011b0bc3652162f4640c08c123`.
Later changes in this follow-up only record evidence/docs and remove a temporary own
ignore file; no root manifest, lockfile, CI, shared contract/UI, chat or runtime change.

## Finding and repair

Full independent R1: coordinator `docs/overnight/reviews/composition-r1.md`, original
read-only report/probes at `/Users/elliotsharpe/.t3/worktrees/moonbase/t3-95174512/apps/desktop/test-results/review-task08-r1`.
The reviewer reproduced fresh visible text loss before the ordinary150ms debounce in
standalone4dd and composition8a, source and package. This predates composition.

`EditorSnapshot.recoveryReady` now synchronously tells the shell whether the latest
capture has an accepted exact publication receipt. Local capture generations are
independent of backend CAS revisions. Every edit/view capture invalidates confirmation;
queued/in-flight writes, pending immutable work, failures and preservation veto unload.
Receipt acceptance marks only its captured generation, so an edit during the await
cannot inherit consent. Definitive failed publication also invalidates earlier consent.
No latest-revision adoption, equal-state ownership inference, dirty-buffer blanket veto,
async flush while allowing unload, timer extension or alternate persistence store.
Explicit Quit continues through its existing Save/Discard/Cancel gate.

Standalone beforeunload uses this public field. Veto leaves the document mounted.
Committed unload cancels old calls/observers through preload/controller disposal.
Renderer loss uses the existing editor session release/slot guards and retains native
approvals and the same process runtime. No chat/provider/SSH capability is installed.

## Fresh retained causal and current runs

Same committed `test/reload.spec.ts` driver for all products; only executable/main/output
paths differ. Monaco NBSP is normalized only for text assertions. Native insertText,
two paint frames, public real recovery read, then native Reload; no debounce wait before
that fresh-edit negative. Fresh real temporary Git/user-data, PATH=/usr/bin:/bin.

| Product | Input to observation | Outcome | Visible after |
| --- | ---: | --- | --- |
| reviewer-copy4dd source |18.9ms|reload|older draft (intended RED)|
| reviewer-copy4dd package isolated |17.9ms|reload|older draft (intended RED)|
| reviewer-copy8a source |17.5ms|reload|older draft (intended RED)|
| reviewer-copy8a package |142.6ms|reload|older draft (intended RED)|
| current standalone source |16.5ms|veto|fresh visible tail|
| current standalone package |18.2ms|veto|fresh visible tail|

An earlier NEW4dd packaged rerun exceeded the timing precondition235.7ms and failed
BEFORE the causal assertion. It is retained in red-reruns.json, not counted as product
RED. The separate isolated rerun above reaches the intended loss assertion.
Both current timed cases then permit a committed reload of the durable dirty draft,
retain its tail and deliberately Save it. Captures: `*-fresh-reload.png`, native1280×850,
zoom1, DPR2, PNG2560×1636, after two frames. Old/new packaged captures inspected.

Current targeted source4/4 + package4/4: fresh-tail retention; exact old observer and
actual SIGSTOP-held native read helper cancellation on committed Reload; veto cancels
NONE; renderer crash releases helper and restores durable text; reused read ID and native
approval remain usable on the same root. `*-document.json` and cleanup records include
exact IDs/PIDs. The controlled helper hold is a test-only child_process boundary,
not a replacement filesystem service. Read-only work never supplies a blanket veto.

Before adding editor-only cleanup, local source and package each observed two intended
held-read cleanup failures and one passing veto. Their original raw local files were
subsequently DELETED by the evidence error below; only tool-transcript observations
remain. Do not treat them as retained archived red evidence. The independent R1 resource
observation remains distinct: old chat observers DID cancel, editor observer/held wait
DID NOT; the owner's earlier all-three observation is retained as a different run.

Public readiness9 new cases: immediate invalidation, confirmed-dirty positive control,
edit-back does not reuse consent, queued/in-flight ordinary publication, newer edit during
flush, committed/uncommitted lost response with immutable retry, exact recovered receipt,
definitive foreign-CAS rejection stays blocked, read-only lookup/diagnostics and disposal.
The ordinary in-flight native loss window was originally a CODE OBSERVATION; these
controlled public readiness cases do not pretend to add an old native causal reproduction.

Checks (same final product bytes): frozen install unchanged;12 uncached Nx diagnostic/
test targets,226 tests (application14/editor115/workspace91/desktop6);15 real editor/
workspace integration tests. Foundation40, actual editor1570-input and desktop1585-input
renderer audits, unsigned package byte/resource/notice audit pass. Preserved editor
Electron25/25 and packaged journey1/1 pass. Chromium35 result is recorded below when
complete. Earlier type-wrapper and Electron evaluate argument/setup failures are not
product reds; the first local raw files are lost as disclosed next.

## Evidence loss correction — explicit limit

I initially put archive copies, raw logs/traces and targeted outputs under
apps/desktop/test-results. The preserved editor suite's default Playwright output root
cleared that directory BEFORE I committed them. The original owner96d74 archive COPY,
local4dd copy and initial local public/native/setup logs were DELETED. They did NOT
survive and were not recovered. The original reviewer immutable artifacts and committed
8a evidence were untouched. No product source or user data was lost.

NEW read-only copies of reviewer freshly rebuilt exact8a96d74 and4dd37ad are now under
`.overnight-artifacts/reload-r1/dist/reviewer-{8a,4dd}`, outside every runner outputDir.
Their known matching asar digests do not recover the original physical owner package.
NEW red/green runs above are distinct runs. `evidence-correction.json` inventories actual
survivors/deletions/new paths. No claim that the deleted dynamic-import setup log remains.
No binaries are committed. Every new runner uses unique explicit output paths; logs,
archive/provenance files sit outside those output directories. No ignore config change.

Current standalone asar: `2d80155594f4912c2604983e0eb16c942b479140cd81723ee113019503740df2`.
Old reviewer4dd: `37ad94c692afbde6b2b9a6afabfda6272425e98470e5557419e1b83818ba2f8d`;
old reviewer8a: `96d74c67389db0c3d41083d6b39b01f79844b60ddfeada48619625c1351e74e3`.
Exact source/test/output mappings: source-artifact.json/package-audit.json/screenshots.json.

## Cleanup and limits

Fresh retained phases in cleanup-phases.json: four intended old cases4 PIDs each,
one separate pre-causal timing failure4 PIDs; current focused source20 PIDs/package20
PIDs (four cases each), all recorded identities ESRCH and exact temporary directories
removed. No configured host/forwarder or remote effect in these standalone phases.
Full preserved suite/package use their existing teardown and a separate final scoped
process/listener audit; no invented exhaustive PID census for deleted local phases.

Historical original synthetic Trash cleanup remains UNPROVEN: no safe path/inode,
no scanning/sweeping/guess deletion. Original cc06 binary/digest remain unavailable;
4f59 reconstruction is a NEW artifact. Original lookup/Undo/Redo/Reopen/Create observations
remain unexplained/unattributed; passing repeats are not cause fixes. All22 prior editor,
13 workspace and Save-publication dispositions remain their own retained evidence.

Hosted CI still externally blocked by billing before execution; no new hosted claim,
poll/rerun/account change. Real SSH/provider/host distribution/optional assets, signing,
Intel/OS gestures/Finder Put Back/VoiceOver/manual/performance/full-volume/powerloss remain
UNRUN/PENDING. This is controlled technical evidence, not human acceptance.

Final Chromium:35/35 PASS; retained raw chromium.log. Source/package targeted4+4,
Electron25 and packaged1 counts are separate phases, not added into241 Node/integration.
