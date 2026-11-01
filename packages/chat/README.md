# Headless chat client

`@moonbase/chat` exports `ChatController`, `ChatState`, `Pending` and `DraftStorage`. It is ordinary TypeScript with no UI, platform integration or runtime acquisition. Clients supply layout, navigation, storage and lifecycle; Pi Durable owns execution, transcripts and tasks through the application handlers.

```ts
import { ChatController } from '@moonbase/chat';

const controller = new ChatController(chat, connection, session, storage);
const unsubscribe = controller.subscribe(render);
await controller.start(); // Observe only; Connect and Send are explicit.
// Before destructive close, require controller.preserve() to succeed.
unsubscribe();
controller.dispose();
```

Supply `ChatClient`, `ConnectionClient`, an exact host/store/actor `ChatSession`, synchronous storage (`read(): string | null`, `write(value): void`) and optionally an ID generator. The caller owns clients/runtime disposal. `detach()` releases observations for a hidden view; `start()` reads again. `dispose()` permanently releases observations/listeners. None Stops remote work.

## Preservation

Chat owns the versioned saved schema and draft/pending-command preservation. The application binds one fixed storage namespace/context for the controller's lifetime. Use one client per namespace; storage must return current data, complete writes synchronously and throw on failure. There is no migration, legacy import or deletion, atomic multi-process storage or power-loss guarantee.

Corrupt, foreign, full, externally changed or unwritable storage stays untouched and blocks new mutations and destructive close. Honor `preserve()` returning false and keep live text available for copying. At most 16 unresolved commands and 32 nonempty drafts (32 KiB each) are retained. Successful Send resolution clears only its captured draft, preserving newer edits.

Create/Send/Stop retain immutable original inputs across uncertain outcomes. Reconnect only observes; explicit retry queries first and repeats the captured input. Create recovers through a matching original retry. Stop captures the exact submission/task, including a null queued task, and never follows a successor. Cancellation does not prove remote termination or undo tool effects. See the [chat contract](../application/docs/CHAT.md).

Snapshots replace output. State retains at most 32 current and 32 older 4 KiB previews and eight live tool previews; another older page replaces the previous page. Stored transcripts remain in Pi.

## Checks

```sh
bun run --cwd packages/chat typecheck
bun run --cwd packages/chat test
bun run check:foundation
```

Tests use the public entry and controlled [HTTP/SQLite fixtures](../../tests/chat/README.md). The foundation audit checks browser independence from UI frameworks and privileged implementations. [Desktop](../../apps/desktop/README.md) owns IPC, private configuration and native/package qualification.
