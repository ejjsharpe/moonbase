# File preservation and native safety gate

Implementation evidence for [Prove edit preservation and native file-operation safety](https://github.com/ejjsharpe/escode/issues/39), the first gate of [Specification: IDE-style Files view](https://github.com/ejjsharpe/escode/issues/38).

This slice adds Rename/move and Trash beside entries in the existing directory list. A checkout-relative destination form is deliberately the minimum integration entry: nested explorer, inline basename editing, batch selection, collision replacement, copy/import and drag/drop remain later tickets. Destinations must be free (case-only rename is supported). No operation implicitly saves except the explicit Save and Move to Trash choice.

This is the historical first-slice record. Issue 39 is accepted at `f08183d`; see [current first-slice status](#current-first-slice-status-before-the-tree-slice) for subsequent manual confirmations and [tree evidence](files-tree.md) for issue 40. Earlier pending-review statements below describe their original handoffs.

## Preservation and recovery contract

The originating CheckoutView freezes editing/closing while its operation runs. It flushes every available dirty buffer before invoking the typed project bridge. The host validates the main-frame sender, existing checkout, live project session, paths and app-state protection, captures source and checkout identities, and revalidates after native confirmation. Navigation can change the visible project without changing the operation's root.

`file-operation.json` is an fsynced, atomically replaced intent journal next to workspace state. Intent precedes filesystem mutation. It records checkout/source device+inode identity and source/destination paths. Completion is persisted before applying the path mapping to workspace drafts and selected paths; the renderer acknowledges only after rebinding models and persisting its reconciled state. Pending reconciliation blocks further mutations/saves. A filesystem success followed by persistence failure is reported as an actual applied result, so available in-memory edits can follow the disk outcome.

Startup compares actual object identities through the no-follow helper. An interrupted move with the original object at its destination maps available descendant drafts there; an unchanged source cancels intent. Ambiguous outcomes retain drafts and intent and report both paths. In particular, a crash after native Trash but before its success record does **not** infer permission to discard drafts from a missing source. Inspect Finder Trash and restore the original object/path before restarting to reconcile. There is no automatic rollback or recreation of an old path. Native file operations and workspace persistence are not one transaction; the journal bridges that handoff. Recovery remains best effort and does not promise survival of unacknowledged keystrokes or power loss.

## Supported Monaco strategy

Tested with Monaco 0.57.0. Its installed `monaco.d.ts` declares `ITextModel.uri` readonly (line 2305); `editor.createModel(value, language?, uri?)`, `getValue`, `saveViewState` and `restoreViewState` are public APIs. There is no supported resource-URI setter or text-undo-stack export/import in this interface. The implementation creates a replacement model with the destination file URI, infers language from that URI, transfers available text and saved cursor/scroll state, and disposes the old model. It preserves the loaded disk version/text separately for ordinary conflict checking. No private Monaco state is changed.

**Earlier text undo history resets.** The form discloses this before applying a move and successful completion repeats it. New text edits retain normal undo. Cursor position and scrolling survive the resource change within the session; only dirty text/baseline/path are durable recovery drafts, as in the existing lifecycle policy. The integration test types at the end of a long file, moves its parent, verifies the tail remains rendered and subsequent insertion occurs at the same position, then undoes that insertion. It also checks destination URI and TypeScript identity and extension-changing rename to JSON through DOM resource metadata read from public model getters.

## Native boundary

The C helper inherits the approved checkout descriptor. Move uses `renameatx_np` with `RENAME_EXCL`, `RENAME_NOFOLLOW_ANY` and `RENAME_RESOLVE_BENEATH`; it cannot overwrite an occupied destination or follow swapped parent symlinks. Root identity is checked before each helper invocation. Recursive preflight rejects symlinks, special files, nested `.git` and hard-linked regular files. Hard-link rejection also prevents app-state aliases inside selected folders. After recursive preflight, the helper reopens the original checkout-relative source through the no-follow checkout descriptor and compares device/inode identity immediately before rename. A replaced or relocated source is rejected before mutation. Source/path aliases are rejected so a lexical mapping cannot miss affected drafts. Direct app-state paths and folders containing state files are protected by the host.

Trash obtains a filesystem object reference from the opened source and verifies its resolved identity with a no-follow open. It also reopens and verifies the original checkout-relative source after preflight and again immediately before `FSMoveObjectToTrashSync`: identity of a relocated object alone does not establish continuing checkout authority. This native CoreServices API returns an error when Trash is unavailable, with **no permanent-delete fallback**. It is deprecated in the macOS SDK; it remains available and was exercised on the platform below. The choice avoids handing Electron's path-based Trash API a source that can be redirected after validation. Future OS compatibility must be rechecked rather than replacing it with unchecked path-based deletion.

Confirmation lists the selected absolute path, selected item count and dirty descendant paths/count. Save and Move to Trash uses content-hash conflict checking; conflicts/failures stop deletion and preserve drafts. Discard removes buffers/drafts only after native success. Native failure retains them. These are practical final check-before-mutation guarantees. An independent process can still replace or relocate the source after the final scoped check and before rename/Trash, or modify descendants after recursive preflight. The scoped identity check and native mutation are separate syscalls, not an atomic directory snapshot or a cross-process transaction. The fixes close the reproduced preflight windows without claiming that the remaining interval is eliminated. Native calls/preflight are synchronous in this small gate; large-tree responsiveness and asynchronous bulk work remain subsequent implementation gates.

## Reproducible verification

Platform: macOS 26.3.1 (25D2128), arm64; Electron 45.1.0, Monaco 0.57.0; locked dependencies installed with `bun install --frozen-lockfile`.

From this worktree:

```sh
bun run --cwd apps/desktop test
bun run --cwd apps/desktop typecheck
bun run --cwd apps/desktop lint
bun run --cwd apps/desktop build
bun run --cwd apps/desktop package
bun run --cwd apps/desktop smoke -- tests/file-operations.spec.ts tests/lifecycle.spec.ts tests/lifecycle-races.spec.ts tests/project.spec.ts
ESCODE_PACKAGED=1 bun run --cwd apps/desktop smoke -- tests/file-operations.spec.ts
```

Host operation tests use real temporary repositories, fresh Workspace/FileOperations instances and subprocess native helpers. They cover dirty descendants and baselines, occupied and protected paths, source and destination parent swaps at native execution, replaced checkout roots, case-only rename, failed Trash, interruption immediately after native rename, workspace-write failure after disk success, and uncertain outcomes retaining drafts and blocking mutations. Existing project/workspace tests cover the underlying save/path/recovery regressions.

The native Trash test actually moves a fixture folder to the current user's macOS Trash, verifies its returned `.Trash` location and unchanged descendant bytes, and removes only that test-owned fixture afterwards. Electron tests use the real Monaco/editor/IPC/native boundary, intercepting dialogs to choose cancellation/save/discard deterministically and injecting a native invocation failure. Another BrowserWindow exercises sender rejection. Packaged tests use the bundled helper and restricted PATH.

Automated results (2026-10-29):

- Full host/unit suite: **81 passed, 2 opt-in live tests skipped** (8 files passed, 1 skipped).
- Typecheck and lint: **passed**.
- Build and unsigned macOS directory package: **passed**. Existing renderer chunk-size warning remains.
- New Electron operation journeys: **3 passed unpackaged and 3 passed packaged**. They include actual native discard-and-Trash and save-and-Trash; inspected Trash bytes distinguish discarded disk content from explicitly saved dirty text.
- Applicable existing Electron lifecycle/race/project regressions: **8 passed**, including the packaged save-conflict journey.
- `git diff --check`: **passed**.

Initial runs caught test locator issues and a real save-and-Trash inode mismatch (the app's atomic save replaces the file inode); the final operation runs pass after recognizing the app's own successful save. Final-origin validation immediately before native mutation, conservative destination alias/draft checks and case-only dirty-folder rename are covered by the final host operation suite and rerun operation journeys. This evidence does not certify the full parent explorer feature. The user subsequently confirmed first-slice VoiceOver controls and Finder Put Back restoring the correct path in dev snapshot `9342650`. Restored contents were checked separately by automation, not confirmed by the user. These confirmations do not cover the new nested tree. Independent fresh ponytail approval belongs to the persistent merge agent; this implementation agent does not grant it, commit, merge, open a PR or close the issue.

## Changed files

- Host/native: `apps/desktop/host/filesystem.c`, `main.ts`, `project.ts`, `workspace.ts`, new `file-operations.ts` and `file-operation-state.ts`.
- Native build linkage: `apps/desktop/scripts/filesystem.mjs`.
- Minimum integration/editor coordination: `apps/desktop/src/main.tsx`.
- Verification: new `apps/desktop/host/file-operations.test.ts` and `apps/desktop/tests/file-operations.spec.ts`, plus `apps/desktop/host/native-races.test.ts` for the review follow-up.
- Evidence and terminology: this file, `docs/compatibility/desktop.md`, `README.md`, `GLOSSARY.md`.

Implementation is authorized by the assigned ticket and explicit user instruction overriding the historical planning-only note. The diff is uncommitted on `t3/implement-issue-38` in the isolated worktree. No implementation/review was delegated, and no issue state, PR, commit, merge or main checkout was changed. Approval to commit/merge is still withheld pending the separately owned fresh ponytail review.


## Independent review follow-up: source continuity after preflight

The first independent ponytail review rejected the native gate with two reproduced must-fix findings. Earlier passing tests did not exercise source replacement/relocation *during* recursive validation. Move validated an opened directory but renamed its now-replaced pathname; Trash used the opened object's current absolute path even when it had been moved outside the approved checkout. Post-mutation destination mismatch detection did not prevent the first mutation.

This follow-up changes exactly `apps/desktop/host/filesystem.c`, adds `apps/desktop/host/native-races.test.ts`, and updates this evidence file. The C helper now shares a final no-follow checkout-relative source identity check across move and Trash, and repeats it after validating the Trash reference, immediately before the native Trash call. No host, renderer, bridge, build-script or product-scope changes were needed.

The new tests compile the same native source into a temporary helper with `ESCODE_TEST_PREFLIGHT`. Only that build pauses once in directory preflight after opening/inspecting the original object, using inherited pipe descriptors 4/5. The production build does not define this macro and contains no synchronization protocol, environment switch or new command. The test renames the original directory outside the checkout while paused, optionally creates a replacement containing `.git/protected`, and resumes recursive validation through the already-open original descriptor. This removes timing and 15,000-file traversal assumptions from the regression.

All three tests were run before the fix and **failed because the native helper returned success**: move of the protected replacement, Trash of the relocated source with its original pathname absent, and Trash of the relocated source with a protected replacement at its old path. Test-owned Trash results from these pre-fix runs were cleaned up using the native returned paths. After the fix, each test requires native rejection, empty success output, no move destination, unchanged outside-object identity/content, and unchanged protected replacement bytes when present. It calls the native helper directly so a post-mutation host error cannot make the test pass.

Follow-up checks: **33 focused host tests passed** across native races, file operations, project and workspace; full host, Electron and packaged rerun results are included in the counts above. Typecheck initially exposed Node's fixed-length stdio tuple typing for descriptor 5; the test now uses the supported array `at` method, and typecheck/lint pass.

**Approval status:** both requested fixes are implemented and ready for a **new independent ponytail reviewer**. This implementation agent does not grant independent approval. Issue 39 remains gated; broad explorer UI, commits, merges, PRs and issue closure remain deferred. First-slice VoiceOver and Finder Put Back restoring the correct path were subsequently user-confirmed in dev snapshot `9342650`; restored contents were automated evidence only. New tree VoiceOver remains pending. The final syscall interval described above remains a practical cross-process limitation.

## Pending Agents/Files integration reconciliation

The merge agent supplied approved Files commit `934265037050d79a7f1a7ae07374b7ec6b450fb1` and Agents commit `2e453812759cde9eecab1a73e5eb3c179cc24b83` in a pending merge on `t3/implement-issue-38`. This integration changes only `apps/desktop/src/main.tsx`, `apps/desktop/host/main.ts`, new `apps/desktop/tests/agents-files-recovery.spec.ts`, and this evidence record beyond the incoming merge content.

The renderer import conflict retains both `affected`/`moved`/`reconcile` and `AgentsView`. The semantic conflict is in host lifecycle load: Agents derives `savedProjects` in memory from legacy open projects, host approvals and historical chat identities; Files recovery updates durable drafts and view paths. Returning only the reread workspace drops newly derived registration, while returning only the initial state drops recovered paths. The resolved load result combines the fresh post-recovery workspace with the derived saved-project registry. Session registration still runs before recovery so approved closed-project checkout access remains available; historical registration still grants no filesystem/chat execution authority. Renderer initialization and its existing persistence retain both results across restart. No new persistence schema or product concepts were needed.

The new Electron regression seeds real open, closed-approved and historical-unapproved repositories, a legacy workspace without `savedProjects`, saved chat text, and an interrupted directory-move handoff (disk at the destination, journal and draft still at the source). Before the semantic fix it failed because renderer-persisted `savedProjects` was undefined even though the recovered editor appeared. After the fix it checks the recovered Monaco text, destination draft/view paths and unchanged conflict baseline, derived registration from all three sources, cleared intent, unchanged destination disk bytes and absent old path. It verifies both saved chats appear in Agents, historical execution remains denied without granting an approval, and chat text remains intact. A killed-process restart repeats those assertions. The test inspects the initial renderer-persisted state before invoking any additional lifecycle load, preventing a second migration from masking a dropped startup result.

Integration checks (2026-10-29): `bun run --cwd apps/desktop typecheck`, `lint`, `build` and unsigned macOS `package` passed. The full host suite passed **82 tests with 2 opt-in live skips** across 10 files (9 passed, 1 skipped). The full combined Electron suite (`bun run --cwd apps/desktop smoke`) passed **26 tests with 1 live-Codex skip**; this includes Agents, Files, registration/authority, concurrency, navigation, lifecycle, development and packaged baseline journeys. `ESCODE_PACKAGED=1 bun run --cwd apps/desktop smoke -- tests/agents-files-recovery.spec.ts tests/file-operations.spec.ts` passed **4 tests**. Both working-tree and staged diff checks passed. The existing build chunk-size warning remained; the development HMR journey emitted a duplicate-createRoot console warning while passing its style-update assertion. No live authenticated turn or manual accessibility certification was added.

The import conflict is marked resolved in the index, and the semantic fix, new regression and this evidence update are staged for review. The merge is intentionally left pending with HEAD `934265037050d79a7f1a7ae07374b7ec6b450fb1` and MERGE_HEAD `2e453812759cde9eecab1a73e5eb3c179cc24b83`. Original Files approval does not approve this combined semantic resolution: a **new independent Ship** is required. Issue 40 and broader explorer work remain gated; first-slice Finder Put Back path restoration and VoiceOver were subsequently user-confirmed in dev snapshot `9342650` (contents separately automated, not user-confirmed). New tree VoiceOver remains pending. No commit, merge completion, push or issue closure is performed here. The main checkout and parent-owned manual snapshot `/tmp/escode-files-39-manual-9342650` are untouched.


## Current first-slice status before the tree slice

Issue 39 is accepted and closed at baseline `f08183d`, after independent Ship reviews including combined Agents recovery. The earlier pending-review and integration paragraphs above record historical handoffs. The user confirmed the first-slice controls with VoiceOver and Finder Put Back restoring the correct path in dev snapshot `9342650`. Restored contents were checked separately by automation; they were not user-confirmed. Finder Put Back does not automatically refresh Files, recorded in issue 47. The tree slice supplies explicit Refresh; automatic watchers remain deferred. None of the first-slice manual evidence certifies the new tree controls.


Issue 41 replaces the temporary checkout-relative Rename/move form with basename-only
inline Rename. Its host request validates the basename before reusing the same move
intent, reconciliation, native safety and Monaco rebinding flow. Empty create operations
use a narrow exclusive native capability. See [inline evidence](files-inline.md).
The accepted earlier text-undo reset remains disclosed before and after rename.
