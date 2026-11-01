What this change does: makes filename-indexed editor metadata own-property safe,
including restored JSON, and bounds the existing Base UI Tab actions menu. The
standalone Electron app adopts that exact module and qualifies the native package.

VERDICT: NO NEW BLOCKING PRODUCT FINDINGS at the two exact heads below.
Both original app R1 P2 defects are freshly reproduced on the old actual package
and causally cleared on the current actual package. This is technical review,
not human acceptance, signing/distribution approval, or a clean hosted-CI claim.
Original rapid-lookup uncertainty and the fresh validation observations below
remain explicit. Both PRs remain DRAFT; I changed neither their state nor code.

EXACT REFS / AUTHORITY
PR16 https://github.com/ejjsharpe/moonbase/pull/16
 HEAD 473e0fe03f6c5fc34fd8282fab4875c20f143ac2
 BASE 71f272d354359f8d5e1cff7a9f57159325eeabc5 (fix/editor-native-import-dialog)
PR14 https://github.com/ejjsharpe/moonbase/pull/14
 HEAD 4dd148ade5f279e2b3820df0325313ee08ce4f8d
 BASE 473e0fe03f6c5fc34fd8282fab4875c20f143ac2 (fix/editor-filename-maps-and-menu)
Normal adoption merge d6edd8c7d4ce9e7327593df420aaec19d9b9bf48 has parents old
8f4a3e9daa6733b023cf84ac040943241c0bd712 and exact module473. Both exact bases
are ancestors. Original editor3c and app8f remain preserved in ancestry.
The entire packages/editor tree is byte-equal at module473 and app4dd:
 b76d85691bbcb655e5d07cb989ffb5be9e243882
application/workspace/UI package trees also equal module473 at app4dd. Module16
changes only packages/editor. App root changes are the earlier coordinator lock/
workflow registration; no new root/shared/application/workspace fix was introduced.

T3 confirmed project mcp:7cbe46d8-154d-422f-969f-cfaff7f0f0dd and isolated binding
/Users/elliotsharpe/.t3/worktrees/moonbase/t3-112f2289,
branch t3/review-editor-pr16-app-pr14, project root /Users/elliotsharpe/Projects/moonbase.
gh verified PRIVATE ejjsharpe/moonbase and exact PR refs; origin is that repository.
Initial/final tracked status clean at app4dd. No implementation changes, commits,
pushes, PR comments, children, PR watch/poll, merges, deployments, real quota,
SSH connection, original escode access, clipboard access or legacy/user-state use.
All custom writes are ignored evidence or isolated temporary fixtures.

Read AGENTS/README/MODULES/DESIGN/GLOSSARY, full overnight briefs and supplied
02/04/09, original reports and current owner responses, relevant README/EVIDENCE,
source manifest/frozen editor activation/close/files/tree/lookup/sidebar references,
connected controller/Monaco/workbench/memory, application contracts/handlers/runtime
client, workspace validation/store/reconciliation/native authority, desktop
main/preload/session/wire/renderer/build/package/notices and public/native tests.
Assumed load is the requested personal editor, concurrent resource-scoped file
operations and independent recovery clients. No broader scale promise is inferred.

R1 P2 FILENAME MAPS: CAUSALLY CLEARED
- original-old.mjs is the original prior-review packaged reproduction with only
  executable/output locations changed. I copied the preserved old package into
  this worktree; its asar is exactly7a24f8ea0d9386307318ab8bf12b5cfee5eb855443ce16fd56e5312c785e6d6b.
  Opening __proto__ and moving the caret adds Object.prototype.file: expected RED.
- original-current.mjs runs the same assertions against this worktree's freshly
  built current package: PASS, no own Object.prototype.file. Both native captures
  inspected; original-old/probe-results.json and original-current/probe-results.json
  retain observations, errors and traces.
- Independently reran the original public controller/real WorkspaceLive prototype
  reproduction against a byte-exact git-extracted base71f editor and current473.
  Old: ownView=false,polluted=true. Current: ownView=true,polluted=false.
  Sources/logs/results proto-public-{old,current}.*, base-editor.ts. Prototypes
  restored in finally; each process is isolated and temporary resources disposed.
