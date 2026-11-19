# Workspace

`@moonbase/workspace` is the macOS workspace service in two layers. The **file host** owns file reads, version-checked saves, create/move/copy, Finder Trash, Git status and comparisons, worktrees, file lookup and text search, watching, and the journals of the saves and operations it admitted. The **client recovery store** owns one client's drafts, editor state and its record of what it sent. It implements the workspace contracts and knows nothing of the editor UI. The [daemon](../../apps/daemon/README.md) composes the file host and serves it over its workspace socket; Electron main composes only the recovery store, over the daemon's host (`RemoteWorkspaceHostLive` from daemon-protocol).

## Public interface

| Export | What it gives |
| --- | --- |
| `.` `WorkspaceHostLive(config)` | The file host: `WorkspaceHostService` (every host command, its errors the tagged `WorkspaceHostError`s) and `WorkspaceFolders`. Approvals and journals live in `workspace-host.sqlite` in `dataDirectory` |
| `.` `WorkspaceRecoveryLive({dataDirectory, installationId?, hostWaitMs?}, host)` | The client-facing `WorkspaceService` over a local or remote host, failing with `WorkspaceError`s. Drafts and editor state live in `moonbase-workspace-v1.sqlite` |
| `.` `WorkspaceLocalLive(config)` | Both in one process; see [`examples/local.ts`](examples/local.ts) |
| `.` `readInstallationId(dataDirectory)` | An Effect of the recovery store's installation ID (minted once and kept there), for a process that needs it before composing the store |
| `.` `WorkspaceFolders` | `has(path)`: whether a path is the root of an approved checkout, re-checked as any use is. It approves nothing; a daemon uses it so chats need no other grant for the editor's projects |
| `.` types | `WorkspaceHostConfiguration`, `WorkspaceConfiguration`, `WorkspaceRecoveryConfiguration`, `RootPredicate`, `ChatFolders` |
| `./filesystem` | The built native helper binary (`dist/filesystem`), which packaging copies beside the daemon |

Compose each layer once in a process root's runtime; closing it stops every operation and waits for its helpers before the stores close. Configure a stable `hostId` and a `dataDirectory` outside approved checkouts. A packaged process must pass absolute `filesystemHelper` and `ripgrepExecutable` paths. Git defaults to `/usr/bin/git`.

## Rules worth knowing

- Only native, user-approved checkout identities grant filesystem access; path strings from clients grant nothing.
- Root policy is re-checked on every use of an approved checkout, not only when it is opened. No root, worktree location or import source may hold or sit inside a `reserved` path (such as a daemon's token and credentials) or the host's `dataDirectory`, compared by real path. `allowRoot(real, requested)` is an optional Effect predicate; a refusal, failure or defect denies with `CheckoutAccessError` (`outside-policy`).
- The host journals each save and operation by `(installationId, clientId, requestId)` and replays the recorded outcome for a repeated ID. An interrupted one is settled from the disk, never repeated: a save is `saved` if the disk holds its text, else `conflict`, and stays `uncertain` if the file can't be read; an operation item is `completed` if the disk shows its effect, else `failed`.
- Journal entries stay until their client acknowledges them (`acknowledgeSave`, `acknowledgeOperation`), then for `journalRetentionMs` (7 days by default). A status asked for an unseen request ID retires that ID, so a delayed copy is refused.
- The client records a save or operation intent before sending it and applies the reply in one local transaction. A lost reply is never resent as new work: the client asks the host for the outcome, and a request the host never saw is repeated under a new ID.
- The client recovery store is the only writer of recovery. Edits (`openTab`, `closeTab`, `updateDraft`, `updateLayout`) name buffers, apply one at a time in arrival order, and return once committed; drafts are never discarded by a save or operation outcome.
- Completed moves, copies and Trash enter the host's operation feed (`listOperations`, paged per checkout), which `loadRecovery` reads so another client's move re-paths a draft.
- A folder in no Git repository opens as a plain-folder checkout (`vcs: 'none'`); a folder inside a repository but not at its top is refused.
- `createChatWorktree` derives the worktree's location (`<main worktree>-worktrees/<branch>`), so a client never names where directories are made.
- `createWorktree`, `initializeRepository`, `createChatWorktree` and `turnChatIntoProject` are journalled by request ID like saves. A success or a deterministic refusal (refused as given, an access refusal, a conflict or incompatible) replays for the ID, the refusal as `RecordedRefusalError`; a cancelled, unavailable or unknown failure releases the ID, so a retry under it runs again.
- Trash never falls back to permanent deletion. Replacing an existing file requires naming it in `replacements`, and the old one goes to Trash.
- Saves are version-checked against the file's content version.
- Helper processes run in their own process group (`@moonbase/process-group`). Stopping one sends SIGTERM, then SIGKILL after 2 seconds, and waits up to 4 seconds in all for the group to exit. A helper whose group can't be confirmed gone keeps its run, and so its checkout, until the helper itself has exited; a capped run then fails as uncertain.
- Files must be UTF-8 text up to 2 MiB. Filesystem changes and SQLite commits are not one atomic transaction.
- `captureImports` can't tell where a path came from, so its caller must pass only paths from a native picker or drop. Its sources are held to `reserved` only, so a host-mode daemon sets `nativeImports: false`.
- The file host opens only on macOS under exactly Bun 1.4.4 and is otherwise refused with `WorkspaceUnsupportedError` (`runtime`). Without the Xcode command-line tools Git fails with `WorkspaceUnavailableError` (`git-tools`), and the installer prompt is never triggered.

## Checks

Requires macOS with the Xcode command-line tools:

```sh
bun run --cwd packages/workspace build
bun run --cwd packages/workspace typecheck
bun run --cwd packages/workspace lint
bun run --cwd packages/workspace test
```

The whole suite is macOS-only: `test:macos` is `test`, and there is no `test:linux`. Tests use temporary repositories and stores and the real native helper; `build` also compiles the race tests' pausing helpers into `dist/test/`. Code that tests mock (`fs.closeSync`, `fs.watch`) is called through the default `node:fs` import, since Bun's named imports are not live bindings.
