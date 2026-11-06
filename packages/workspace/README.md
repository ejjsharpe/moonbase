# Workspace

`@moonbase/workspace` is the local macOS workspace service: file reads, version-checked saves, create/move/copy and Finder Trash; Git status and comparisons, file lookup and watching; and SQLite recovery storage for drafts, editor state and interrupted operations. It implements the workspace contracts and is independent of the editor UI.

## Integration

`WorkspaceLive(config)` provides `WorkspaceService` and the privileged `WorkspaceNative` service for approved native imports. Compose it once in a process root's runtime; see [`examples/local.ts`](examples/local.ts). Configure a stable `hostId` and a `dataDirectory` outside approved checkouts. Packaged apps must supply absolute `filesystemHelper` and `ripgrepExecutable` paths. System Git defaults to `/usr/bin/git`.

## Worktrees

A `CheckoutTarget` says whether its root is the repository's `main` working tree or a `linked` worktree; every worktree of one repository shares its `projectId`. `listWorktrees` returns a project's worktrees from `git worktree list` (main first; bare repositories have none). `createWorktree` adds a new branch at a base commit in a new linked worktree at an absolute location whose parent exists, then approves and returns it like `openCheckout`. Taken branches and locations are refused before Git runs; if Git fails or the request is cancelled, only a clean worktree and unchanged branch it added are removed, otherwise the error is `Uncertain` and names what to inspect. Each Git step shares the helper's 30-second limit.

## Safety

- Only native, user-approved checkout identities grant filesystem access; path strings from clients grant nothing.
- Saves check content versions. Replacing an existing file requires explicit consent and moves the old one to Trash.
- Files must be UTF-8 text up to 2 MiB. Filesystem changes and SQLite commits are not one atomic transaction.

## Checks

Requires macOS with Xcode command-line tools:

```sh
bun run --cwd packages/workspace build
bun run --cwd packages/workspace typecheck
bun run --cwd packages/workspace lint
bun run --cwd packages/workspace test
```

Tests use temporary repositories and stores and run the real native helper. Run them serially with other resource-heavy suites.