- Inspected every active filename-map read/write in controller activation,
  restoration, caret positions, conflict/reload, close history/reopen, Monaco and
  workbench. readOwn/defineProperty writeOwn works on ordinary JSON/structuredClone
  objects; no filename ban. Composite comparison/list/Git keys are JSON strings,
  not bare filenames. Existing Object.entries/fromEntries operation remaps safely
  enumerate/define own filename keys. Memory Git baselines now use own reads.
  Workspace checkout IDs come from retained native identities; its filename maps
  validate/remap using Object.entries/fromEntries. No matching backend gap found.
- public-real.mjs uses real files/Git/SQLite/native effects, two actual public
  controllers and one scoped runtime per lifetime. All four names open, Save,
  preserve file/staged/original positions, retain dirty sibling, survive runtime
  restart, close with Save/reopen, and undergo16 own/foreign moves without replay.
  It reads the actual persisted SQLite JSON and asserts own keys; Object/function
  descriptors remain unchanged. Successful evidence public-real.json/progress.json.
- package-independent.mjs independently types/Saves all four names through actual
  packaged UI/preload/IPC, moves the caret in readonly staged originals and working
  text, retains an unrelated sibling, reads primitive own-key arrays in renderer,
  then reads the real SQLite recovery row. It asserts all own mode/position keys,
  original positions and dirty/saved baselines. Raw real row retained at
  package-independent/persisted-recovery.json. Prototype descriptors unchanged.
  HTML file content containing an onerror payload is displayed as editor text;
  no img node or executed flag appears. No claim of arbitrary renderer compromise
  protection is inferred from this controlled data-path check.
- Supplied extended actual package and Electron tests separately verify process
  restart and another Save. Module106/Chromium35 include the new public regressions.
  Fresh native20-cycle staged Close/Save/Reopen probe also keeps typing focus for
  every filename (reopen-native/). No application IPC/schema workaround was used.

R1 P2 MENU BOUNDS: CAUSALLY CLEARED
- Same original packaged reproduction at760x650/native1.4 zoom: old Close click
  times out because the item is above the viewport. Current passes unchanged.
  The current actual menu composes overlays.popup + overlays.options; Base UI
  interaction remains intact. No shared recipe, dependency or positioning system
  was added.
- Supplied actual Electron and packaged checks exercise first/last Home/End,
  Enter on Keep Open/Reopen, and Close click at1280x850/100%,760x650/100%,760x650/140%.
  Native capturePage images inspected at normal/small/zoom; current first item fits,
  End scrolls the last item into the bounded popup, and Close is clicked successfully.
- Module Chromium also passes1600x1000,760x650,543x441 CSS-pixel controls. Those are
  component checks, not a substitute for the real native zoom evidence above.
  Fresh evidence: original-{old,current}/; packaged-results/packaged-menu-*.png,
  their .png.json metadata; electron-final-results/. No CSS-only proxy claim.

FRESH VALIDATION / EXACT-HEAD COVERAGE
- Frozen install unchanged;40 foundation snapshot/UI/browser-contract checks pass.
- All12 uncached Nx typecheck/lint/test tasks pass at exact app4dd: desktop5 +
  application14 + editor106 + workspace91 =216 tests;15 real integration tests
  pass, total231. No skips/failures. Lint is repository TypeScript diagnostics.
- The9 module tasks cover exact473's unchanged editor/application/workspace sources:
  211 tests +15 integration =226. This was one aggregate run in the exact app
  worktree after verifying package-tree equality, not a claimed second checkout run.
- All35 supplied Chromium module journeys pass. Editor renderer audit1570 inputs.
- Final unchanged actual Electron25/25 pass. Initial run was24/25 (details below),
  not silently recategorized as fully passing. The focused unmodified hide test
  subsequently passed3/3; the final full run is separately preserved.
- Extended unsigned actual package1/1 passes, including four filenames, restart,
  subsequent Save and all normal/small/zoom menu checks. System-only PATH,
  fresh explicit user-data and no provider environment. Embedded Electron45.1.0 /
  Node24.22.1 / actual SQLite; actual Git/rg/Create/native-token Import and5 workers.
