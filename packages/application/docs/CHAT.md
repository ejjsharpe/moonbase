# Headless chat client

`@moonbase/application/chat` exports scoped `makeChatModel`, runtime-bound `makeChatController`, and `ChatController`, `ChatState`, `Pending` and `DraftStorage` types. Effect owns asynchronous model resources; snapshots, drafts and preservation stay synchronous ordinary state. Clients supply layout, navigation, storage and lifecycle. Pi Durable owns execution, transcripts and tasks through the application handlers.

```ts
import { Effect, Exit, Layer, ManagedRuntime, Scope } from 'effect';
import { makeChatModel, makeChatController } from '@moonbase/application/chat';
import { runApplicationEffect } from '@moonbase/application/runtime/effect-client';

// The application root creates one renderer runtime and aggregate scope.
const runtime = ManagedRuntime.make(Layer.empty);
const scope = Scope.makeUnsafe();
const model = await runApplicationEffect(runtime, Effect.provideService(
  makeChatModel({ chat, connection, context: session, storage }), Scope.Scope, scope,
));
const controller = makeChatController(runtime, model); // Binds this instance; never reacquires.
const unsubscribe = controller.subscribe(render);
await controller.start(); // Observe only; Connect and Send are explicit.

// After preserve() succeeds, remove the panel and retain its cleanup at the root.
if (controller.preserve()) {
  unsubscribe();
  await controller.dispose(); // Stable/idempotent, rejects when actual observation cleanup fails.
}
// Controlled application Quit drains all instance cleanup before root teardown.
await runApplicationEffect(runtime, Scope.close(scope, Exit.void));
await runtime.dispose();
```

Supply browser-safe `ChatClient` and `ChatSession` from `@moonbase/contracts/chat`, `ConnectionClient` from `@moonbase/contracts/connection`, an exact host/store/actor context, synchronous storage (`read(): string | null`, `write(value): void`) and optionally `newId`. Multiple independent models share the caller runtime with distinct storage namespaces. Neither model acquisition nor facade binding installs backend capabilities or creates/disposes a runtime. Bind each acquired model once.

`context` is a synchronous readonly getter returning an independent copy of the fixed public host/store/actor identity. Mutating that copy cannot retarget a model or its retained requests. `getSnapshot()`, snapshot `subscribe()`, `setDraft()` and `preserve()` are synchronous, including the `beforeunload` preservation decision. Async actions return Promises. `detach()` closes only attachment/generation/selection observations and read waits; await it to observe cleanup failures. `start()` resumes observation. A selected view owns its snapshot/history reads and watch. Selection, generation replacement and Hide cancel those resources with AbortSignals and exact identity fences. Explicit Create/Send/Stop/Connect/Disconnect workflows remain model-owned across selection/Hide. None of these lifecycle operations invents Stop or waits for remote AI work.

A failed watch acquisition remains observable through disposal and aggregate root cleanup, including synchronous callback/dispose/throw races. Disposal stops new actions and late state/storage writes immediately, joins actual IO-watch finalizers (including already-closing detached observations), and preserves its result for repeated calls. The application root owns and observes that Promise outside the removed panel's scope, reports failure in its visible cleanup area, prevents overlapping reuse of its storage namespace, and drains cleanup before disposing the shared runtime. A disposed model never writes a late receipt: the original preserved pending input remains recovery evidence. Hide differs from disposal and may still reconcile an admitted command.

## First-message composition

`setDraft(text)` works without a selected conversation and preserves that new-chat draft synchronously. `closeView()` returns to it while retaining each saved conversation's separate draft. `send(settings?)` captures the current text, creates a conversation when no target is selected, and sends to that exact returned target. The title uses the first line, bounded to 80 UTF-8 bytes. Local first sends require the same immutable folder/model settings as `create`; remote first sends reject those settings. Existing `create(title, settings?)` remains available for explicit empty conversations.

The version-one saved envelope accepts optional `newDraft` text and an optional `firstMessage` on a retained Create. Existing version-one data remains readable without rewriting its shape. Both request identities and the first message are preserved before Create. The confirmed Create receipt is published together with the exact retained Send before message disclosure. Creation failure retains both identities; Send failure retains Send independently. Reconnection and reload never start either mutation. An explicit original Create retry completes the captured first Send; an original Send retry does not create again. Newer edits survive admission, and publication failure prevents Send. Older clients that do not recognize these optional fields cannot open such new data.

First Send checks the 32-conversation draft limit before Create. If another edit fills the last slot during creation, the original Create/message stay retained with an explicit capacity error; clearing a draft permits an exact retry without another conversation or lost text.

Concurrent original and retry Create calls may return the same receipt. Only the first receipt for a still-retained Create updates selection/drafts and starts its captured Send. Later replies are ignored after resolution, preserving a newer new-chat draft and avoiding duplicate pending Send identities.

## Model preferences

