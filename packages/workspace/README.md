# Workspace

`@moonbase/workspace` is the macOS workspace service in two layers: a **file host** (file reads, version-checked saves, create/move/copy and Finder Trash; Git status and comparisons, file lookup and watching; and journals of the saves and operations it admitted) and a **client recovery store** (drafts, editor state and the client's record of what it sent). It implements the workspace contracts and is independent of the editor UI. The [daemon](../../apps/daemon/README.md) composes the file host and serves it over its WebSocket in both modes; Electron composes only the recovery store, over the daemon's host (`RemoteWorkspaceHostLive`).

## Integration

- `WorkspaceHostLive(config)` provides `WorkspaceHostService` (everything except recovery, plus `saveStatus`, `acknowledgeSave` and `listOperations`), the privileged `WorkspaceNative` service for approved native imports, and `WorkspaceFolders` (see Chat folders). It keeps approvals and journals in `workspace-host.sqlite` in `dataDirectory`.
- `WorkspaceRecoveryLive({dataDirectory, installationId, hostWaitMs?}, host)` provides the full client-facing `WorkspaceService` over a host service, local or remote. It keeps drafts and editor state in `moonbase-workspace-v1.sqlite`. Loading recovery gives its host phases (feed, evidence, verification) `hostWaitMs` (5 s) together; once it runs out they stop their host calls and are retried on the next load. Local work (drafting unsettled saves) still runs, and a failing phase or another client's unreadable recovery is reported in `errors` without hiding drafts.
- `WorkspaceLocalLive(config)` composes both in one process (Electron main composes only the recovery store, over the daemon's host); see [`examples/local.ts`](examples/local.ts).

Compose each once in a process root's runtime. The workspace opens only on macOS with Node 26.13 or newer, the pinned Electron (45.1.0) or exactly Bun 1.4.4, and is refused as `Incompatible` otherwise. Configure a stable `hostId` and a `dataDirectory` outside approved checkouts. A packaged process (the daemon) must supply absolute `filesystemHelper` and `ripgrepExecutable` paths. System Git defaults to `/usr/bin/git`; when the Xcode command-line tools are missing, Git runs fail as `Unavailable` and the macOS installer prompt is never triggered. Without them even a plain folder can't be opened (`Unavailable`).

**Root policy.** `reserved` lists paths (such as a daemon's token and credentials) that no checkout root, worktree location or import source may hold or sit inside, nor the host's own `dataDirectory`, compared by real path (resolved once, when the host starts), folded for case, whether or not they exist yet, and checked again on every use of an approved checkout. `allowRoot(real, requested)` is an optional predicate for a host's owner: it runs when a root is opened (`requested` is the path as named, so a link can be refused), for the parent of a new worktree's location, and on every later use of an approved checkout, so a root replaced since, or one a narrower policy no longer allows, grants nothing. A refusal or throw denies as `Unauthorized`.

## File host and recovery

The host journals each save and operation under `(installationId, clientId, requestId)` and replays its recorded outcome for the same ID. `createWorktree` and `initializeRepository` carry a request ID and replay their first success or deterministic refusal (`InvalidInput`, `Unauthorized`, `Conflict`, `Incompatible`) the same way; a transient failure (`Unavailable`, `Cancelled`, `Persistence`) is not recorded, so a retry with the same ID runs again, while `Uncertain` (cleanup was incomplete; inspect what the error names) keeps the reservation and a replay reports the request interrupted, as does a concurrent duplicate of a running request. If `git init` succeeded but opening the new checkout then failed transiently, a retry with the same ID is refused `Conflict` because the repository already exists; the user should reopen it. An entry stays until its client acknowledges it (`acknowledgeSave`, `acknowledgeOperation`), then for `journalRetentionMs` (7 days by default); unacknowledged entries are never discarded. `assertSettled` and `initializeRepository` consult only these journals. Results carry no `recoveryChanges`. `saveStatus` of a request the host never saw answers `not-started` and remembers the ID (for the retention window), so a delayed copy of that request is refused `Conflict` and never runs after the client discarded its intent.

Completed moves, copies and Trash also enter an operation feed with a store-wide, increasing sequence. `listOperations({checkout, after})` returns one bounded page after a sequence (at most 64 entries and about 4 MiB of JSON beyond the first entry, so a page always fits a socket reply), with `through`, `floor` (entries up to it may have been discarded) and `more`.

The client records a save or operation intent (text, baseline) before sending it, and applies the reply, `saveStatus`, `operationStatus` or feed entry to its recovery in one local transaction. `loadRecovery` resolves open intents through the host: `saved` and `conflict` settle them, `not-started` restores the text as a draft, `uncertain` keeps the draft and reports it. A lost reply is never sent again as new work. `loadRecovery` also reads the feed after its per-host cursor and reconciles drafts and views of its checkouts, so another client's move re-paths a draft and its Trash leaves it. A gap past the host's retention leaves drafts where they are and reports them. This client's own results are applied as they return, so its own feed entries are skipped. The feed carries the host store's epoch and a floor per checkout: a different epoch (a recreated store) resets the cursor and marks every checkout's drafts as a gap, and a checkout the host refuses is skipped and reported while the others advance. A settled save or operation whose acknowledgement did not reach the host is acknowledged again on the next load.

## Repeated requests

`createWorktree` and `initializeRepository` are sent under a request ID stored in the client store before sending, keyed by the call. A repeat of the same call after a lost reply (or a restart) asks the host for the first outcome. The ID is kept only while the outcome is unknown (`Uncertain`, or cancelled); an answer, a refusal included, ends it, because the host replays a refusal for the same ID.

## Search

`lookupFiles` ranks file paths; `searchText` finds text in file contents (fixed string or regular expression, optionally case-sensitive or whole-word). Both run the configured ripgrep in the checkout, honour `.gitignore`, `.ignore` and `.rgignore`, and skip VCS folders and `node_modules`. Text search returns up to 50 matches per file and 500 in all, each with its UTF-16 match ranges and three lines either side, and reports a partial result when capped; ripgrep is stopped as soon as the result is full.

## Plain folders

A folder in no Git repository opens as a plain-folder checkout (`vcs: 'none'`), whose `projectId` comes from the host and the folder's identity; a folder inside a repository but not at its top is refused. On a plain folder `gitStatus`, `listWorktrees` and `getIgnoredPaths` return empty results, while `readComparison` and `createWorktree` fail with `InvalidInput`. `initializeRepository` runs `git init` (no commit) in a plain folder with no `.git` entry and no unsettled saves or file operations, and returns its Git checkout, which keeps its `checkoutId` and replaces the folder's approval; reopening a folder that became its own repository some other way (its main working tree, with its own `.git` folder) does the same.

## Git status

`gitStatus` lists one change per differing area (`staged`, `unstaged` or `untracked`) with its kind: modified, added, deleted, untracked or typechange. An unmerged path is a single `conflicted` change instead, marked `missing` when both sides deleted it. Renames are not detected, so a moved file is deleted at its old path and added or untracked at its new one.

## Watching

`watch` reports changes under the checkout and, for a repository, in its Git folder, at most every 100 ms. It skips changes that belong to other worktrees of the same repository: files in a worktree nested inside the checkout, another worktree's private Git folder or index, new objects and lock files. Shared refs still count.

## Chat folders

`createChatWorktree({installationId, requestId, root, branch})` opens the checkout at `root`, then makes `branch` from its current commit in a linked worktree at `<main worktree>-worktrees/<branch>` (a `/` in the branch is `-` in the folder). The host derives the location, so a client never names where directories are made. It accepts a simple branch name only; a taken branch or location, or a name with branches inside it (`chat` when `chat/topic` exists), gets `-2`, `-3` and so on (up to 20 tries, then `Conflict`), and a nested name one of whose folders is a branch (`chat/topic` when `chat` exists) falls back to `chat-topic`; any other Git failure is that request's failure. The policy (`allowRoot`, reserved paths) is applied to the parent of `<main worktree>-worktrees` before anything is made; the folder is kept once made, even if it ends empty. The request is journalled like `createWorktree`: a repeat with the same request ID returns the same checkout, an interrupted one is `Uncertain`. Only a deterministic outcome is recorded for a request ID (a success or a refusal such as `InvalidInput`, `Unauthorized`, `Conflict` or `Incompatible`) and replayed; a transient failure (`Unavailable`, `Cancelled`, `Persistence`, `Uncertain`) is not, so a retry with the same ID runs again.

`turnChatIntoProject({installationId, requestId, target})` asks the injected `chats` (`ChatFolders`) for the chat's own folder, which must be a direct child of the chats folder (any other folder is refused); opens that folder as a checkout (refused if it opens elsewhere, as through a link); and only then marks the chat as in a project, so a failure leaves the chat as it was. It is journalled by request ID, and `Incompatible` without `chats`.

`WorkspaceFolders.has(path)` is true only for the root of an approved checkout (a worktree counts once it is opened itself; `createChatWorktree` opens the ones it makes). It looks the approval up by root and re-checks its identity, the reserved paths and the root policy as any use does, runs no Git, approves nothing and holds no state, so a checkout replaced since it was approved is not a folder. A daemon uses it so chats need no other grant for the editor's projects.

`captureImports({checkout, clientId, paths})` and `releaseImports` hold native files as single-use references for five minutes, bound to the client and checkout. It is a mutation for deadlines and lost replies (60 s; a lost reply is `Uncertain`, and unreleased references expire after five minutes) but is not journalled. The caller must pass only paths from a native picker or drop, never a path a renderer supplied. A source is held to the reserved paths only, not the root policy, so a host-mode daemon sets `nativeImports: false` and both answer `Incompatible`.

## Worktrees

A `CheckoutTarget` says whether its root is the repository's `main` working tree or a `linked` worktree; every worktree of one repository shares its `projectId`. `listWorktrees` returns a project's worktrees from `git worktree list` (main first; bare repositories have none). `createWorktree` adds a new branch at a base commit in a new linked worktree at an absolute location whose parent exists, then approves and returns it like `openCheckout`. Creations in one project run one at a time; one cancelled while waiting ends at once. Taken branches and locations, including a location still registered to a worktree whose folder is missing or whose spelling differs only in case or Unicode normalization (a location is made in NFC, as Git names it), are refused before Git adds anything; the branch is created only if absent, with a reflog entry naming this creation. A location whose earlier worktree was removed may be used again, and the new directory is approved afresh only if it is exactly that location in the same repository (opening a replaced directory otherwise stays refused). Git adds it only while the location's parent is still the folder that was checked. The new worktree is locked with a reason naming this creation from the start of `git worktree add` until it is approved, then unlocked; an unlock that fails is reported when the workspace closes, without undoing the creation. If Git fails, stops or the request is cancelled, only what this creation added is removed: the worktree still holding its lock, on its branch at its commit (with anything its hooks wrote), and the branch while it is not a symbolic ref, has not moved and its latest reflog entry is still this creation's. Anything else is left and the error is `Uncertain`. Otherwise the error is `Uncertain` and names what to inspect. Each Git step shares the helper's 30-second limit.

## Safety

- Only native, user-approved checkout identities grant filesystem access; path strings from clients grant nothing.
- Trash is the Trash of the user the process runs as (a host's own, `~/.Trash`, or `.Trashes/<uid>` on another volume), moved by the helper that holds the file's descriptor. A volume without a Trash fails, and nothing falls back to permanent deletion.
- Saves check content versions. Replacing an existing file requires explicit consent and moves the old one to Trash.
- Helper processes run in their own process group. Stopping one (cancellation, a limit) sends the group SIGTERM, then SIGKILL after 2 seconds, and waits for it to exit, so Git and its children can clean up first. A run ends when the helper exits (after 100 ms for its last output), not when its pipes close, so a process it left running outside its group, such as one a hook started, holds neither the reply nor shutdown.
- Files must be UTF-8 text up to 2 MiB. Filesystem changes and SQLite commits are not one atomic transaction.
- A client's settled save and operation records and publication receipts are never compacted; only the host journal is.

## Checks

Requires macOS with Xcode command-line tools:

```sh
bun run --cwd packages/workspace build
bun run --cwd packages/workspace typecheck
bun run --cwd packages/workspace lint
bun run --cwd packages/workspace test
```

Tests run under `bun test` (1.4.4) and use temporary repositories and stores and the real native helper. Run them serially with other resource-heavy suites. Source calls `fs.closeSync` and `fs.watch` through the default `node:fs` import so tests can mock them; Bun's named imports are not live bindings.