- Independent package original-current2/2 pass; old package2 expected failures.
-8 additional fresh packaged rapid flows pass: immediate click, native
  webContents.sendInputEvent/insertText, Cmd+P/Enter, and focus bounce, twice each.
  Native picker return is controlled; these are not real human OS picker gestures.
-3 connected actual Electron probes pass: nested authority rejection matrix,
  frame/CSP/parent-bridge limits, automatic lost-move convergence (one mutate,
  preserved inode/draft, acknowledged only after publication; no observer outage).
-1 independent packaged own-key/SQLite/untrusted-data scenario passes;1 public real
  four-filename lifecycle scenario passes with16 native moves;20 packaged
  Close/Save/Reopen cycles pass. Do not sum diagnostic subassertions into231.
- Fresh package audit and actual Vite1585-input graph pass: no privileged workspace,
  Node, Effect runtime, Pi/provider/SSH/connection implementation in renderer;
  application/client and Monaco present; five worker files and font. Metadata,
  test harness, source snapshot and sourcemaps excluded from108-entry asar inventory.
  Main/preload/index/notices bytes equal corresponding newly built outputs.
- Whitespace and final clean tracked status pass. No source edits were needed.

Logs: install.log,ripgrep.log,foundation.log,nx.log,integration.log,package.log,
renderer.log,editor-renderer.log,chromium.log,electron.log,electron-final.log,
hide-repeat.log,packaged.log,original-{old,current}.log,public-real.log,
rapid-native.log,connected-probes.log,package-independent.log,reopen-native.log.
Runnable review scripts sit beside this report; each uses fresh temporary files
and finally stops its own Electron/runtime/database resources and removes its data.

ARTIFACT MAPPING
Fresh current asar SHA256 exactly matches the owner record:
 37ad94c692afbde6b2b9a6afabfda6272425e98470e5557419e1b83818ba2f8d
Old actual asar:
 7a24f8ea0d9386307318ab8bf12b5cfee5eb855443ce16fd56e5312c785e6d6b
Main bundle:
 d8f459e5d0ee629a2a0e29dcaa92cafa1fc93d27d338c5c67912b06c4f54f44e
External executable native helper:
 3b1431e53880081151fb7e2ca398f3534924c644d2aa240990e9f8ff5eafb3e1
External executable qualified rg15.2.0:
 a326a1fb48074202e9ad41e4cd1e389eeea372c8c6f7d7e80da81176d5d9430e
Dependency notices:
 7d947781e53597a8e9ef08eba28f9e0184ad08370036ddc2e28405d77c118d42
source-artifact.json and package-audit.json contain exact source/output records.
Package/resource evidence from this run is preserved in packaged-results/.
The copied old executable is only a review artifact; current build used this exact
clean worktree. No compiler, installed system Node or provider is needed to execute
under the tested restricted PATH. Build still requires the documented tooling.

ARCHITECTURE / TRUST / PROVENANCE
Main constructs one ManagedRuntime(WorkspaceLive); shared makeEditorClient and
WorkspaceNative consume the same acquired graph. UI/keyboard/native/IPC enter the
shared application handlers. Feature services own scoped native/watch resources
and domain validation; renderer state/rendering/calculations remain ordinary TS.
No additional scheduler/store/global command queue or provider/chat/SSH startup
composition found. All package boundaries remain public.

Actual IPC binds owned webContents, main frame and exact current document. Sandbox
and contextIsolation enabled, nodeIntegration disabled; wrong documents/foreign
windows reject. Explicit command targets and recovery registry constrain authority;
foreign nested drafts/recents/mutation sources, clients and roots reject before
fixture mutation. Prototype-shaped operation names reject, while legitimate
filenames remain data. Error DTO preserves typed errors, Uncertain and exact target;
public and actual IPC cancellation checks leave unrelated work usable. Persistent
watch capacity does not consume command capacity. Quit uses public prepareQuit,
Save/Discard/Cancel, storage-failure veto and exact final receipt resolution;
window close hides mounted state. Controlled complete suite verifies late/early
Quit, model/history retention, real filesystem failures/loss, native token scope,
shared importFiles flows and teardown/SQLite reuse. No renderer-supplied arbitrary
OS import path authority was added. Authorized checkout paths in UI are intentional.

