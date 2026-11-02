# Headless editor

`@moonbase/application/editor` owns the scoped headless Effect model and direct Promise-facing controller. It owns buffers, tabs, previews, navigation, view positions, lookup/mutation sessions and recovery coordination. All IO uses an injected `EditorClient` from `@moonbase/contracts/workspace`. The public entry imports only portable application/contracts/Effect code; React, Monaco, DOM, native workspace and Electron remain outside its graph.

## Use

```ts
import { Effect, Exit, Layer, ManagedRuntime, Scope } from 'effect';
import { makeEditorModel, makeEditorController } from '@moonbase/application/editor';

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
| `@moonbase/application/editor` | Model/controller factories, types, target keys and concrete presentation helpers |
| `@moonbase/application/testing/memory-workspace` | Injected volatile workspace service for tests and demos; excluded from the editor entry graph |
| `@moonbase/editor` | React/Monaco presentation receiving a supplied controller |
| `@moonbase/editor/workers` | Browser-root Monaco worker configuration |

Applications supply clients, acquire models in their aggregate scope and own runtime disposal. Multiple models share that runtime; each has a separate model scope, recovery identity and Monaco instance identity. Binding never acquires a second model or backend. Factory acquisition installs a finalizer even if the model is never bound. A privileged composition root can use `makeEditorClient(runtime)` from `@moonbase/application/runtime/clients`; isolated renderers receive a validated bridge client. Each live editor needs a distinct recovery `clientId`; reuse it only to restore that editor after shutdown. Omission generates a random ID.

## Preservation and lifecycle

Save captures an immutable target, request, text and version. Conflicts retain the draft and offer Compare, Overwrite, Reload or Cancel. Lost responses retain original inputs for exact reconciliation; newer edits remain separate. File mutations preserve affected drafts before effects, require explicit replacement consent and keep uncertain outcomes visible. Batch moves/copies check individual destinations for open buffers; unrelated open files inside the destination folder remain usable. Unresolved destination collisions retain both drafts.

Recovery uses [exact publication receipts](../../contracts/docs/RECOVERY-PUBLICATIONS.md). `getSnapshot().publication` exposes an unresolved publication; `resolveRecoveryPublication()` reconciles it. Uncertainty blocks destructive actions and Quit. Consumers must honor the controller's `prepareQuit()` Save/Discard/Cancel gate before disposing or unmounting. The headless model owns `closePrompt: {id, buffer} | null` and `answerClose(promptId, choice)`; `close(targets)`, `closeCheckout(checkout)` and `prepareQuit()` wait on that exact prompt. Stale answers are ignored. The view renders the prompt and answers Cancel on dismissal/unmount; a hidden mounted workbench keeps it. Completed Saves and confirmed Discards remain facts if a later step fails.

`getSnapshot().recoveryReady` is the synchronous document-unload gate: veto reload while false and keep publication/retry controls available. It does not replace `prepareQuit()`. Keep a hidden editor mounted to retain Monaco models and undo history. Unmount releases Monaco models/listeners; hiding a mounted editor retains its observation/publication ownership. Controller disposal immediately blocks new actions and late writes, then joins owned observation finalizers. `dispose()` returns the same completion promise on repeated calls; `disposed` becomes true only after cleanup succeeds. Failure rejects to the application-owned visible error sink and remains failed, including after panel removal. The caller drains cleanup before disposing its runtime; no recovery is deleted. Force-kill and physical power loss are outside these gates.

Saved recovery is decoded strictly before rebuilding buffers or publishing a capture. Unfamiliar nested fields, malformed data and foreign client identity keep readiness false and prevent overwrite; original bytes remain untouched. Known optional fields and dynamic filename keys remain supported. There is no migration or silent reset. Memory/demo recovery uses the same structural decoder; an invalid live draft remains visible and must be corrected before preservation can publish it.

Publication and immutable-fact ordering use independent per-model Effect semaphores. Debounce timers, checkout observers, selection reads and lookup/inspection sessions have scoped lifetimes; cancelling a popup cannot cancel an already captured mutation. Late results remain fenced by exact identities and generation checks. No operation is automatically replayed.

## Checks

From the repository root:

```sh
bun run --cwd packages/application typecheck
bun run --cwd packages/application lint
bun run --cwd packages/application test
bun run check:foundation
bun run test:editor-integration
```

Playwright requires its pinned Chromium (`bun x playwright install chromium`). The demo composes one memory-service runtime and two editor clients; it does not qualify filesystem safety or durability. The [editor/workspace suite](../../../tests/editor-workspace/README.md) tests real IO through public boundaries. Packaged/native interaction, VoiceOver and human acceptance require desktop qualification. Distribution must retain notices for actual bundled dependencies, including Monaco workers/fonts.
