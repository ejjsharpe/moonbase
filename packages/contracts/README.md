# Contracts

`@moonbase/contracts` holds the definitions shared by application, presentation and infrastructure: DTOs, command/client interfaces, schemas, errors and Effect service ports. It imports only its own definitions and Effect, and creates no runtime.

| Subpath | Contents |
| --- | --- |
| `workspace`, `chat`, `connection`, `host`, `providers`, `daemon` | Browser-safe DTOs, command/client interfaces and protocol constants |
| `errors`, `common` | `ApplicationError`, error codes, `CommandOptions`, `ObservationClose`, and `areJsonValuesEqual` / `getJsonKey` (key-order-safe equality and keys for plain decoded data) |
| `workspace-host`, `workspace-host-schema` | The file host's operations: the workspace commands without recovery, journalled with an installation, client and request ID, plus `saveStatus`, `acknowledgeSave` and `listOperations` (the operation feed, a page also bounded in bytes), with request IDs on `createWorktree` and `initializeRepository`, and `createChatWorktree`, `turnChatIntoProject` (journalled mutations) and local-mode `captureImports` and `releaseImports`; which are mutations, their deadline classes, `WorkspaceWatchValue` and the promise-shaped `WorkspaceHostClient` a server dispatches to |
| `lookup` | `matchPath` / `compareMatches`: the fuzzy path ranking shared by editor lookup and chat file search |
| `*-schema`, `schema` | Request, saved-data and wire-reply decoders, and shared schema constructors |
| `chat-validation` | `checkChatOutput`: a decoded chat reply's authority checks (its target, host, sources and request identity match the request) and size bound, applied by the chat engine and both ends of the daemon protocol; `isChatMutation`, `isCancellableChatRead`, `isSameChatHost` / `isSameChatTarget`, `decodeChatTarget` |
| `services` | Privileged Effect service ports and endpoint types |

Chat Find (`getChatFindExpression`) matches the literal query in original text with simple Unicode case folding and no normalization: ẞ matches ß and Σ matches ς, but ß never matches SS and NFC/NFD spellings differ.

A message's file mentions are relative paths in its working folder, each spelled in the text by `formatChatMention` (`@path`, or `@"path"` with whitespace), so the text alone still names every file. `findChatFiles` searches an existing chat's folder, or a folder a new chat may use.

A local chat's creation settings may leave out `cwd` for a chat without a project; the host gives it a folder of its own and lists it with `ownFolder: true`.

The host protocol is version 2 (`chatProtocolVersion`). `chatHostCapabilities` names what a host's signed health may advertise: `chat-v0` on every host, on the daemon in either mode `daemon-local-v1`, `providers-v1`, `folders-v1` and `socket-v1`, on one that composes the workspace file host `workspace-v1`, and on a host-mode daemon `roots-v1` (`listHostFolders`: its approved roots and their folders). `daemon-schema` decodes the daemon's operations beyond chat, each mapped to the capability it needs (`daemonCommandCapabilities`): folder approvals and control (`LocalHostCommand`, served by the `LocalHostService` port) and provider setup on the wire (`HostProviderCommand`, naming a host and owner). Mutations carry request IDs that their replies echo. `FolderApprovals` is the daemon's folder authority (which working folders its chats may use). `daemonErrorReasons` lists the reasons a refused daemon operation may name, each with one code and the fixed message clients show. A `ConnectionProfile`'s `remotePort` is optional: SSH requires it, and a loopback connection fills it once it has read the daemon's port. `readProviderSignInUrl` accepts only https pages on a provider's sign-in origin.

The WebSocket protocol (`socket`, `socket-schema`; capability `socket-v1`) is one connection per client at `socketPath` (`/v2/socket`). The server sends a `challenge`; every message after it, in both directions, is binary: a 32-byte HMAC-SHA256 of the JSON body, then the body, which carries the connection's next `seq`. The client's first message, `hello`, binds its nonce, the challenge, the protocol and the host, from which both directions' frame keys are derived under `socketDomain`; the server answers with `welcome` and its health. Clients send `request {id, operation, input}` (any chat, daemon or, with `workspace-v1`, file host operation, with the same inputs), `requestChunk {id, offset, total, data}` (one chunk of a workspace request's `{operation, input}` JSON that exceeds a frame, up to `workspaceRequestBytes`; chunks go back to back), `cancel`, `subscribe {subscriptionId, kind, target, afterSequence?}` for `chat`, `chatList` (`ChatListState`: the first page and changed chats past it) `providerSetup` (an owner) or `workspace` (a checkout; the value `WorkspaceWatchValue` is always sent whole), `unsubscribe` and `heartbeat`. A reply's JSON (`SocketReply`) and a snapshot's arrive as base64 chunks of `socketLimits.chunkBytes`; a chat or daemon reply or snapshot is at most `payloadBytes`, a workspace reply at most `workspaceReplyBytes` and its chunks are interleaved with updates. Each subscription numbers its updates: a `snapshot` resets it, a `delta` from `base` applies with `applySocketDelta` (appended live text and replaced parts of the running response, chat-list rows upserted and removed with their order and changed chats past the page upserted with theirs, changed provider setup fields), and `error` ends it. `socketLimits` holds the bounds, heartbeat and idle timeouts. `bun run --cwd packages/contracts socket-schema` writes `socket-v1.schema.json`, the protocol's JSON Schema for clients not written in TypeScript (CI checks it is current with `check:socket-schema`); byte bounds and some value checks hold only in the Effect Schemas.

`ChatClient.watchChatList` and `ChatService.watchChatList` deliver the chat list's first page and the chats past it that changed while watching (`ChatListUpdate`: `{ list, changed, dropped, reset }`; `reset` after missed updates, and a growing `dropped` count when changed chats were let go) and again after each change; `ProviderSetupClient.watch` and `ProviderSetupService.watch(ownerId)` deliver an owner's setup state the same way, so nothing polls.

`settleChat` settles or unsettles a chat (`{ target, settled }`) and returns its summary, whose `settledAt` says when it was settled.

The file host (`WorkspaceHostService`) reports a save as `saved` (with the version of the request's text, which the client holds) or `conflict` and an operation with its items, and carries no editor recovery. `saveStatus` answers `saved`, `conflict`, `not-started` (the request never reached the host) or `uncertain`. `listOperations {checkout, after}` returns one page of completed moves, copies and Trash after a feed sequence, with `through` (what the page covers), `floor` (entries up to it may have been discarded) and `more`; `after: null` only reports the present position. The client-facing `WorkspaceService` carries the host's commands and results plus the client's recovery, including `recoveryChanges`.

A `CheckoutTarget` is a Git checkout (`vcs: 'git'`, with `branch` and `worktree`: `main` or `linked`) or a plain folder (`vcs: 'none'`); worktrees of one repository share `projectId`. Saved targets without `vcs` decode as Git.

Client entries use type-only schema imports, so they emit no Effect runtime code. `services` is privileged: `ConnectionService.endpoint` carries origin and key data that must never reach renderers, settings or logs.

```sh
bun run --cwd packages/contracts typecheck
bun run --cwd packages/contracts lint
bun run --cwd packages/contracts test
```
