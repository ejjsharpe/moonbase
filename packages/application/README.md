# Application

`@moonbase/application` holds the headless editor and chat features and the application that composes them. It imports no Node, Electron, React or infrastructure implementation: the process root supplies the `WorkspaceService` and the chat's ports, and runs everything on its one runtime. `workbench` and the desktop renderer read its atoms through `@effect/atom-react`; headless consumers and tests drive the services alone (see [`examples/headless.ts`](examples/headless.ts)).

## Public interface

| Export | Gives |
| --- | --- |
| `.` | `MoonbaseApplication`, `ChatHost`, `makeApplicationAtoms`, the application snapshot, `ApplicationLifecycleError` and `describeApplicationFailure`, and `PlaceNavigation` (back and forward through chats and project files) |
| `./editor` | The editor's services, `editorLayer`, `EditorLoader`, `makeEditorAtoms`, `EditorSnapshot`, `EditorError` and `describeEditorFailure` |
| `./chat` | The chat's services, `chatLayer`, its ports, `getChatAtoms`, `readChatState`, the transcript and its atoms, the composer, native actions, `ChatRefusedError`, `DraftStorageError` and `describeChatFailure` |
| `./testing/faux-workspace` | `fauxWorkspace`: an in-memory `WorkspaceService` for tests and demos |
| `./testing/faux-chat` | `fauxChat`: controlled chat and connection ports |
| `./testing/chat-fixture` | `driveChat`: an open chat's actions as Promises, and its state |
| `./testing/editor-fixture` | `acquireEditorDriver`: one editor's services as Promises over a test `WorkspaceClient` |
| `./testing/service-calls` | `makeChatCalls`, `makeConnectionCalls`, `makeProviderSetupCalls`: a runtime's chat services called from Promise tests |

`testing/` is test support only; lint lifts the Effect-native rules there, and the workbench's renderer check keeps it out of the bundle.

## Layout

`src/editor/` and `src/chat/` hold the two features; `src/runtime/` composes them and `src/place-history/` holds the window's place history; `src/follow-ref.ts` gives both features read-only atoms over their services' state. Each concept is a folder with up to three files:

| File | Holds |
| --- | --- |
| `x.ts` | Pure functions for derived decisions: no services, no state |
| `x-service.ts` | The `Context.Service` and its scoped `Layer`, holding the concept's `SubscriptionRef` |
| `x-atoms.ts` | Atoms (`effect/reactivity`) over the service, for subscription and caching, with no domain logic |

- Editor (`editorLayer(options)` over the `WorkspaceService`): `session`, `alerts`, `views`, `buffers`, `tabs`, `tree`, `discovery` (watches, listings, Git status), `operations`, `mutation`, `saves`, `preservation` (Close, Reload, Quit, Reopen), `recovery` (the outbox and keeping the store in step), `checkouts`, `worktrees`, `lookup` and `text-search`.
- Chat (`chatLayer(dependencies)` over `ChatPort`, `ConnectionPort` and `ProviderSetupPort` in `chat-ports.ts`): `actions`, `drafts`, `link` (one connected host's lifetime), `connection`, `chat-list`, `selection`, `sends`, `transcript`, `file-search`, `provider-setup`, `composer` and `native-actions` (a transcript's Copy and Open).
- Runtime: `MoonbaseApplication.layer(options)` builds one `ChatHost` (one chat target open at a time, each in its own scope) over an optional `editorLayer` supplied beneath it, so the chat is released before the editor. `start` loads the editor and opens the chat; `canUnload` and `prepareQuit` keep every draft first; `release` ends the chat before the root disposes the runtime.

A host's `ChatService` is a `ChatPort` as it is. The shared watch backoff is `watchRetrySchedule` in `src/watch-retry.ts`; the editor's checkout watches, the chat list, the open chat and provider setup all retry on it. `makeRunAgain` in `src/run-again.ts` runs keyed work one at a time, joined or run once more after: the chat list's reloads and the editor's checkout refreshes.

