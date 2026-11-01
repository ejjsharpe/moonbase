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

Preview replacement happens only after successful activation. Editing, Keep Open, tab reorder and explicit opening retain a preview. File order, MRU/visual navigation, a bounded 20-action session file-close history, current-source reopen, per-view cursor/scroll and checkout/file tabs belong to the instance. Recovery retains known exact checkout targets/views separately from `openCheckoutIds`; persisted view keys are `checkoutId`. Closing a checkout retains its order, active file, comparison and positions without adding a file-close action. Restored open checkouts receive initial tree/Git discovery; closed metadata does not acquire IO/watch resources. Ctrl+Tab commits on Control release; Escape cancels. Cmd+Option+Left/Right follows visual order; Cmd+W, Cmd+Shift+T, Cmd+P and Cmd+S are scoped to the focused workbench and avoid other inputs/dialogs.

The tree has fixed 28px virtual rows, keyboard navigation, multiple selection, ignore filtering, reveal, create, rename/move, copy and explicit Trash. Lookup displays independently filtered recent history and ranked/highlighted matches, bound to the selected checkout or exactly the open checkouts (eight-checkout/100-result display bound). Discovery/IO errors and partial results stay visible. No Microsoft lookup scorer or old application helper is imported.

Mutations publish source drafts before effects. Only recorded successful items change references. Lost responses query the original operation status instead of redispatching; affected Save/close/mutations stay blocked while outcomes are uncertain. Dirty copies retain a separate destination draft, and dirty Trash text remains recoverable at its original target. Replacements require captured destination identity and explicit consent, and cannot replace an open destination buffer. Move resets Monaco undo history while retaining text and positions.

If a delayed or foreign move collides with another open destination buffer, both drafts are published and the operation stays unacknowledged, including after restart. The UI reports the collision. Close one retained file through Save/Discard/Cancel, then resolve the original operation status; retries never replay the mutation or overwrite the other buffer. Retained unavailable file/comparison buffers remain selectable. A definitive InvalidInput Save rejection releases its request for corrected edits, while genuine uncertainty retains the immutable request.

The memory adapter validates prospective recovery changes before committing. When both replacement drafts already existed in persisted recovery, it retains both original targets/text/baselines and pending evidence; restart cannot overwrite a duplicate destination. Save and mutation dispatch share the definitive InvalidInput non-admission policy, while admitted outcomes and later publication failures retain their original identities. A successful active-file close opens its survivor through the guarded activation path, restoring its remembered comparison/current contents. Close keeps every captured draft through non-destructive preflight/metadata convergence, then makes one final destructive publication. Its exact receipt commits the consented close; later metadata failures report separately and cannot veto it. The controller applies only captured close deltas to current metadata. Only the actual current survivor is activated; returning to a background checkout loads its absent retained buffer through the same guarded opening path, with its remembered view and current source. Visual/recent navigation and keyboard Close/Reopen share the post-mount focus handoff: editor typing, tree or tab-strip origin, and Find file when the editor becomes empty. Dialogs and hidden editors retain their scope.

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

Current evidence: 76 public controller scenarios through shared application handlers; 22 real Chromium UI journeys with actual Monaco typed edits, comparisons, conflict/error feedback, lookup, creation, close/reopen and resource counts; browser bundling checks 1,569 renderer inputs with no privileged modules or feature runtime. Vite+ builds all five Monaco workers. Screenshots are under `evidence/`; test-generated copies live in ignored `test-results/`.

Inspected captures: [two independent editors at 1600×1000](evidence/two-instances.png), [constrained workbench at 760×720](evidence/constrained.png), [safe checkout closure at 1600×1000](evidence/checkout-closed.png), and [typing after keyboard navigation at 1600×1000](evidence/keyboard-typing.png). The dataset is the four-file volatile demo in `demo/main.tsx`, plus an empty `created.txt` made by the constrained journey. These are actual controlled Chromium module UI, not native/complete-app acceptance. [Historical R3 corrections](evidence/review-r3.md) include inspected 1600×1000 captures of [checkout selection retained during close](evidence/close-selection.png), [typing after keyboard Close](evidence/keyboard-close.png) and [typing after keyboard Reopen](evidence/keyboard-reopen.png). The selection race uses two volatile roots with two files each (`demo/recovery-race.tsx`). [R2](evidence/review-r2.md), [R1](evidence/review-r1.md) and the [initial validation record](evidence/validation.md) remain historical.

Recovery publications use the coordinator's [exact identity/receipt contract](../application/RECOVERY-PUBLICATIONS.md). `getSnapshot().publication` exposes an unresolved request ID and kind; `resolveRecoveryPublication()` performs a bounded exact lookup/original-input retry. A null lookup does not establish non-admission. Save, Reload, mutations, Close and Quit stay blocked while publication identity is unresolved. An uncertain final Close/Reload also keeps its captured preservation lock and live buffers; the UI offers Resolve recovery publication. A false close/Quit result with pending evidence means **PENDING/UNCERTAIN**, not definitive failed Discard. On restart the authoritative recovery reflects the consented final state if committed, otherwise the preceding retained drafts. The controller never adopts a latest loaded revision or guesses publisher identity from equal state. Reload also waits for its exact destructive-publication confirmation.

