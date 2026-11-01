Independent Astra R1 — task04 standalone packaged editor

RESULT: TWO ACTIONABLE P2 FINDINGS. Do not mark task04 technically clear yet.
Both defects are in the inherited public editor module, unchanged by PR14. They are
included because this review explicitly covers the entire actual packaged editor.
Fix through the editor owner/a separated follow-up, then consume the reviewed head;
do not work around them in the desktop bridge. Human acceptance remains PENDING.

PR: https://github.com/ejjsharpe/moonbase/pull/14 (DRAFT)
HEAD: 8f4a3e9daa6733b023cf84ac040943241c0bd712
BASE: 71f272d354359f8d5e1cff7a9f57159325eeabc5
BASE branch: fix/editor-native-import-dialog
Review worktree: /Users/elliotsharpe/.t3/worktrees/moonbase/t3-23880320
Review branch: t3/review-packaged-editor
T3 project: mcp:7cbe46d8-154d-422f-969f-cfaff7f0f0dd
Private origin: https://github.com/ejjsharpe/moonbase.git
All paths below are relative to this worktree unless stated otherwise.

1. [P2] A valid filename mutates the renderer's Object.prototype and disrupts editing

Locations: packages/editor/src/editor.ts:456 (primary), :24, :327, :374;
connected reads in packages/editor/src/workbench.tsx:239 and monaco-view.tsx:59.

Reproduction using the ACTUAL unsigned package, fresh data and temporary Git files:
  node dist/astra-r1-review/packaged-repros.mjs
The packaged-prototype case fails the no-prototype-mutation assertion. Minimal
user actions: open the fixture checkout, double-click the file named __proto__,
move the caret right. No injected state or private controller helper is involved.
Object.prototype has no own 'file' before these actions. Afterwards it has
file={line:1,column:2,top:0,left:0}. Actual production console reports repeatedly:
  styleq: file typeof [object Object] is not "string" or "null".
A separate built-Electron probe times out typing into this file; another preserves
a draft in a.ts first, opens __proto__, then cannot return to an a.ts editor textbox.
This establishes editing disruption, not loss of the already persisted a.ts draft,
main-process prototype pollution, or arbitrary code execution.

Root cause: positions is a normal object. positions['__proto__'] resolves the
inherited Object.prototype, so (positions[path] ??= {})[mode]=position writes to it.
fileViews has the related unsafe key issue: assigning the string 'file' to its
__proto__ setter does not create a filename entry. Later mode lookup gets an
inherited object rather than a FileView. constructor/toString passed the ordinary
UI edit/save portion, but their inherited reads also deserve safe-key treatment.

Independent public-controller causal regression (real WorkspaceLive/files/SQLite):
  node --experimental-strip-types dist/astra-r1-review/proto-public.mjs
It fails on exact HEAD, records ownView=false and polluted=true, and cleans its
own temporary directory/runtime and prototype change in finally. Uses only public
editor/state, application/runtime-client and workspace exports.

Smallest adequate fix: make filename-indexed record reads/writes own-property safe
in the editor (fileViews and positions, including restoration/reopen/remapping),
never traverse inherited values or invoke __proto__ setters. A null-prototype
initializer alone is insufficient unless restoration/structuredClone is normalized
as well. Preserve valid filenames; do not reject __proto__ at the IPC layer. Add a
public regression for open, caret tracking, edit/save and restart of these names,
plus an existing dirty sibling and an assertion that Object.prototype is unchanged.

Evidence:
  dist/astra-r1-review/proto-public.{mjs,json,log}
  dist/astra-r1-review/packaged-repros.mjs
  dist/astra-r1-review/packaged-repros/probe-results.json
  dist/astra-r1-review/packaged-repros/packaged-prototype.zip
  dist/astra-r1-review/packaged-repros/prototype.png
  dist/astra-r1-review/probe-results-initial.json (initial typing failure)
  dist/astra-r1-review/followup/probe-results.json (causal before/after)
  dist/astra-r1-review/impact/proto-impact.zip (sibling return failure)

