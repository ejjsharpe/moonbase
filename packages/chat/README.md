# Headless chat client

`@moonbase/chat` exports scoped `makeChatModel`, runtime-bound `makeChatController`, and `ChatController`, `ChatState`, `Pending` and `DraftStorage` types. Effect owns asynchronous model resources; snapshots, drafts and preservation stay synchronous ordinary state. Clients supply layout, navigation, storage and lifecycle. Pi Durable owns execution, transcripts and tasks through the application handlers.

```ts
import { Effect, Exit, Layer, ManagedRuntime, Scope } from 'effect';
import { makeChatModel, makeChatController } from '@moonbase/chat';
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

Supply browser-safe `ChatClient`, `ConnectionClient`, an exact host/store/actor `ChatSession`, synchronous storage (`read(): string | null`, `write(value): void`) and optionally `newId`. Multiple independent models share the caller runtime with distinct storage namespaces. Neither model acquisition nor facade binding installs backend capabilities or creates/disposes a runtime. Bind each acquired model once.

`context` is a synchronous readonly getter returning an independent copy of the fixed public host/store/actor identity. Mutating that copy cannot retarget a model or its retained requests. `getSnapshot()`, snapshot `subscribe()`, `setDraft()` and `preserve()` are synchronous, including the `beforeunload` preservation decision. Async actions return Promises. `detach()` closes only attachment/generation/selection observations and read waits; await it to observe cleanup failures. `start()` resumes observation. A selected view owns its snapshot/history reads and watch. Selection, generation replacement and Hide cancel those resources with AbortSignals and exact identity fences. Explicit Create/Send/Stop/Connect/Disconnect workflows remain model-owned across selection/Hide. None of these lifecycle operations invents Stop or waits for remote AI work.

A failed watch acquisition remains observable through disposal and aggregate root cleanup, including synchronous callback/dispose/throw races. Disposal stops new actions and late state/storage writes immediately, joins actual IO-watch finalizers (including already-closing detached observations), and preserves its result for repeated calls. The application root owns and observes that Promise outside the removed panel's scope, reports failure in its visible cleanup area, prevents overlapping reuse of its storage namespace, and drains cleanup before disposing the shared runtime. A disposed model never writes a late receipt: the original preserved pending input remains recovery evidence. Hide differs from disposal and may still reconcile an admitted command.

## Preservation

Chat owns the strict version-one saved schema, draft/pending-command preservation, exact context and duplicate checks. Public input schemas supply retained Create/Send/Stop shapes; unfamiliar nested fields, unsupported versions and foreign context reject before the first write. Original stored bytes stay untouched and the namespace blocks mutation/destructive close. No projection, migration, legacy import or deletion occurs.

Use one model per caller-bound namespace; storage must return current data, complete writes synchronously and throw on failure. Corrupt, foreign, full, externally changed or unwritable storage blocks new mutations and destructive close. Honor `preserve()` returning false and keep live text available for copying. At most 16 unresolved commands and 32 nonempty drafts (32 KiB each) are retained within the existing 2 MiB serialized envelope bound. JSON escaping counts toward that bound; an oversized live edit stays available for copying and blocks preservation before any write. Successful Send resolution clears only its captured draft, preserving newer edits. Storage is neither atomic across processes nor a power-loss guarantee.

Create/Send/Stop retain immutable original inputs across uncertain outcomes. Reconnect only observes; explicit retry queries first, rechecks synchronous preservation, then may repeat only the captured input. Create recovers through a matching original retry. Stop captures the exact submission/task, including a null queued task, and never follows a successor. Cancellation does not prove remote termination or undo tool effects. See the [chat contract](../contracts/docs/CHAT.md).

Snapshots replace output. State retains at most 32 current and 32 older 4 KiB previews and eight live tool previews; another older page replaces the previous page. Stored transcripts remain in Pi. Safe application invocation/error helpers preserve typed failures and redact unknown Promise/cleanup diagnostics.

## Checks

```sh
bun run --cwd packages/chat typecheck
bun run --cwd packages/chat lint
bun run --cwd packages/chat test
bun run check:foundation
```

Tests use the public factory/facade, controlled completion gates and [HTTP/SQLite/process fixtures](../../tests/chat/README.md). They cover scope races, strict saved data, two-model disposal, held/failing/reentrant watch cleanup and immutable mutation recovery. The foundation audit permits browser-safe Effect and excludes UI/privileged implementations. [Desktop](../../apps/desktop/README.md) owns IPC, root cleanup reporting, private configuration and native/package qualification. Controlled tests do not qualify real SSH/provider access, physical durability or manual acceptance.
