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

Browser clients mount `Workbench` from `@moonbase/workbench` with an acquired editor `controller` and explicit `checkout`. The consuming app owns project navigation and passes the displayed checkout; the workbench owns project-scoped file/tree/Monaco presentation. Native callbacks return approved opaque references, never raw OS source paths; picker, clipboard and drop share `WorkbenchHandle.importFiles(checkout, references)` and the internal editor destination/replacement dialog. Direct headless consumers continue using the factories above without UI.

| Export | Purpose |
| --- | --- |
| `@moonbase/application/editor` | Model/controller factories, types, target keys and concrete presentation helpers |
| `@moonbase/application/testing/memory-workspace` | Injected volatile workspace service for tests and demos; excluded from the editor entry graph |
| `@moonbase/workbench` | Project editor receiving a supplied controller and exact checkout |
| `@moonbase/workbench/workers` | Browser-root Monaco worker configuration |

Applications supply clients, acquire models in their aggregate scope and own runtime disposal. Multiple models share that runtime; each has a separate model scope, recovery identity and Monaco instance identity. Binding never acquires a second model or backend. Factory acquisition installs a finalizer even if the model is never bound. A privileged composition root can use `makeEditorClient(runtime)` from `@moonbase/application/runtime/clients`; isolated renderers receive a validated bridge client. Each live editor needs a distinct recovery `clientId`; reuse it only to restore that editor after shutdown. Omission generates a random ID.

`getSnapshot()` retains its identity until the next publication. Each publication copies its DTO arrays and objects, including nested buffers, recovery and discovery data, while sharing immutable string values. Consumer mutations cannot change model state or later publications; retained snapshots remain stable as the editor changes. This avoids serializing large unrelated buffer and restored-draft strings on every edit or position update. See the [controlled snapshot measurements](EDITOR-SNAPSHOT-PERFORMANCE.md) for the repeatable harness and its limits.

## Controller surface

`EditorController` explicitly declares the existing surface in `src/features/editor/editor.ts`; adding an implementation method cannot expand it. `clientId` and `instanceId` are readonly. `subscribe`, `getSnapshot` and `report` are bound callbacks; subscription returns a synchronous unsubscribe. `dispose` remains replaceable by a composition fixture and returns the same cleanup promise on repeated calls.

| Area | Members |
| --- | --- |
| Snapshots and errors | `subscribe(listener)`, `getSnapshot()`, `report(error)`, `clearErrors()` |
| Recovery and checkout | `load()`, `openCheckout(root)`, `selectCheckout(target)`, `resolveRecoveryPublication()`, `flush()`, `reconcileRecovery()` |
| Buffers | `buffer(target)`, `edit(target, text)`, `keepOpen(target)`, `open(target, options?)`, `save(target, overwrite = false)`, `reload(target)`, `cancelConflict(target)` |
| View memory | `position(target, mode, position)`, `reorder(checkout, from, to)`, `navigate(checkout, direction)`, `tree(checkout, patch)`, `resizeSidebar(width)` |
| Preservation | `answerClose(promptId, choice)`, `close(targets)`, `closeCheckout(checkout)`, `prepareQuit()`, `reopen(checkout)`, `dispose()` |
| Discovery and operations | `list(checkout, path = '')`, `reveal(target, showIgnored = false)`, `lookup(checkout, query)`, `refresh(checkout)`, `createLookup()`, `createMutation(action)`, `inspect(checkout, paths)`, `mutate(input)`, `resolveOperation(id, operationClientId = clientId)` |

`open` retains optional `view`, `intent` and `current` controls. The acquired `EditorModel` separately retains `bind`, `release`, `setAdmissionsOpen` and `finishQuitPreparation` for composition. They are excluded from the controller. Factories, binding once, public export paths, storage and wire contracts remain unchanged; the public fixture checks the full original controller type.

## Internal lifetimes

`editor.ts` remains the sole writer of live buffers, disk/conflict state, checkout/view memory and synchronous snapshots. Mutation/reference reconciliation and its facts semaphore/defer coordinator stay there. `references.ts` shares exact reference calculations between cloned close proposals and confirmed live application; `record.ts` keeps filename maps safe.

`recovery-publications.ts` owns the publication semaphore, persisted revision, capture/confirmation generations, in-flight count, immutable pending request and debounce fiber/generation under the supplied model scope. It accepts cloned recovery and captured Save IDs, validates only an attempt's exact CAS receipt and invokes that attempt's retained continuation. Validated fact transitions enter through its revision operation; Save evidence is retired only after the containing publication confirms. The facts coordinator acquires its own semaphore before waiting for publication ownership, preserving the original lock order.