Frame limit is retained, not strengthened: fresh srcdoc has no own preload, but
same-origin child code evaluated by DevTools can call parent.moonbase. Inline
srcdoc script is blocked by CSP; actual app-URL frames violate frame-src. The test
uses privileged DevTools evaluation to expose that ambient parent authority, not
to assert a CSP bypass. No untrusted HTML evaluation path was found; actual HTML
file content remained editor text in the fresh package. Navigation/popups denied.

Actual bundled inputs, not an IIFE audit/stub/alias, supply the renderer and notice
checks. Notices derive automatically from shipped inputs/installed package files;
StyleX's missing npm LICENSE is fetched at the pinned upstream release commit and
checksum-verified. Generated package contains upstream Electron/Chromium and
qualified rg notices. No manual old blanket source bundle or excluded T3/Pocket/
Codex/Microsoft application helper/schema/provider code is imported. Frozen source
hashes and active UI recipes match; existing filesystem/native-import reuse has
explicit provenance. This is source/input inspection, not a legal opinion.

PRIOR OBJECTIONS / PRECISE DISPOSITIONS
1. Original app8f rapid Open -> Find -> fill dismissal: STILL UNEXPLAINED, NOT
   CAUSALLY CLEARED. Read preserved original failure; its overwritten trace cannot
   be recovered. Existing immediate/held-discovery cases pass in both fresh full
   runs;8 new packaged native/focus flows pass. No new dismissal reproduced. None
   of these bounded successes proves universal absence or repairs the old cause.
2. Initial missing-file externalWrite filename fixture: remains a fixture error,
   not causal red. Original actual packaged and real public prototype reds above
   independently establish the old defect and current clearance.
3. Playwright whole-object reconstruction: never used as evidence that __proto__
   was lost in product transport. Fresh actual command-boundary test returns own
   key arrays; package-independent uses renderer arrays/JSON text and real SQLite
   body text. All preserve the own keys; product IPC/backend unchanged.
4. Menu setup: supplied tests await setup close, selected reopen and initial
   Base UI focus. Original direct Close repro also passes unchanged. No production
   workaround. The current .png.json sidecars keep state JSON distinct.
5. Explicit lost-move status: observation delivery gate remains confined to test
   setup until the gesture. Native mutation/status/publication remain real. Fresh
   separate automatic-convergence probe has no gate and passes with one mutation.
6. Srcdoc/local preload versus parent authority: limit above is independently
   confirmed. No stronger security claim accepted.
7. Earlier IIFE audit failure: actual Vite module-inputs used and excluded from
   archive; no stub/alias exemption. Private graph manifests are not shipped.
8. Dev-only StyleX virtual CSS removal, body portal font, capture zoom/DPR metadata:
   unchanged app-only corrections inspected. Real current native captures reviewed;
   no production hidden style/source workaround found.
9. Generic nested 'checkout' key validation: explicit targets/registry retained.
   Legitimate checkout filename test passes; nested unauthorized identities reject.
   No return to key-name-based authority validation.
10. PR13's picker empty destination and empty-source creation defects retain
    CLEARED disposition. Fresh module/integration and actual desktop/package
    creation/import fixtures pass, including replacement veto and single-use tokens.
11. Original fan-in lost/reordered Save P1 and paired R10 rejected-publication P1 /
    transient-alert browser P2 retain CLEARED disposition. Current full public,
    real integration and Chromium regressions run again. No historical red matrix
    is represented as newly rerun except the filename/menu reds named above.

Individual original22 editor dispositions retained after current suites:
 R1.1 collision: both drafts/evidence retained; R1.2 late checkout position/teardown;
 R1.3 definitive Save rejection vs immutable uncertain retry; R1.4 retained missing
 dirty tab/new-open failure; R1.5 known closed-checkout metadata/history; R1.6 initial
 open discovery/closed no-IO; R1.7 stale activation cannot change newer checkout;
 R1.8 lookup-to-Monaco focus.
 R2.1 persisted replacement drafts retained; R2.2 rejected mutation stays usable;
 R2.3 restored current-source survivor; R2.4 visual/MRU keyboard navigation focus.
 R3.1 newer selection survives publication; R3.2 Close/Reopen focus/cancel/failure.
 R4.1 fallible close preflight retains drafts and exact final receipt governs consent;
 R4.2 background survivor; R4.3 modified comparison typing/read-only originals.
 R5.1 observation vs Reload/Close preservation, no resurrection/duplicate ack;
 R5.2 selected absent buffer activates after another preservation ends.
 R6.1 delayed Copy cannot resurrect confirmed-close target; R6.2 restored dirty
 comparisons retain original/baseline and settle failures.
 R7.1 recreated working buffer readiness for staged/unstaged comparison.
