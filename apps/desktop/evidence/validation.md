# Standalone editor technical evidence

Task04 composes reviewed integration `80b0ede184205b9fff1d633d19426c2bf9671688` (#11) and independently cleared import/create followup `71f272d354359f8d5e1cff7a9f57159325eeabc5` (#13). The original app PR was stacked on `fix/editor-native-import-dialog`; [the R1 follow-up](app-r1/review-r1-response.md) consumes editor473e0fe (PR16) and retargets it to `fix/editor-filename-maps-and-menu`. Coordinator registration `4e32f72d999247d3f3c25e97e06da551f0b5cb98` adds only 22 lockfile lines and 5 workflow lines. All were normal merges; the preserved editor branch remains `3c7f0c3daf337753bbca10df495264af28b280eb`. App authorship is limited to `apps/desktop/**`.

This is an unsigned macOS Apple Silicon technical proof, with **PENDING HUMAN ACCEPTANCE**. It is not an approval of signing/distribution, OS gestures, VoiceOver or physical durability.

## Final checks

| Check | Evidence |
| --- | --- |
| Frozen install | `bun install --frozen-lockfile`, unchanged after exact coordinator registration |
| Diagnostics/public tests |12 uncached Nx typecheck/lint/test tasks across desktop/application/editor/workspace; desktop5 +application14 +editor106 +workspace91 tests |
| Real module integration |15 typed public controller→shared client→WorkspaceLive cases with actual files/Git/SQLite/native helper |
| Actual Electron |25 journeys through sandboxed preload/IPC and real workspace resources, no skips |
| Actual package |Unsigned `.app` launches under `PATH=/usr/bin:/bin`, fresh explicit data and no provider environment; actual read/edit/Save, Git comparison, rg lookup, New File and token import |
| Renderer |Actual Vite graph:1,585 inputs; no Node/Electron/workspace/Effect runtime/Pi/SSH/connection/reference implementations; application/client+Monaco present, five workers/font built |
| Package assets |Executable helper/rg outside asar, five workers/font inside renderer; automatic package/release notices and upstream Electron/Chromium notices. [Actual hashes/modes/versions](packaged-resources.json) |
| Foundation |40 frozen source hashes/UI/browser contracts; no live escode/source edits |
| Whitespace |`git diff --check` |

Lint is TypeScript diagnostics, as in the foundation. Vite's existing large-chunk advisory and electron-builder's unsigned/default-icon messages remain. No startup/performance benchmark or signing claim is made.

Final commands (from repository root):

```sh
bun install --frozen-lockfile
bun run check:foundation
NX_DAEMON=false MOONBASE_TEST_RIPGREP="$PWD/dist/tools/ripgrep/rg" \
  bunx nx run-many -t typecheck lint test --skip-nx-cache --outputStyle=static
MOONBASE_TEST_RIPGREP="$PWD/dist/tools/ripgrep/rg" bun run test:editor-integration
NX_DAEMON=false bunx nx run @moonbase/desktop:build --skip-nx-cache
node apps/desktop/scripts/check-renderer.mjs
bun run --cwd apps/desktop test:desktop
NX_DAEMON=false bunx nx run @moonbase/desktop:package --skip-nx-cache
bun run --cwd apps/desktop test:package
```

The preexisting qualified rg preparation is `node scripts/prepare-ripgrep.mjs`; the Nx build dependencies compile the public native helper. Raw local logs: `/tmp/moonbase-task04-{nx,integration,nxbuild,build,desktop-final,package,packaged}.log`. Test results/traces/generated resources are ignored. Committed captures and resource records are explicit evidence copies; running the suites does not rewrite those tracked records.

## Actual application preservation and transport cases

The original 20 Electron journeys cover:

1. Custom-scheme sandbox, absent renderer `require`/`process`, actual file edit/Save.
2. External conflict, Compare/Cancel/Overwrite/Reload; normal/staged/unstaged share working text, sidebar switching preserves it and Save leaves the Git index intact.
3. Window close/hide retains mounted history: undo reaches the pre-hide baseline and redo restores the draft. Native Quit Cancel retains edits; a later captured Quit Saves A then Cancels B, retaining A's disk fact and B's draft. Final consented Save exits, leaves no watcher/cancel listeners and releases SQLite for a new writer.
4. Real second-connection SQLite lock vetoes Quit Discard. Exact resolution retains the tab; fresh explicit Quit choice is required and the window remains editable.
5. Forced fixture-process restart restores dirty staged text, its working baseline and current comparison.
6. Controlled lost committed Save response retries the identical original input. Native saved inode stays unchanged; newer live edits enter durable recovery.
7. Real foreign webContents and wrong current document reject IPC; unknown commands/inputs, unapproved roots, foreign caller/targets and traversal reject. Navigation/popups reject; a local srcdoc frame has no preload bridge, while loading the app document into a frame produces an actual frame-src CSP violation.
8. Actual native capture issues opaque picker tokens, imports real bytes, rejects token reuse and fake File paths. A genuine selected File crosses webUtils/preload/main capture and imports through the public command.
9. Controlled clipboard fixture requires native confirmation; Cancel performs no clipboard read. Consented fixture data enters the common destination/import flow.
10. Actual UI New File, dirty rename and copy; a lost move response resolves by status without a second mutate; copied dirty text saves only its destination.
11. Previews/Keep Open, many long tabs, actual Close/Reopen typing, MRU and visual-order typing/reorder, narrow window, zoom and keyboard-only menus/lookup.
12. Native macOS Trash moves only a unique temporary fixture; returned inode/content are verified before exact fixture cleanup. Its dirty draft remains accessible at the original path.
13. Lost final Quit publication plus unavailable exact status leaves window/live text and resolve controls. Its already committed consent is resolved only by the original exact receipt; no native write repeats.
14. Cooperative command cancellation crosses real IPC; an unrelated ID cannot cancel it, and subsequent IO remains usable.
15. Two Git-linked checkouts keep same-path dirty drafts independent; Cancel/Discard checkout close and native reopen retain exact known metadata without restoring consented discarded text.
16. Single-file picker and File-backed synthetic drop share the public module's destination dialog; blank single destinations are disabled and bytes arrive at the explicit path.
17. Unacknowledged actual move restores dirty text/baseline in a fresh process without any new mutate dispatch; inode unchanged and observation acknowledged after publication.
18. Consented replacement cannot overwrite an open dirty destination. Both drafts/disk files stay intact and no native mutation is admitted.
19. A file literally named `checkout` persists/saves correctly; recovery-map keys are data rather than authority fields.
20. A native Quit before renderer startup waits for editor readiness and reaches the same preservation/teardown flow.

Two additional explicit user-flow probes exercise immediate native Open→Find→fill and a held initial directory-listing reply released after fill. Both passed five repeats each without sleeps, with dialog/focus/selection transitions and actual IPC inputs/results recorded in [the probe evidence](rapid-lookup-probes.json). The original isolated dismissal remains unexplained; these bounded passing probes do not causally clear it. Traces/screens for all ten are preserved locally in `apps/desktop/evidence/test-results/rapid-probes`; the committed [immediate](rapid-lookup-immediate.png) and [held-discovery](rapid-lookup-held-discovery.png) captures show actual typing after successful opening.

The test-only main entry wraps public `ipcMain` delivery and records counts. It is not bundled. Native directory/file dialogs are supplied controlled return values; actual workspace/files/Git/SQLite/helper operations execute. Clipboard's API is replaced with fixture objects, so the user's clipboard is never read/written. A real selected File plus synthetic drop exercises the bridge; OS drag gestures remain manual. Restart tests deliberately kill only their fixture process after observing persistence, not a machine/power-loss simulation. Native Trash cleanup never enumerates or deletes other Trash items.

## Frozen twelve-example map

| Source example | App proof / scope |
| --- | --- |
|1 Independent workspaces |Two exact Git-linked checkouts, dirty paths and native close/reopen; process restart/comparison recovery; underlying reviewed multi-checkout integration |
|2 Preview/promotion |Actual Files preview/Keep Open and retained long tabs; module's full replacement/promotion regressions remain in the reviewed prerequisite |
|3 Shared views |Actual staged/unstaged/conflict/normal text and explicit Save/index check |
|4 Sidebar/Chats |Actual Files/Diff switching; Chats intentionally excluded by task04 |
|5 Opening paths |Native approval, ranked lookup keyboard focus, creation, retained missing dirty target after Trash; invalid/outside inputs reject |
|6 Order/overflow |Actual long-tab overflow, native zoom, MRU/visual navigation and tab-order menu |
|7 Close selection |Actual keyboard Close to survivor, Reopen typing and native window hide; full MRU/empty/inactive-close module regressions remain prerequisites |
|8 Dirty/bulk close |Actual native Quit Save/Discard/Cancel, earlier Save/later Cancel, SQLite veto and unknown final publication; reviewed real captured-close integration |
|9 Reopen |Actual keyboard close/reopen with typing; explicit discarded text stays absent on checkout reopen; restart recovery |
|10 Restoration |Actual dirty staged restoration against current Git original; current read/Reload and shared views |
|11 Filesystem outcomes |Actual creation/move/copy/Trash/import, dirty destination veto, response loss/status and uncertain restart without replay |
|12 Keyboard/accessibility |Actual Monaco typing after lookup/navigation/Close/Reopen, native Quit, keyboard menus/dialogs, narrow/zoom captures; VoiceOver pending |

This maps composition evidence without calling inherited component tests new native proof. No chat placeholder or feature coupling was added.

## Captures and resources

[Capture metadata](screenshots.json) records actual window bounds, viewport, DPR, zoom and PNG dimensions. All data is controlled temporary fixture text: baseline a.ts with HEAD/index/WORKING variants, b.ts, seven long component names, a copied file and the named package fixture. [Normal](normal.png), [restored staged draft](restored-diff.png), [constrained tabs](constrained-tabs.png), [zoom](zoom.png), [keyboard](keyboard.png), [keyboard dialog](keyboard-dialog.png), [keyboard menu](keyboard-menu.png), [dirty collision](collision.png), [packaged app](packaged-editor.png) were opened for inspection. They are actual Electron captures.

The helper and rg resource hashes match their qualified inputs (helper `3b1431e…`; rg15.2.0 `a326a1fb…`). The renderer static assets, executable permissions, SQLite-compatible bundled Node24.22.1/Electron45.1.0, notices, asar hash and zero worker errors are recorded in `packaged-resources.json`. Five local worker scripts are constructed under package CSP; actual TypeScript/diff editing also exercises Monaco. This does not qualify every language feature.

## Findings corrected during implementation

- The initial owner renderer audit (also caught by coordinator registration audit) used esbuild's default IIFE against top-level await. It now audits the actual Vite graph/assets; no fake worker resolver, source alias or assertions removed.
- Actual production UI exposed empty source inspection for creation and an empty single-import destination. Both were fixed and independently cleared in separate owning PR13, then consumed here through public exports. No app-side service workaround or duplicate import dialog exists.
- Console auditing exposed a bundled dev-only StyleX runtime requesting unavailable virtual CSS. The production entry no longer imports that helper; static StyleX output stays present. Asset queries are safe versioning, while IPC still requires the exact document URL. Unexpected console/page/worker errors now fail the tests; intentional security-test CSP refusal is identified separately.
- The frame fixture initially assumed frame-src prevents srcdoc text from rendering and passed or failed depending on when it sampled the provisional document. [CSP inheritance](https://www.w3.org/TR/CSP/#security-inherit-csp) governs local srcdoc content. The corrected actual test awaits srcdoc load and proves no preload bridge; a separate app-URL iframe produces frame-src/ERR_BLOCKED_BY_CSP (three repeats pass). The original 21/22 failure/trace are preserved locally. Production policy is unchanged.
- Screenshot inspection found portal dialogs inheriting Times from the document body. An actual computed-font assertion failed before applying the existing public document recipe at the body root; portal typography now matches the workbench. Native capturePage preserves the full zoomed viewport (the earlier Playwright CSS-scaled capture was cropped).
- Generic recursive authority checks wrongly treated a filename-map key `checkout` as a target; the actual red/green regression now persists that file. Approval checks are on explicit input targets and the recovery registry; full domain/recovery validation remains in WorkspaceService.
- Early native Quit was lost before renderer listeners existed (actual causal red). Main now retains the request until the loaded editor registers readiness. A consented renderer becomes inert before disposal. Watch and command capacity are separate, and cancellation cannot free/reuse another in-flight reservation prematurely.

Fixture corrections were not counted as product fixes: dirty tree labels include `, unsaved`; diff readiness uses its accessible original textbox rather than ambiguous nested CSS classes; native file existence can precede dialog/publication completion, so drop waits for that dialog to close; the two-checkout test waits for the chosen checkout selection; initial lookup waits for the selected checkout and first listing before exercising storage behavior; lost-Save inode sampling waits for first native commit; explicit move-status testing holds observation delivery until the status gesture because a live watch may legitimately resolve and remove that transient button first (the initial 21/22 run and trace are retained locally); Monaco undo is grouped by words, so bounded undo/redo checks reach the actual baseline. Cleanup uses `finally` and only owned fixture PIDs/data.

## Remaining gates

One rapid Open checkout→Find file attempt during initial discovery dismissed the lookup before its result; the subsequent storage-focused fixture waits for selection/listing. This initial gesture observation was reported to the module owner and remains for independent app review. Its [original raw failure log](rapid-lookup-original.log) is committed unchanged apart from ANSI color removal and trailing-space trimming; the full run was 19/20. A subsequent storage-focused run passed all 20; the separately instrumented immediate/held probes then passed 10/10. Those results do not erase the original observation.

Independent app review and hosted checks are pending at publication; the child does not watch/poll them. The package is unsigned/unnotarized and uses the default Electron icon. Real OS picker/Finder clipboard/drag gestures, Finder Put Back, VoiceOver/full-app accessibility, physical disk-full/power-loss behavior, performance, distribution and human product/visual acceptance remain **PENDING**. No provider quota, SSH host, user clipboard, legacy state, source checkout, deployment or GitHub PR merge was used. Local acknowledgements and controlled reply loss do not establish external exactly-once or physical durability.
