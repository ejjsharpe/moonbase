# Editor

`@moonbase/editor` is a reusable React/Monaco workbench with a scoped headless Effect model and a Promise-facing controller. It owns buffers, tabs, previews, navigation, view positions and recovery coordination. All IO uses an injected `EditorClient`; the renderer imports browser-safe Effect, with no filesystem, Electron, workspace implementation or provider code.

## Use

```ts
import { Effect, Exit, Layer, ManagedRuntime, Scope } from 'effect';
import { makeEditorModel, makeEditorController } from '@moonbase/editor/state';

// The application owns one process/document runtime and an aggregate scope.
const runtime = ManagedRuntime.make(Layer.empty);
const scope = Scope.makeUnsafe();
const model = await runtime.runPromise(
  makeEditorModel({ client, clientId: stableUniqueEditorId }).pipe(
    Effect.provideService(Scope.Scope, scope),
  ),
);
const editor = makeEditorController(runtime, model); // Binds this instance once.
await editor.load();
await editor.openCheckout(approvedRoot);

// After the preservation gate: remove the panel, retain/observe cleanup at the root.
await editor.dispose();
await runtime.runPromise(Scope.close(scope, Exit.void));
await runtime.dispose();
```

Mount `EditorWorkbench` from `@moonbase/editor` with `controller={editor}`. Shells may supply `selectCheckout` and `selectNativeImports`; native imports use approved opaque references, never raw OS source paths. Picker, clipboard and drop share `EditorWorkbenchHandle.importFiles(checkout, references)` and its destination/replacement dialog.

| Export | Purpose |
| --- | --- |
| `.` | Workbench, UI handle, controller, state types and target key helpers |
| `./state` | Controller/types without React or Monaco |
| `./workers` | `configureMonacoWorkers()` for a browser root with Vite-compatible `?worker` support |
| `./memory` | Volatile `memoryWorkspace(seeds)` service layer for demos/tests |

Applications supply clients, acquire models in their aggregate scope and own runtime disposal. Multiple models share that runtime; each has a separate model scope, recovery identity and Monaco instance identity. Binding never acquires a second model or backend. Factory acquisition installs a finalizer even if the model is never bound. A privileged composition root can use `makeEditorClient(runtime)` from `@moonbase/application/runtime-client`; isolated renderers receive a validated bridge client. Each live editor needs a distinct recovery `clientId`; reuse it only to restore that editor after shutdown. Omission generates a random ID.

## Preservation and lifecycle

Save captures an immutable target, request, text and version. Conflicts retain the draft and offer Compare, Overwrite, Reload or Cancel. Lost responses retain original inputs for exact reconciliation; newer edits remain separate. File mutations preserve affected drafts before effects, require explicit replacement consent and keep uncertain outcomes visible. Unresolved destination collisions retain both drafts.

Recovery uses [exact publication receipts](../application/docs/RECOVERY-PUBLICATIONS.md). `getSnapshot().publication` exposes an unresolved publication; `resolveRecoveryPublication()` reconciles it. Uncertainty blocks destructive actions and Quit. Consumers must honor the workbench's `prepareQuit()` Save/Discard/Cancel gate before disposing or unmounting. The headless model owns `closePrompt: {id, buffer} | null` and `answerClose(promptId, choice)`; `close(targets)`, `closeCheckout(checkout)` and `prepareQuit()` wait on that exact prompt. Stale answers are ignored. The view renders the prompt and answers Cancel on dismissal/unmount; a hidden mounted workbench keeps it. Completed Saves and confirmed Discards remain facts if a later step fails.

`getSnapshot().recoveryReady` is the synchronous document-unload gate: veto reload while false and keep publication/retry controls available. It does not replace `prepareQuit()`. Keep a hidden editor mounted to retain Monaco models and undo history. Unmount releases Monaco models/listeners; hiding a mounted editor retains its observation/publication ownership. Controller disposal immediately blocks new actions and late writes, then joins owned observation finalizers. `dispose()` returns the same completion promise on repeated calls; `disposed` becomes true only after cleanup succeeds. Failure rejects to the application-owned visible error sink and remains failed, including after panel removal. The caller drains cleanup before disposing its runtime; no recovery is deleted. Force-kill and physical power loss are outside these gates.

Saved recovery is decoded strictly before rebuilding buffers or publishing a capture. Unfamiliar nested fields, malformed data and foreign client identity keep readiness false and prevent overwrite; original bytes remain untouched. Known optional fields and dynamic filename keys remain supported. There is no migration or silent reset. Memory/demo recovery uses the same structural decoder; an invalid live draft remains visible and must be corrected before preservation can publish it.

Publication and immutable-fact ordering use independent per-model Effect semaphores. Debounce timers, checkout observers, selection reads and lookup/inspection sessions have scoped lifetimes; cancelling a popup cannot cancel an already captured mutation. Late results remain fenced by exact identities and generation checks. No operation is automatically replayed.

## Checks

From the repository root:

```sh
bun run --cwd packages/editor typecheck
bun run --cwd packages/editor lint
bun run --cwd packages/editor test
bun run --cwd packages/editor check:renderer
bun run --cwd packages/editor build
bun run --cwd packages/editor test:ui
bun run --cwd packages/editor demo
```

Playwright requires its pinned Chromium (`bun x playwright install chromium`). The demo composes one memory-service runtime and two editor clients; it does not qualify filesystem safety or durability. The [editor/workspace suite](../../tests/editor-workspace/README.md) tests real IO through public boundaries. Packaged/native interaction, VoiceOver and human acceptance require desktop qualification. Distribution must retain notices for actual bundled dependencies, including Monaco workers/fonts.