## Rules worth knowing

Unsaved work:

- The workspace's client recovery store is the only writer of recovery. The editor sends `openTab`, `closeTab`, `updateDraft` and `updateLayout` through `RecoveryOutbox`, in order; `RecoverySync.flush` succeeds only once everything before it is committed, and `recoveryReady` is false while an edit is unsent, a save unsettled or a file operation unacknowledged.
- Close, Reload and Quit's Discard wait for their `closeTab`. Unsent text of a buffer the store replaced is kept in an `(unsaved)` file beside it, never dropped.
- Once drafts can't be stored (a `DraftStorageError`, shown as the state's `storageError`), the chat's mutations and Quit stay blocked for its lifetime.
- An update copies only the entries it touches (`DraftMap` in `src/editor/draft-map.ts`) and keeps the identity of everything it left as it was, so `makeEditorAtoms`' per-concept atoms (`views.checkoutTabs(id)`, `buffers.status(key)`, `discovery.listings(key)` and the rest) notify only views that read what changed. Typing changes a buffer's text, which only `buffers.state` follows. `snapshot` is the whole editor at once for headless readers and tests; views don't read it.
- In memory, recovery views are `Map`s. Only the store's layout, which crosses IPC and disk, is plain objects, built with `Object.fromEntries` so a path such as `__proto__` stays a key.

Never duplicate a Send or a file operation:

- Each Create, Send and Stop is reserved with its request ID in the drafts' storage before it is sent, and leaves only when its outcome is known. A lost reply stays pending (`UncertainError`); Retry queries first and repeats the original identity. A command is sent only once its record can be written.
- `EditorMutations.mutate` runs one operation at a time behind its gate (`admits`). A dialog passes its own `id`, so applying again after a lost outcome resolves that operation instead of running it twice.

Authority and liveness:

- The editor's work runs in its session's scope (`session.run`, `session.admitted`), watches included. Closing the editor fences admissions (a run started after that is interrupted before it begins), then closes that scope, and every closer waits for it: its loads, saves, watches and reads are interrupted, not polled, and an interrupted prompt goes off screen answered Cancel. The chat's actions run the same way in `ChatActions`' scope.
- Work over a connected host runs in its `ChatLink` (`link.run`): a new connection, a Disconnect or the chat's end interrupts it, so a late reply never lands.
- Ports that receive untrusted data decode and size-bound every reply. The chat trusts its ports' outputs and checks only their meaning: echoed sources and selections, cursors, offsets, authority and liveness.
- Lists and setup follow their port's watch; nothing polls on a timer.
- An open or a reveal is its caller's (`EditorSession.runWithCaller`): interrupting the caller abandons it before it changes the view. Saves, file operations and closes are the editor's (`EditorSession.run`), which only closing the editor interrupts; a caller interrupted meanwhile just stops waiting.
- Opening and switching the chat (`ChatHost`) and preparing Quit (`MoonbaseApplication.prepareQuit`) belong to the host and the application: later callers join the step running, and an interrupted caller only stops waiting.

Errors (D14) and host text (D11):

- The editor fails with `EditorError` (a `reason`) or the workspace's tagged errors; the chat with `ChatRefusedError`, `DraftStorageError`, `TranscriptReadError`, a host's contract errors or IPC's.
- `describeEditorFailure`, `describeChatFailure` and `describeApplicationFailure` are the only places a failure becomes shown text, built from fixed text and fields. A host's own words never reach the screen; anything unknown shows fixed text.
- `EditorAlerts.report` shows a string as it is, so pass a string only for copy Moonbase wrote.
- Decide on what a failure means through `@moonbase/contracts/error-groups` (the chat's `isChatUnavailable` and `isChatConflict` add its own reasons), never by matching a code or message.

## Checks

```sh
bun run --cwd packages/application typecheck
bun run --cwd packages/application lint
bun run --cwd packages/application test
```

Tests mirror `src/` under `test/`; the editor's run over the one fixture `test/editor/editor-fixture.ts`.
