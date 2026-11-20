# Contracts

`@moonbase/contracts` holds the definitions every other module shares: DTOs, commands, schemas, tagged errors, RPC groups and Effect service ports. It imports only its own files and Effect, creates no runtime and implements nothing; the packages and apps that serve or call these contracts do.

## Public interface

| Subpaths | What they give |
| --- | --- |
| `chat`, `chat-schema`, `chat-rpc`, `chat-validation`, `chat-errors` | Chat DTOs and commands, their decoders, `ChatRpcs`, `checkChatOutput` (an Effect checking a decoded reply echoes its request, stays within its authority and fits the reply limit) and the chat errors |
| `workspace`, `workspace-schema`, `workspace-service` | The client-facing workspace: targets (`CheckoutTarget`, plain folder or Git), files, Git, operations, limits such as `maximumFileBytes`, and the `WorkspaceService` port |
| `workspace-host`, `workspace-host-schema`, `workspace-rpc`, `workspace-host-errors`, `workspace-errors` | The file host's commands (journalled by installation, client and request ID), `WorkspaceRpcs`, the host's errors (`WorkspaceHostError`) and the client's (`WorkspaceError`) |
| `recovery`, `recovery-schema` | The client recovery store's buffer-keyed format (`RecoveryState`, `RecoveryOutline`), `loadRecovery` and its edits |
| `daemon`, `daemon-schema`, `daemon-rpc`, `folder-errors` | The daemon's operations beyond chat (`LocalHostCommand`, `HostProviderCommand`, each mapped to a capability by `daemonCommandCapabilities`), `FolderApprovals`, `LocalHostRpcs`, `ProviderSetupRpcs` and the folder errors |
| `providers`, `providers-schema`, `provider-errors` | Provider setup state and commands, `readProviderSignInUrl` and the provider setup errors |
| `connection`, `connection-schema`, `connection-errors` | Connection profiles and snapshots, and `ConnectionFailure` |
| `host`, `host-schema`, `host-errors` | Protocol version, capabilities and signed health; the host link's errors (`hostErrors`, `DaemonLinkError`, `RequestReusedError`) |
| `rpc-upgrade`, `rpc-admission`, `rpc-annotations` | Both sockets' paths, protocols and limits; `RpcAdmission`, the middleware every procedure declares and daemon-protocol's server implements; `Mutation` and `StatusCall`, the annotations that say on each `Rpc` whether it changes state or resolves an `Uncertain` one, which clients and servers read instead of keeping lists of names |
| `watch`, `watch-schema` | Watch values and deltas: `applyWatchDelta`, `decodeWatchValue` |
| `errors`, `error-groups` | The shared outcomes and what a failure means (below) |
| `ipc-errors` | What desktop IPC fails with, here because the application reads them |
| `services` | Privileged Effect service ports: `ChatService`, `ConnectionService`, `ProviderSetupService`, `LocalHostService`, `WorkspaceHostService` |
| `schema`, `common`, `lookup`, `paths`, `files` | Small shared helpers: schema constructors, JSON equality and keys, fuzzy path ranking (`matchPath`), relative path joins, `isPrivateTo` |

## Errors (D14)

- Each module defines `Schema.TaggedError` classes named for what happened, with literal fields (`problem`, `reason`, `refusal`) and a `message` built from them. Each exports its classes (`chatErrors`, `fileHostErrors`, …), its union type and a guard.
- Each RPC procedure declares the union it can fail with (`chatErrorSchemaOf`, `daemonErrorSchemas`, `workspaceErrorSchemaOf`), always including `hostErrors`. Handlers pass service errors on, and the UI turns tags into text.
- `UncertainError` (may have committed: check, never resend), `CancelledError` and `UnauthorizedError` in `errors` are the outcomes every caller treats the same.
- A decision that depends on what a failure means rather than what failed asks `error-groups` (`isRefusal`, `isConflict`, `isUnavailable`, `isUncertain`, …). `isKnownError` says whether a failure is one contracts defines, so its message may be shown.
- An error sent to or received from an untrusted host carries no cause, path or text the host wrote (D11). A field holding host text, such as Git output, is optional so a client can drop it.

## Rules worth knowing

- Decode at the edge only (D7): values are decoded where they enter a process (RPC, IPC, files) with the `*-schema` decoders, and typed values inside a process are trusted. A decoder throws the schema's own error, with input reporting off.
- `services` is privileged: `ConnectionService.endpoint` carries an origin and token that must never reach renderers, settings or logs. `WorkspaceService` carries no credential, so the renderer may take it.
- Client entries bundle only contracts and portable Effect; type-only imports emit no runtime code.
- The host protocol is version 3 (`chatProtocolVersion`). A host advertises what it serves in its signed health (`chatHostCapabilities`); a client checks the capability before calling, and the server refuses a daemon operation whose capability it does not advertise.
- Mutations carry request IDs that their replies echo.

## Checks

```sh
bun run --cwd packages/contracts typecheck
bun run --cwd packages/contracts lint
bun run --cwd packages/contracts test
```

Tests run under `node --test` and need no macOS.
