# Independent Moonbase editor

`@moonbase/editor` is a reusable React/Monaco workbench. An editor instance owns its buffers, checkout/file tabs, preview, view positions, recent navigation, close history and recovery client ID. All IO enters the injected `@moonbase/application/client` commands. The renderer entry imports no filesystem, Electron, Effect runtime, workspace implementation or provider code.

## Public interface

```tsx
import { makeEditorClient } from "@moonbase/application/runtime-client";
import { createEditor, EditorWorkbench } from "@moonbase/editor";
import { configureMonacoWorkers } from "@moonbase/editor/workers";

// runtime is the process root's already composed scoped workspace runtime.
const editor = createEditor({
  client: makeEditorClient(runtime),
  clientId: "a-stable-unique-editor-window-id",
});
await editor.load();
await editor.openCheckout(rootFromAuthorizedNativeSelection);

// In the browser composition root (a bundler with ?worker support):
configureMonacoWorkers();
<EditorWorkbench controller={editor} ref={editorView}
  selectCheckout={selectAnAuthorizedCheckout}
  selectNativeImports={pickOpaqueScopedNativeReferences} />;

// Clipboard/drop entry uses the same module destination/replacement dialog:
editorView.current.importFiles(exactOpenCheckout, opaqueScopedNativeReferences);

// Native Quit, menu Quit and window-close confirmation use this same gate:
if (await editorView.current.prepareQuit()) {
  editor.dispose();
  // The composition root may now unmount and dispose its scoped runtime.
}
```

For an isolated renderer, construct the controller with the shell's validated browser-safe `EditorClient` instead of importing the runtime adapter into the renderer. Native selection callbacks are optional shell capabilities, not filesystem authority granted to renderer path strings. Native imports accept opaque references from the privileged workspace service, never raw OS paths.

`EditorWorkbenchHandle.importFiles(checkout, references): void` is a synchronous UI entry. It copies the exact open checkout and opaque references into the same dialog used by the picker. Clipboard/drop callers supply approved references, never raw source paths. Single-item imports require a full relative destination including its filename; batches choose an existing folder (blank means the checkout root). Batch replacement paths are entered explicitly, inspected and confirmed; the service checks that they name actual import destinations. Busy dialogs/preservation and unavailable exact checkouts reject visibly rather than queueing another import. Cancel dispatches no mutation; privileged token expiry/disposal remains with the workspace. `prepareQuit()` is unchanged.

Exports:

- `.`: `EditorWorkbench`, its props/Quit/import handle, `createEditor`, `EditorController`, state types and exact target key helpers.
- `./state`: ordinary TypeScript controller/types, usable without React or Monaco.
- `./workers`: optional Vite-compatible Monaco worker configuration, installed once by the browser root.
- `./memory`: `memoryWorkspace(seeds)` returns a focused `WorkspaceService` layer. Only tests/demo composition roots construct a runtime. This volatile second adapter has no native import/Trash durability or filesystem safety qualification.

Call `await editor.load()` before other operations. The supplied client ID is the recovery namespace; distinct live editor instances must have distinct IDs. The default is a new random ID. Reuse one ID only to restore that editor after shutdown. Monaco URIs also include a separate random instance ID, so even accidental namespace duplication never aliases models.

## Preserved behavior

Normal, staged (HEAD), unstaged (index), untracked and Save-conflict views share each file's working buffer. Explicit Save captures an immutable request/target/text/version. A lost response retains that request for retry and retains newer live text separately. Conflict keeps the original baseline and offers Compare, Overwrite against the observed version, Reload and Cancel. Reload and captured Save/Discard/Cancel batches publish recovery before removing drafts. A later Cancel leaves earlier successful Saves as facts and defers every proposed Discard.

Preview replacement happens only after successful activation. Editing, Keep Open, tab reorder and explicit opening retain a preview. File order, MRU/visual navigation, a bounded 20-action session file-close history, current-source reopen, per-view cursor/scroll and checkout/file tabs belong to the instance. Recovery retains known exact checkout targets/views separately from `openCheckoutIds`; persisted view keys are `checkoutId`. Closing a checkout retains its order, active file, comparison and positions without adding a file-close action. Restored open checkouts receive initial tree/Git discovery; closed metadata does not acquire IO/watch resources. Ctrl+Tab commits on Control release; Escape cancels. Cmd+Option+Left/Right follows visual order; Cmd+W, Cmd+Shift+T, Cmd+P and Cmd+S are scoped to the focused workbench and avoid other inputs/dialogs.

The tree has fixed 28px virtual rows, keyboard navigation, multiple selection, ignore filtering, reveal, create, rename/move, copy and explicit Trash. Lookup displays independently filtered recent history and ranked/highlighted matches, bound to the selected checkout or exactly the open checkouts (eight-checkout/100-result display bound). Discovery/IO errors and partial results stay visible. No Microsoft lookup scorer or old application helper is imported.