All corresponding supplied public/Chromium regression cases passed in this review.
This preserves the prior individual disposition record; it is not new exhaustive
historical old-producer causality proof or a claim of physical durability.

FRESH VALIDATION OBSERVATIONS / NONBLOCKING LIMITS
A. Initial Electron run24/25: desktop.spec.ts147 timed out after its fixed8 Redo
   shortcuts; snapshot showed 'retained across'. Preserved electron.log and
   electron-initial-results/ contain the raw failure; no trace overwritten.
   Unchanged isolated test3/3 and final full25/25 pass. Independent actual package
   probes6/6 retain complete text through hide/undo/redo. Recorded per-key snapshots
   demonstrate asynchronous visible edit transitions: immediate observations can
   show pre-Undo text even while later awaited baseline succeeds. A separate3/3
   package probe awaits each observed edit change before the next shortcut and
   restores the complete text. No lost model/history/text was demonstrated.
   Initial failure is NOT causally proven to be solely the8-step cap; carry it as
   a test/native-event timing uncertainty. Owner may harden the test's transition
   synchronization without changing production behavior. This review does not
   invent a required product fix from passing repeats.
B. Public reopen observation: one initial immediate boolean assertion failed.
   Follow-up25 real live-watch cycles found4 reopen(false) returns while a competing
   activation was pending; all25 selected the right path and settled to the exact
   saved text with no error. Current reopen publishes/removes history after its
   own open attempt even if another generation superseded it. The actual packaged
   keyboard20-cycle proof reaches the intended editor, focuses it and accepts
   typing every time. No lost text or demonstrated failed user path is claimed;
   the public return-value/settling observation remains in reopen-race.json.
C. Review-fixture corrections: the first foreign-move probe used an observer before
   publishing its known-checkout registry/acknowledging previous origin facts;
   real workspace correctly refused unsettled mutation. Corrected to use a second
   public controller, flush its registry and reconcile before mutation.16 moves
   then pass. Initial native reopen probe typed before the asynchronous File->
   staged view setup had completed; it was corrected to await the actual original
   editor and focus before typing. Raw failed logs/captures are retained separately,
   not counted as causal prototype/production failures. No implementation edit.

HOSTED CI (one inspection per head, no polling)
PR16 exact473: both returned modules check runs SUCCESS (pr16.json).
PR14 exact4dd: both returned modules runs FAILURE before start (pr14.json).
Job annotation: 'The job was not started because recent account payments have
failed or your spending limit needs to be increased. Please check the Billing &
plans section in your settings.' gh job-log request returned 'log not found'.
This is an external CI/billing blocker, not a failing test conclusion. Hosted app
CI remains UNRUN/BLOCKED; no billing change or rerun was attempted.
ci-app-annotations.json retains the exact annotation and runner-capacity notice.

HANDOFF / CLEANUP
T3 linked all requested PRs1/2/5/7/3/4/11/13/16/14; final list confirmed10 present
and watching=false. No review child agents or PR watchers were created.
All owned foreground Electron/package instances, helpers, Playwright/Chromium
contexts and Vite server/process groups are stopped. No owned host/forward exists.
Port4176 has no listener; scoped final process check found no remaining review
process (excluding the inspection command itself). All fixture user-data/Git roots
were removed by their own finally blocks; only ignored evidence/build artifacts
remain. Tracked status is clean at4dd. No user clipboard was read or changed.

UNRUN/PENDING: real OS picker/Finder clipboard/drag gestures, Finder Put Back,
signing/notarization/distribution, Intel execution, VoiceOver/full accessibility,
performance/startup, physical full-volume/power-loss durability and HUMAN ACCEPTANCE.
Do not infer those from controlled dialog fixtures, temporary Trash checks,
restricted-PATH unsigned execution or this technical review.