`selectCheckout(target)` selects immediately and returns a promise for guarded activation when the retained active buffer is absent; await it when a consumer needs that buffer. Dirty retained buffers stay owned by the same exact target. Monaco comparison owner labels survive read-only updates, preserving the modified input's typing focus and the original input's read-only identity.

[Historical R4 responses and source/base evidence](evidence/review-r4.md) include inspected 1600×1000 captures of [returning to a background checkout](evidence/background-return.png), [typing into staged](evidence/staged-close.png) and [unstaged](evidence/unstaged-close.png) survivors, and [pending publication with retained text](evidence/pending-publication.png). The pending/checkout fixture uses two roots with two files each; comparison captures use the existing four-file two-instance demo.

Recovery observations recheck their capture boundary after asynchronous IO and before queued publication. During preservation or an unresolved publication, immutable receipt/result inputs wait in the editor's existing fact pipeline; release fetches fresh recovery instead of applying an old snapshot. Captured Saves retain their completed disk facts while foreign reference remaps wait. Reload clones its exact target and checks buffer/reference/revision identity after reading and before dispatching the destructive publication. Completed observer acknowledgements remain completed across a capture boundary.

Preservation release also retries the actual current checkout's absent active buffer, using its remembered view and guarded current-source opening. This applies after success, Cancel, failure and exact resolution of an unknown final result; a stale earlier selection cannot take over. [Historical R5 responses and exact source/base evidence](evidence/review-r5.md) include an inspected [1600×1000 Chromium capture](evidence/preservation-selection.png) of the selected alpha survivor after two background closes, followed by actual typed input. Dataset: the two-root/two-file `demo/recovery-race.tsx?both` fixture.

A confirmed close invalidates older pending Copy materialization only for that exact target in the existing Copy job. Cancellation/rejected preservation do not invalidate it; unrelated targets continue, and explicit later reopening keeps its newer edits. The immutable filesystem result remains intact and is acknowledged only after current valid recovery publication. Delayed/deferred Copy reads cannot recreate a deliberately closed draft or tab.

Buffer presence alone does not make a remembered comparison ready. Selection/release loads an unloaded staged, unstaged, untracked or conflict view through guarded opening while retaining dirty text/baselines. Settled comparison attempts include visible failures, preventing release-driven retry loops; explicit Open/Refresh can retry. An empty original is a valid loaded comparison.

[Current R6 responses and exact source/base evidence](evidence/review-r6.md) include inspected 1600×1000 captures of [a Copy destination remaining closed](evidence/copy-closed.png) and restored dirty [staged](evidence/restored-staged.png)/[unstaged](evidence/restored-unstaged.png) survivors with rendered baselines and typed working text. These use the controlled two-root/two-file race fixture, with one copied file or declared HEAD/index strings.

Save/move/copy facts consume only contiguous known `recoveryChanges` receipts, never the latest loaded CAS revision. Operation identity includes origin client plus ID; acknowledgements include this observing client separately. One editor's acknowledgement cannot hide another observer's pending fact. Controlled tests prove an origin-acknowledged move still reaches another editor with newer live edits, and unrelated same-client publications still veto close/discard. This memory-service evidence does not qualify real filesystem recovery handoffs; real workspace/controller integration and independent technical review remain required in the fan-in.

Packaged/native Electron, real filesystem/Git/SQLite workspace integration, native picker/Trash execution, complete-app keyboard/focus and VoiceOver remain unrun here. Those belong to the workspace/fan-in/desktop proofs. Human acceptance is **PENDING**. No provider, SSH, deployment or legacy-state work is included.

## Provenance and distribution

Behavior was read only from the immutable `docs/source-snapshot`, whose manifest records source revision `181097195a026d48b82758cee841ed8dd326db70` and per-file hashes/history. The frozen main entry, activation/close/memory helpers, tree/model/viewport/lookup/sidebar and UI recipes informed requirements. This package implements its state, matching, service demo and UI independently; it copies no frozen implementation file, old host type, application helper, schema or fixture. Shared UI recipes are consumed from `@moonbase/ui`. Source imports do not authorize excluded dependencies. The live escode checkout was never accessed or modified.

The active renderer uses the pinned React/React DOM, Monaco, Base UI and StyleX stack. The memory-only composition also uses Effect. The coordinator owns generation of distribution notices from package-provided licenses/notices for actual bundled assets, including Monaco workers/fonts. No manually copied notice bundle is added by this module.