`preservation.ts` owns one captured Close/Reload/Quit action, its generation/barrier, exact prompt Deferred and close history. Per-attempt capabilities capture buffers/recovery, save/read, check current references/revision and apply the confirmed result. It never receives mutable model state. The final exact publication receipt authorizes the live result; a pending confirmation retains the barrier. Release resumes deferred facts through the editor's existing coordinator before activation/debounce work. Document loss cancels an unanswered prompt immediately.

`discovery.ts` owns checkout watch scopes/handles, retained observation-close outcomes, selected-read scopes/activation generations, obsolete interrupt-only classification and refresh coalescing. Named listing/Git/comparison capabilities and operation-local current predicates publish into model-owned state. Watch events request existing facts reconciliation; discovery never publishes recovery. Checkout removal releases its observation, and model disposal joins detached, held or failed closures. Active, compound and cleanup failures remain observable.

## Preservation and lifecycle

Snapshot subscribers run synchronously. A throwing subscriber cannot block later notifications or editor-owned preservation.

Save captures an immutable target, request, text and version. Conflicts retain the draft and offer Compare, Overwrite, Reload or Cancel. Lost responses retain original inputs for exact reconciliation; newer edits remain separate. File mutations preserve affected drafts before effects, require explicit replacement consent and keep uncertain outcomes visible. The mutation module shares destination calculation between replacement inspection and open-buffer protection; each retains its own checks. Batch moves/copies check individual destinations for open buffers; unrelated open files inside the destination folder remain usable. Unresolved destination collisions retain both drafts.

Recovery uses [exact publication receipts](../../contracts/docs/RECOVERY-PUBLICATIONS.md). `getSnapshot().publication` exposes an unresolved publication; `resolveRecoveryPublication()` reconciles it. Uncertainty blocks destructive actions and Quit. Consumers must honor the controller's `prepareQuit()` Save/Discard/Cancel gate before disposing or unmounting. The headless model owns `closePrompt: {id, buffer} | null` and `answerClose(promptId, choice)`; `close(targets)`, `closeCheckout(checkout)` and `prepareQuit()` wait on that exact prompt. Stale answers are ignored. The view renders the prompt and answers Cancel on dismissal/unmount; a hidden mounted workbench keeps it. Completed Saves and confirmed Discards remain facts if a later step fails.

`recovery.openCheckoutIds` records project-tab order. A confirmed close of the selected checkout selects the final remaining ID, or `null` when no checkouts remain. Closing an unselected checkout retains the selection. Known checkout/view metadata stays preserved for reopening.

`getSnapshot().recoveryReady` is the synchronous document-unload gate: veto reload while false and keep publication/retry controls available. It does not replace `prepareQuit()`. Keep a hidden editor mounted to retain Monaco models and undo history. Unmount releases Monaco models/listeners; hiding a mounted editor retains its observation/publication ownership. Controller disposal immediately blocks new actions and late writes, then joins owned observation finalizers. `dispose()` returns the same completion promise on repeated calls; `disposed` becomes true only after cleanup succeeds. Failure rejects to the application-owned visible error sink and remains failed, including after panel removal. The caller drains cleanup before disposing its runtime; no recovery is deleted. Force-kill and physical power loss are outside these gates.

Saved recovery is decoded strictly before rebuilding buffers or publishing a capture. Unfamiliar nested fields, malformed data and foreign client identity keep readiness false and prevent overwrite; original bytes remain untouched. Known optional fields and dynamic filename keys remain supported. There is no migration or silent reset. Memory/demo recovery uses the same structural decoder; an invalid live draft remains visible and must be corrected before preservation can publish it.

Publication and immutable-fact ordering use independent per-model Effect semaphores. Debounce timers, checkout observers, selection reads and lookup/inspection sessions have scoped lifetimes; cancelling a popup cannot cancel an already captured mutation. Late results remain fenced by exact identities and generation checks. No operation is automatically replayed.

The [README test map](../README.md) separates ordinary buffer behavior, immutable Save receipts, readiness/publications, preservation races, discovery/activation, filename safety and scoped cleanup. The preservation suite retains facts crossing Close/Reload barriers and Copy destination-close invalidation. The lifecycle suite retains reentrant watch acquisition, held/detached/failing watch close and obsolete versus compound cancellation. A queued A/B publication regression covers exact retained-attempt ownership. All use public factories/controllers; browser graph checks include each private owner without a fixed input count.

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