2. [P2] Tab actions are clipped outside the viewport at supported small size/zoom

Location: packages/editor/src/workbench.tsx:361. Its Menu.Popup uses only the
unbounded overlays.popup recipe; packages/ui/overlays.ts:22 has overflow:hidden.

Reproduction on the actual package:
  node dist/astra-r1-review/packaged-repros.mjs
The packaged-menu case opens a.ts, sets the real BrowserWindow to 760x650 with
native zoom 1.4, focuses Tab actions and presses Enter, then attempts to click Close.
This fails because Close remains outside the viewport even after scrollIntoView.
The viewport is 543x441 CSS px. Popup top=-140.357, height=349.420. Close occupies
[-96.144,-52.645] vertically; Keep Open and Close Others are also above the window.
The native capture visibly cuts off the menu. This also appears in the supplied
keyboard-menu evidence; merely asserting the menu is visible and pressing Escape
does not qualify its actions. Keyboard focus can likewise land on an offscreen item.

Smallest adequate fix: bound the menu to available viewport height and give its
items a scrollable area using the existing shared recipes/Base UI positioning.
Coordinate any shared recipe change, or use the existing overlays.options bounded
scroll area within this consumer. Preserve Base UI focus/keyboard behavior. Assert
first/last menu actions are reachable at 760x650/140%, including actual click and
keyboard selection; do not mask the defect by weakening the viewport test.

Evidence:
  dist/astra-r1-review/packaged-repros/packaged-menu.zip
  dist/astra-r1-review/packaged-repros/menu.png
  dist/astra-r1-review/packaged-repros/probe-results.json
  dist/astra-r1-review/impact/probe-results.json (scrollIntoView still offscreen)
  dist/astra-r1-review/electron-results/desktop-keyboard-menu.png

Scope, standards and implementation inspection

Read target AGENTS, README, MODULES, DESIGN, GLOSSARY, full OVERNIGHT/task04/task09,
desktop README, committed checks/validation/resource/capture metadata, original
rapid failure and probe records; inspected connected application handlers/runtime
adapter/contracts, WorkspaceLive/native/recovery validation and editor public
controller/workbench/lifecycle. Consulted only frozen source snapshot provenance,
selected native sources and editor acceptance references, never live escode.