Mutations publish source drafts before effects. Only recorded successful items change references. Lost responses query the original operation status instead of redispatching; affected Save/close/mutations stay blocked while outcomes are uncertain. Dirty copies retain a separate destination draft, and dirty Trash text remains recoverable at its original target. Replacements require captured destination identity and explicit consent, and cannot replace an open destination buffer. Move resets Monaco undo history while retaining text and positions.

## Recovery and teardown contract

- Await `load()` before use and retain a stable, unique client ID for restart recovery.
- Recovery publication follows the application's [exact identity/receipt contract](../application/RECOVERY-PUBLICATIONS.md). `getSnapshot().publication` exposes unresolved identity and kind. Call `resolveRecoveryPublication()` for bounded exact lookup/original-input retry; a null lookup does not prove non-admission. Save, Reload, mutations, Close and Quit remain blocked until resolution. No latest loaded revision or equal snapshot proves ownership.
- Close and Reload retain captured drafts through preflight. Their exact final destructive receipt commits the action; later metadata errors remain visible without undoing that commit. A false Close/Quit result with pending evidence means **PENDING/UNCERTAIN**. Keep the controller mounted so the user can resolve it. Restart restores the committed state or the preceding retained drafts.
- Definitive InvalidInput non-admission releases Save/mutation identity for corrected input. Admitted or uncertain outcomes and later publication failures retain the original immutable identity.
- Known Save/move/copy facts consume only contiguous `recoveryChanges`. Acknowledgement follows valid recovery publication and never hides another client's evidence. Move collisions retain both drafts and the pending operation, including on restart. Close one through Save/Discard/Cancel, then resolve the original operation status; never replay the mutation.
- `selectCheckout(target)` selects immediately and returns a promise for guarded activation; await it when the buffer is needed. Retained comparisons load without replacing dirty text/baselines. Explicit Open/Refresh retries visible failures. Deferred Copy reads cannot recreate a deliberately closed draft/tab.
- `getSnapshot().recoveryReady` is the synchronous document-unload gate. New edits or view metadata, queued/in-flight publication, preservation and unresolved immutable work make it false. Only the exact receipt confirms the captured generation. Veto unload while false and keep the normal publication/retry path available. A published dirty draft can survive reload without Save/Discard; this flag does not replace `prepareQuit()` and its choices.
- Run `prepareQuit()` before destructive teardown. Hide a mounted editor with `hidden` to retain models/undo; unmount releases Monaco resources but retains controller text. Call `dispose()` only after committed teardown; it ends subscriptions and observations without deleting recovery or disposing the process runtime. OS force-kill cannot be vetoed.

Recovery regressions are covered in [controller tests](test/editor.test.ts), [publication readiness tests](test/recovery-readiness.test.ts), [Save receipt tests](test/save-receipts.test.ts), [filename tests](test/filename-maps.test.ts) and [browser tests](test/workbench.spec.ts). The memory adapter validates prospective recovery before committing; it does not establish filesystem durability.

## Run and evidence

```sh
bun install --frozen-lockfile
bun run --cwd packages/editor typecheck
bun run --cwd packages/editor lint
bun run --cwd packages/editor test
bun run --cwd packages/editor check:renderer
bun run --cwd packages/editor build
bun run --cwd packages/editor test:ui
bun run --cwd packages/editor demo
```

The demo creates one scoped application runtime with the memory service and two editor clients. Its controlled failure/external-writer controls are demo-only. Playwright needs its pinned Chromium installation (`bun x playwright install chromium`). Source checks/lint currently use TypeScript diagnostics, matching the foundation.

Packaged/native Electron, real filesystem/Git/SQLite workspace integration, native picker/Trash execution, complete-app keyboard/focus and VoiceOver remain unrun here. Those belong to the workspace/fan-in/desktop proofs. Human acceptance is **PENDING**. No provider, SSH, deployment or legacy-state work is included.

## Provenance and distribution

Behavior was read only from the immutable `docs/source-snapshot`, whose manifest records source revision `181097195a026d48b82758cee841ed8dd326db70` and per-file hashes/history. The frozen main entry, activation/close/memory helpers, tree/model/viewport/lookup/sidebar and UI recipes informed requirements. This package implements its state, matching, service demo and UI independently; it copies no frozen implementation file, old host type, application helper, schema or fixture. Shared UI recipes are consumed from `@moonbase/ui`. Source imports do not authorize excluded dependencies. The live escode checkout was never accessed or modified.

The active renderer uses the pinned React/React DOM, Monaco, Base UI and StyleX stack. The memory-only composition also uses Effect. The coordinator owns generation of distribution notices from package-provided licenses/notices for actual bundled assets, including Monaco workers/fonts. No manually copied notice bundle is added by this module.
