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

// Native Quit, menu Quit and window-close confirmation use this same gate:
if (await editorView.current.prepareQuit()) {
  editor.dispose();
  // The composition root may now unmount and dispose its scoped runtime.
}
```

For an isolated renderer, construct the controller with the shell's validated browser-safe `EditorClient` instead of importing the runtime adapter into the renderer. Native selection callbacks are optional shell capabilities, not filesystem authority granted to renderer path strings. Native imports accept opaque references from the privileged workspace service, never raw OS paths.

Exports:

- `.`: `EditorWorkbench`, its props/Quit handle, `createEditor`, `EditorController`, state types and exact target key helpers.
- `./state`: ordinary TypeScript controller/types, usable without React or Monaco.
- `./workers`: optional Vite-compatible Monaco worker configuration, installed once by the browser root.
- `./memory`: `memoryWorkspace(seeds)` returns a focused `WorkspaceService` layer. Only tests/demo composition roots construct a runtime. This volatile second adapter has no native import/Trash durability or filesystem safety qualification.

Call `await editor.load()` before other operations. The supplied client ID is the recovery namespace; distinct live editor instances must have distinct IDs. The default is a new random ID. Reuse one ID only to restore that editor after shutdown. Monaco URIs also include a separate random instance ID, so even accidental namespace duplication never aliases models.

## Preserved behavior

Normal, staged (HEAD), unstaged (index), untracked and Save-conflict views share each file's working buffer. Explicit Save captures an immutable request/target/text/version. A lost response retains that request for retry and retains newer live text separately. Conflict keeps the original baseline and offers Compare, Overwrite against the observed version, Reload and Cancel. Reload and captured Save/Discard/Cancel batches publish recovery before removing drafts. A later Cancel leaves earlier successful Saves as facts and defers every proposed Discard.

Preview replacement happens only after successful activation. Editing, Keep Open, tab reorder and explicit opening retain a preview. File order, MRU/visual navigation, a bounded 20-action session close history, current-source reopen, per-view cursor/scroll and checkout/file tabs belong to the instance. Ctrl+Tab commits on Control release; Escape cancels. Cmd+Option+Left/Right follows visual order; Cmd+W, Cmd+Shift+T, Cmd+P and Cmd+S are scoped to the focused workbench and avoid other inputs/dialogs.

The tree has fixed 28px virtual rows, keyboard navigation, multiple selection, ignore filtering, reveal, create, rename/move, copy and explicit Trash. Lookup displays independently filtered recent history and ranked/highlighted matches, bound to the selected checkout or exactly the open checkouts (eight-checkout/100-result display bound). Discovery/IO errors and partial results stay visible. No Microsoft lookup scorer or old application helper is imported.

Mutations publish source drafts before effects. Only recorded successful items change references. Lost responses query the original operation status instead of redispatching; affected Save/close/mutations stay blocked while outcomes are uncertain. Dirty copies retain a separate destination draft, and dirty Trash text remains recoverable at its original target. Replacements require captured destination identity and explicit consent, and cannot replace an open destination buffer. Move resets Monaco undo history while retaining text and positions.

Hide an editor using `hidden` while keeping it mounted to preserve its models and undo history. Unmount releases Monaco models/listeners; it retains controller text/state but resets Monaco undo. Explicit `dispose()` ends subscriptions and pending observations, without disposing the process runtime or silently deleting published recovery. Consumers must run the preservation gate before destructive teardown; the module cannot veto an OS force-kill.

## Run and evidence

```sh
bun install --no-save
bun run --cwd packages/editor typecheck
bun run --cwd packages/editor lint
bun run --cwd packages/editor test
bun run --cwd packages/editor check:renderer
bun run --cwd packages/editor build
bun run --cwd packages/editor test:ui
bun run --cwd packages/editor demo
```

The demo creates one scoped application runtime with the memory service and two editor clients. Its controlled failure/external-writer controls are demo-only. Playwright needs its pinned Chromium installation (`bun x playwright install chromium`). Source checks/lint currently use TypeScript diagnostics, matching the foundation.

Current evidence: 21 public controller scenarios through shared application handlers; four real Chromium UI journeys with actual Monaco typed edits, comparisons, conflict/error feedback, lookup, creation, close/reopen and resource counts; browser bundling checks 1,569 renderer inputs with no privileged modules or feature runtime. Vite+ builds all five Monaco workers. Screenshots are under `evidence/`; test-generated copies live in ignored `test-results/`.

**Integration blocker being coordinated:** the real workspace service advances recovery CAS revisions when it records Save/move/copy facts. The command contract needs exact receipt transitions and per-client acknowledgement semantics before the controller can consume those transitions without accepting competing publications. Current stale revisions fail visibly and veto close/discard. This memory-service evidence does not qualify real filesystem recovery handoffs. The PR remains draft until the agreed receipt contract and real workspace/controller integration pass.

Packaged/native Electron, real filesystem/Git/SQLite workspace integration, native picker/Trash execution, complete-app keyboard/focus and VoiceOver remain unrun here. Those belong to the workspace/fan-in/desktop proofs. Human acceptance is **PENDING**. No provider, SSH, deployment or legacy-state work is included.

## Provenance and distribution

Behavior was read only from the immutable `docs/source-snapshot`, whose manifest records source revision `181097195a026d48b82758cee841ed8dd326db70` and per-file hashes/history. The frozen main entry, activation/close/memory helpers, tree/model/viewport/lookup/sidebar and UI recipes informed requirements. This package implements its state, matching, service demo and UI independently; it copies no frozen implementation file, old host type, application helper, schema or fixture. Shared UI recipes are consumed from `@moonbase/ui`. Source imports do not authorize excluded dependencies. The live escode checkout was never accessed or modified.

The active renderer uses the pinned React/React DOM, Monaco, Base UI and StyleX stack. The memory-only composition also uses Effect. The coordinator owns generation of distribution notices from package-provided licenses/notices for actual bundled assets, including Monaco workers/fonts. No manually copied notice bundle is added by this module.