Verified merge-base equals supplied BASE, and HEAD descends from 4e32f72, 3c7f0c3,
80b0ede, 38c6c551ff0ab1108077275d223a32967f32b9f6 and 71f272d. All packages/** trees equal BASE byte-for-byte. Root changes
are exactly the coordinator's 4e32f72d999247d3f3c25e97e06da551f0b5cb98 registration
(22 bun.lock lines and 5 workflow lines), normally merged. Other diffs are desktop.
No competing shared contract/export/runtime or source-module workaround was added.

Main creates one ManagedRuntime over WorkspaceLive; WorkspaceNative and the shared
EditorClient use the same acquired service graph. UI, keyboard and IPC dispatch to
the existing workspaceCommand/workspaceWatch. Module Effects/streams own resources;
no provider/chat/Pi/SSH startup imports or global command queue were found. Package
helper resolves through the public @moonbase/workspace/filesystem export.

The boundary binds the owned window, main frame and exact current document URL.
Sandbox/contextIsolation=true, nodeIntegration=false verified in actual Electron.
Navigation/popups denied; foreign window and wrong-document calls reject. Commands
reject unknown names/fields, wrong clients and unapproved exact targets. Additional
actual IPC cases rejected foreign draft/recent targets, registry/client/view swaps,
prototype-shaped checkout objects, constructor/toString/__proto__ operations and
foreign nested mutation-source identities without changing the fixture source.
The filename issue above is in the editor's ordinary maps, not a relaxation of
main's recovery-registry or WorkspaceService authority validation.

Native paths enter only native approval/capture. Renderer call cannot select the
internal dropped-imports method, fabricated Files grant no source authority, and
actual chosen Files become scoped opaque refs. Fresh packaged cross-checkout token
use rejects Unauthorized without creating foreign.txt; the same token remains
usable for its correct approved checkout. Existing actual suite additionally proves
single use. Picker/clipboard/drop all reach the module's shared importFiles dialog.
No application-side replacement/import controller was substituted.

The fresh full Electron suite verifies hide/model/undo retention; explicit Quit
Save/Discard/Cancel; earlier Save then later Cancel; SQLite contention veto; unknown
final publication and exact resolution; lost immutable Save response/inode; lost
move/status and restart without redispatch; dirty replacement veto; exact linked
checkout identities; cancellation and remaining unrelated IO; early native Quit;
watch/IPC cleanup and subsequent SQLite access. No legacy stores or providers used.

Frame qualification and primary sources

The corrected srcdoc assertion is valid only for lack of that frame's own preload.
Fresh independent probing found typeof child.moonbase='undefined', but
child.parent.moonbase exists; a DevTools-injected child evaluation can invoke that
parent bridge and read the approved temporary a.ts. That call arrives through the
parent's preload, so its sender is the trusted main frame. This is NOT evidence
that srcdoc is an isolated capability boundary. Conversely, an inline script in
actual srcdoc was blocked by script-src with an observed CSP error, and the app-URL
iframe in the full suite was rejected by frame-src/ERR_BLOCKED_BY_CSP. No untrusted
HTML/frame-content rendering or script-injection entry was found in this editor;
no remote/cross-origin attack or CSP bypass was demonstrated. Treat this as an
explicit threat-model/evidence limit, not a third actionable product defect.

Primary references consulted:
  https://www.w3.org/TR/CSP3/#security-inherit-csp
  https://www.electronjs.org/docs/latest/tutorial/security#17-validate-the-sender-of-all-ipc-messages
W3C explains inherited policies for locally generated documents; Electron calls
for validating IPC senders, including frames. Our runtime results, rather than an
assumed absence of all inline frames, establish the bounded claim above.
Evidence: probe.mjs / probe-results-initial.json / frame-boundary.zip.

Fresh validation and exact artifact mapping

From repository root:
  bun install --frozen-lockfile
  node scripts/prepare-ripgrep.mjs
  bun run check:foundation
  NX_DAEMON=false MOONBASE_TEST_RIPGREP="$PWD/dist/tools/ripgrep/rg" \
    bunx nx run-many -t typecheck lint test --skip-nx-cache --outputStyle=static
  MOONBASE_TEST_RIPGREP="$PWD/dist/tools/ripgrep/rg" bun run test:editor-integration
  NX_DAEMON=false bunx nx run @moonbase/desktop:package --skip-nx-cache
  node apps/desktop/scripts/check-renderer.mjs
  bun run --cwd apps/desktop test:desktop
  bun run --cwd apps/desktop test:package
  bun run --cwd apps/desktop test:desktop --grep 'rapid native' --repeat-each=3
  node dist/astra-r1-review/package-audit.mjs
  node dist/astra-r1-review/package-extras.mjs
  git diff --check

Results: frozen install, 40 foundation hashes, 12 uncached Nx tasks all pass.
Tests: desktop5 + application14 + editor103 + workspace91 + real integration15
= 228 passed. Existing actual Electron suite 22/22 passed. Packaged journey 1/1
passed. Rapid repeat 6/6 passed (plus two in the full suite). These counts do not
include the newly failing regressions, and do not imply full task04 acceptance.

Additional scripts and outcomes:
  probe.mjs: nested-authority, frame-boundary and automatic-move-convergence pass;
    prototype-filenames fails; initial zoom assertion is an explained fixture error.
  followup.mjs: confirms prototype mutation; corrected 200% keyboard lookup passes.
  impact.mjs: confirms sibling editing disruption; records unreachable menu geometry.
  proto-public.mjs: fails correct no-prototype-pollution expectation through real IO.
  packaged-repros.mjs: BOTH correct regression expectations fail on the actual app.
  package-extras.mjs: actual font loading and scoped-token/resource tests pass.
Do not total diagnostic observation passes as product acceptance tests.

Build/package actually compiled and bundled the source in this isolated worktree.
The resulting unsigned ARM64 .app executes under PATH=/usr/bin:/bin, fresh explicit
user-data, no provider environment/system Node/compiler needed at execution. Tested
Electron45.1.0 / embedded Node24.22.1 and actual SQLite/files/Git/rg/New File/import.
All recorded packaged resource JSON fields equal the owner's committed record.
Actual asar SHA256 exactly matches, no cross-worktree mapping excuse needed:
  7a24f8ea0d9386307318ab8bf12b5cfee5eb855443ce16fd56e5312c785e6d6b
Main bundle SHA256:
  d8f459e5d0ee629a2a0e29dcaa92cafa1fc93d27d338c5c67912b06c4f54f44e
Helper SHA256 (executable outside asar):
  3b1431e53880081151fb7e2ca398f3534924c644d2aa240990e9f8ff5eafb3e1
Qualified upstream rg15.2.0 SHA256 (executable outside asar):
  a326a1fb48074202e9ad41e4cd1e389eeea372c8c6f7d7e80da81176d5d9430e
Dependency notices SHA256:
  7d947781e53597a8e9ef08eba28f9e0184ad08370036ddc2e28405d77c118d42

Actual Vite graph: 1,584 inputs; public application/client and Monaco present,
no privileged feature/Node/Effect runtime graph. Five bundled workers instantiate
under actual package CSP without errors, and Monaco TS/diff editing executes.
This is not exhaustive language-worker validation. Actual codicon font request:
HTTP200, font/ttf, 153228 bytes, document.fonts.load returns one face and check=true.
Asar inventory (108 entries) excludes test harness, source snapshot, sourcemaps and
both build-input manifests. Requests for renderer/module-inputs.json and
main-inputs.json in the actual package return404; private graph paths are not
shipped. Audited asar main/preload/index/notices bytes equal their build outputs.

Notices are generated from the actual bundled main/preload/Vite inputs and installed
package files, plus Electron. StyleX missing npm notice comes from the exact pinned
1fcb9a51cbecad2c82255e0f4b45cc072fa1a95a upstream license with the required hash check.
The successful rebuild exercised that fetch. Packaged Electron/Chromium and actual
qualified rg upstream notices exist with recorded hashes. No blanket escode notice
bundle, excluded third-party application helper, host schema or provider was added.
The 40-source snapshot hashes and active UI equality checks pass; the existing
native-import/filesystem reuse is explicitly provenance-documented. This is source
and shipped-input inspection, not a legal opinion or a provenance claim about
excluded files. No test stub, wheel or Docker source bundle substitutes for assets.

Prior objections — individual disposition

1. Original rapid Open→Find→fill dismissal: STILL UNEXPLAINED, NOT CAUSALLY CLEARED.
   Read unchanged original19/20 failure. Committed record contains10 probe runs plus
   2 final-suite records. Final source and main-artifact hashes match exact HEAD;
   earlier probe spec hash differs as explicitly recorded. Fresh independent suite
   and six repeats add8 bounded immediate/held successes, with traces/IO/focus.
   No new dismissal reproduced. The storage helper's initial-list wait is not a
   fix for that original user flow. No cause or certainty is invented.
2. Lost-move status button race: test-only observation outage is appropriately
   isolated to loadRecovery delivery until the status gesture; it does not alter
   native mutation/status/publication. Existing controlled explicit path passes.
   A separate fresh actual probe leaves observation enabled: a single lost real
   move reply automatically converges, remaps the dirty draft, preserves the inode,
   acknowledges evidence, and sends exactly one mutate. No workaround in production.
3. Frame fixture: corrected load waits/CSP test pass. Preserve the parent-bridge
   authority limitation explained above; neither 'all srcdoc blocked' nor 'own
   preload undefined means no authority' is justified.
4. Renderer audit: actual Vite inputs/assets are audited, not an esbuild IIFE/stub.
   1,584 graph assertion passes, production worker/font requests execute; build
   manifests excluded from asar and404 in the packaged scheme.
5. StyleX runtime/font/zoom: no missing virtual CSS request in the fresh normal or
   packaged suite; portals use the workbench font. Native capturePage records full
   bounds. Normal/constrained/many-long-tab/diff/keyboard/dialog/zoom and packaged
   captures inspected. New menu defect found in that actual visual inspection;
   not a request for arbitrary visual polish. Prototype warnings are distinct.
6. Generic 'checkout' key validation: actual checkout-filename regression passes,
   additional nested authority cases reject. Do not revert to generic recursive
   key-name authorization. Broader filename/name-confusion coverage is incomplete:
   the new __proto__ finding is in editor maps and must be fixed by its owner.

PR13 create/import fixes remain confirmed in actual New File and native picker,
clipboard fixture, File-backed drop and packaged journeys; all use the same module
importFiles flow. Reviewed save/publication/uncertain-operation protections pass
fresh repository and native journeys. The two findings above are new inherited
bugs, not claims that the prior 22 findings have reappeared.

Fixture mistakes and limits kept separate

The first custom zoom probe pressed Enter expecting a.ts even though recent fuzzy
matches precede file results by contract; logs show the selected long recent file
was opened. Corrected probe selects the exact result with ArrowDown then Enter and
passes at200%, with no application change. It also waits for actual viewport/paint
before capture; the initial immediate zoom capture was stale. This is not the
original rapid-dismissal cause. 200% layout is cramped but sidebar/editor/dialog
containers are scrollable; no second clipping defect inferred merely from a crop.
An initial asar inspection could not resolve the transitive @electron/asar from
root; the persisted audit uses its actual installed path and passes. These are
review-harness corrections, not source/package failures.

Single hosted inspection of PR14 at exact HEAD showed SUCCESS for modules:
  https://github.com/ejjsharpe/moonbase/actions/runs/41288221660/job/124793806593
  https://github.com/ejjsharpe/moonbase/actions/runs/41288167203/job/124793642594
Recorded in hosted-inspection.json; no watch/poll. T3 link tools registered all
requested PRs1/2/5/7/3/4/11/13/14. Final list confirmed all9 present, watching=false.

Evidence location and cleanup

Full report and runnable review sources: dist/astra-r1-review/.
Logs: install/foundation/ripgrep/nx/integration/package/renderer/electron/packaged/
rapid-repeat/probe/followup/impact/proto-public/packaged-repros/package-extras.
Source/artifact hashes: source-artifact.json; archive audit: package-audit.json.
Fresh full-suite captures/traces: electron-results/; package run: packaged-results/;
six extra rapid traces/IO: rapid-results/; custom traces: *.zip and followup/,
impact/, packaged-repros/, package-extras/. Each review fixture uses its own fresh
user-data/Git files and finally kills only its own process and removes those files.
The correct assertions in packaged-repros.mjs intentionally exit1 until fixed.

No implementation or tracked evidence edits, commits, pushes, PR comments, merges,
children, deployment, real provider quota, SSH access, user clipboard access or
old live stores. Review outputs are ignored files only. Final tracked tree is clean.
No review Electron/Chromium/helper process remains; no web server/browser tab or
listening port was opened by this review. Original escode was not accessed.

Unrun: actual OS chooser/Finder clipboard/drag gestures, Finder Put Back, signing,
notarization/distribution, Intel execution, VoiceOver/full accessibility, startup/
full performance, physical disk-full/power-loss and human product acceptance.
Controlled dialog/clipboard/File drop bridges and temporary native Trash do not
establish those gates. Preserve PENDING HUMAN ACCEPTANCE and both owner findings.