`setModelPreference({ model: { provider, modelId }, reasoningEffort? })` preserves an explicit model/effort choice synchronously and exposes it as `ChatState.modelPreference`. It is independent of the selected conversation and survives New chat, panel removal and controller replacement using the same namespace. Missing preferences remain `null`; the consumer presents the configured provider's supplied default without persisting an implicit user choice. Selecting an older conversation never overwrites the preference. Local Create/first Send captures the chosen `reasoningEffort` with its immutable folder/model settings; later preference changes cannot retarget a retained command or existing conversation.

The strict version-one envelope accepts optional `modelPreference`; old envelopes remain readable without adding fields. Invalid preferences cannot replace valid saved settings. Failed writes use the existing preservation fence. Availability is catalog state rather than saved-data validity: an unavailable saved model or effort remains preserved and the desktop asks the user to choose a replacement. It does not silently change the preference.

## Preservation

Chat owns the strict version-one saved schema, draft/pending-command preservation, exact context and duplicate checks. Public input schemas supply retained Create/Send/Stop shapes; unfamiliar nested fields, unsupported versions and foreign context reject before the first write. Original stored bytes stay untouched and the namespace blocks mutation/destructive close. No projection, migration, legacy import or deletion occurs.

Use one model per caller-bound namespace; storage must return current data, complete writes synchronously and throw on failure. Corrupt, foreign, full, externally changed or unwritable storage blocks new mutations and destructive close. Honor `preserve()` returning false and keep live text available for copying. At most 16 unresolved commands and 32 nonempty drafts (32 KiB each) are retained within the existing 2 MiB serialized envelope bound. JSON escaping counts toward that bound; an oversized live edit stays available for copying and blocks preservation before any write. Successful Send resolution clears only its captured draft, preserving newer edits. Storage is neither atomic across processes nor a power-loss guarantee.

Create/Send/Stop retain immutable original inputs across uncertain outcomes. Reconnect only observes; explicit retry queries first, rechecks synchronous preservation, then may repeat only the captured input. Create recovers through a matching original retry. Stop captures the exact submission/task, including a null queued task, and never follows a successor. Cancellation does not prove remote termination or undo tool effects. See the [chat contract](../../contracts/docs/CHAT.md).

Snapshots replace current run/status output. `ChatState.transcript` owns the canonical bounded history window, earlier/later/around navigation, progressive hydration and application-lifetime anchors. Complete-source iteration streams independently of cache retention and propagates failures. See [transcript API, bounds and native handoff](TRANSCRIPTS.md). Stored transcripts remain in Pi. Safe application invocation/error helpers preserve typed failures and redact unknown Promise/cleanup diagnostics.

## Checks

```sh
bun run --cwd packages/application typecheck
bun run --cwd packages/application lint
bun run --cwd packages/application test
bun run check:foundation
```

Tests use the public factory/facade, controlled completion gates and [HTTP/SQLite/process fixtures](../../../tests/chat/README.md). They cover scope races, strict saved data, two-model disposal, held/failing/reentrant watch cleanup and immutable mutation recovery. The foundation audit permits browser-safe Effect and excludes UI/privileged implementations. [Desktop](../../../apps/desktop/README.md) owns IPC, root cleanup reporting, private configuration and native/package qualification. Controlled tests do not qualify real SSH/provider access, physical durability or manual acceptance.

## Composition

`makeChatModel(dependencies)` returns `Effect<ChatModel, ApplicationError, Scope>`; the caller supplies its shared runtime and removable acquisition scope. `makeChatController(runtime, model)` binds that exact acquired instance once. The fixed context and caller-bound storage namespace belong to that model; composition must prevent a replacement from using the same namespace while cleanup is pending or failed. No import, acquisition or binding connects a host, sends a message or stops remote work.

`preserve(): boolean` remains a synchronous close/unload decision. Preserve before disposal; a failed preservation decision must retain the live model and its text. Calling `dispose(): Promise<void>` immediately blocks admissions and late writes, then joins its retained cleanup outcome. `detach(): Promise<void>` releases view observation without disposing the model or stopping an admitted remote command. Root-owned cleanup must observe those Promises outside the removed panel and drain them before runtime teardown. Cross-feature Quit and its admission policy belong to application composition. The application TypeScript library target retains chat's ES2024 requirement.

## Local mode and provider setup

Pass `mode: "local"` with a local ChatClient and no ConnectionClient. `ChatState.mode` and `ready` are transport-neutral; local `start()` reads the store without SSH or a synthetic profile. `create(title, settings?)` requires immutable cwd/model settings locally and rejects them remotely. Settings remain in retained Create inputs and strict saved-data validation. A host mode mismatch rejects.

An optional provider setup client creates `controller.providers`, whose snapshots contain status/catalog and prompt IDs, never answers. The controller polls only a running setup flow, preserves no credentials, joins active calls and cancels setup during disposal. It shares the chat model’s admissions fence. Named-target switching and final Quit confirmation belong to application composition.
