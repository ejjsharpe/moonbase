# Headless chat client

`@moonbase/chat` exports `ChatController`, `ChatState`, `Pending` and `DraftStorage` through one public entry. It is ordinary TypeScript: no UI, platform integration, runtime or service acquisition. Applications supply their own layout, navigation, focus, storage and lifecycle. Execution, transcripts and tasks remain in Pi Durable through the shared application handlers.

```ts
import { ChatController } from '@moonbase/chat';

const controller = new ChatController(chat, connection, context, storage);
const unsubscribe = controller.subscribe(render);
await controller.start(); // Observes only; Connect and Send remain explicit.
// Before a destructive close: require controller.preserve() to succeed.
// Hide: controller.detach(); show: await controller.start();
unsubscribe();
controller.dispose(); // Releases observations; remote work continues.
```

The constructor receives `ChatClient`, `ConnectionClient`, the exact `ChatSession` (host/store/actor), synchronous storage with `read(): string | null` and `write(value): void`, and an optional ID generator. The application binds storage to its chosen key or location before passing it to chat. The caller owns client/runtime disposal. A view must preserve before unmounting or closing; failed preservation keeps the live view available so the latest text can be copied. `detach()` releases connection/chat observations; `start()` reads again. `dispose()` permanently releases observations and listeners. Neither method Stops remote work.

## Preservation and recovery

Chat owns the version-1 schema, serialization, validation and preservation of drafts and pending command identities. The application owns the storage namespace; chat reads and writes only the supplied storage and performs no migration, legacy import or deletion. Storage must retain its exact namespace/context for the controller's lifetime, return the current serialized value on each read and synchronously write before returning. Read and write failures must throw so preservation can block mutations and destructive close. Use one client per storage namespace; external-change detection is a preservation fence, not an atomic multi-process database. Ordinary storage provides no physical power-loss guarantee. A renderer crash or forced termination can lose edits after the last successful write.

Create/Send/Stop capture their full immutable input before disclosure. At most 16 unresolved commands and 32 nonempty drafts (32 KiB each) are retained, scoped to exact host/store/actor/conversation. Successful Send resolution clears only its captured draft text, preserving newer edits. Corrupt, foreign-context, full, externally changed or unwritable storage stays untouched and blocks new mutations and destructive close. Failed live edits remain visible in memory; callers must honor `preserve()` returning false.

Reconnect is observational and never resends. Outcome queries retain unresolved original inputs; an explicit retry queries first and repeats only that captured input. Create has no read-only receipt query, so a matching original Create retry recovers its exact conversation. Stop captures the submission/task, including a null queued task, and never follows a successor. Pending cancellation does not prove remote work ended or tool effects were undone.

Snapshots replace output rather than appending an event feed. State holds at most 32 current and 32 older host-bounded previews (4 KiB each), with at most eight live tool previews; another older page replaces the previous page. Stored transcripts are never deleted.

## Checks

```sh
bun run --cwd packages/chat typecheck
bun run --cwd packages/chat test
bun run check:foundation
```

Controller tests consume the public entry. Protocol tests use the controlled tool host in `tests/chat`, exercising real HTTP/SQLite and a TCP forwarding child without a real provider or SSH host. The foundation browser-bundle audit permits only this package and application contracts, excluding UI frameworks and privileged implementations. Desktop owns private configuration, IPC and native/package qualification; see [desktop setup](../../apps/desktop/README.md).
