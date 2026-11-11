# Workspace

`@moonbase/workspace` is the local macOS workspace service: file reads, version-checked saves, create/move/copy and Finder Trash; Git status and comparisons, file lookup and watching; and SQLite recovery storage for drafts, editor state and interrupted operations. It implements the workspace contracts and is independent of the editor UI.

## Integration

`WorkspaceLive(config)` provides `WorkspaceService` and the privileged `WorkspaceNative` service for approved native imports. Compose it once in a process root's runtime; the workspace opens only on macOS with Node 26.13 or newer, the pinned Electron (45.1.0) or exactly Bun 1.4.4, and is refused as `Incompatible` otherwise; see [`examples/local.ts`](examples/local.ts). Configure a stable `hostId` and a `dataDirectory` outside approved checkouts. Packaged apps must supply absolute `filesystemHelper` and `ripgrepExecutable` paths. System Git defaults to `/usr/bin/git`.

## Search

`lookupFiles` ranks file paths; `searchText` finds text in file contents (fixed string or regular expression, optionally case-sensitive or whole-word). Both run the configured ripgrep in the checkout, honour `.gitignore`, `.ignore` and `.rgignore`, and skip VCS folders and `node_modules`. Text search returns up to 50 matches per file and 500 in all, each with its UTF-16 match ranges and three lines either side, and reports a partial result when capped; ripgrep is stopped as soon as the result is full.

## Plain folders

A folder in no Git repository opens as a plain-folder checkout (`vcs: 'none'`), whose `projectId` comes from the host and the folder's identity; a folder inside a repository but not at its top is refused. On a plain folder `gitStatus`, `listWorktrees` and `getIgnoredPaths` return empty results, while `readComparison` and `createWorktree` fail with `InvalidInput`. `initializeRepository` runs `git init` (no commit) in a plain folder with no `.git` entry and no unsettled saves or file operations, and returns its Git checkout, which keeps its `checkoutId` and replaces the folder's approval; reopening a folder that became its own repository some other way (its main working tree, with its own `.git` folder) does the same.

## Git status

`gitStatus` lists one change per differing area (`staged`, `unstaged` or `untracked`) with its kind: modified, added, deleted, untracked or typechange. An unmerged path is a single `conflicted` change instead, marked `missing` when both sides deleted it. Renames are not detected, so a moved file is deleted at its old path and added or untracked at its new one.

## Watching

`watch` reports changes under the checkout and, for a repository, in its Git folder, at most every 100 ms. It skips changes that belong to other worktrees of the same repository: files in a worktree nested inside the checkout, another worktree's private Git folder or index, new objects and lock files. Shared refs still count.

## Worktrees

A `CheckoutTarget` says whether its root is the repository's `main` working tree or a `linked` worktree; every worktree of one repository shares its `projectId`. `listWorktrees` returns a project's worktrees from `git worktree list` (main first; bare repositories have none). `createWorktree` adds a new branch at a base commit in a new linked worktree at an absolute location whose parent exists, then approves and returns it like `openCheckout`. Creations in one project run one at a time; one cancelled while waiting ends at once. Taken branches and locations, including a location still registered to a worktree whose folder is missing or whose spelling differs only in case or Unicode normalization (a location is made in NFC, as Git names it), are refused before Git adds anything; the branch is created only if absent, with a reflog entry naming this creation. A location whose earlier worktree was removed may be used again, and the new directory is approved afresh only if it is exactly that location in the same repository (opening a replaced directory otherwise stays refused). The new worktree is locked with a reason naming this creation from the start of `git worktree add` until it is approved, then unlocked; an unlock that fails is reported when the workspace closes, without undoing the creation. If Git fails, stops or the request is cancelled, only what this creation added is removed: the worktree still holding its lock, on its branch at its commit (with anything its hooks wrote), and the branch while it is not a symbolic ref, has not moved and its latest reflog entry is still this creation's. Anything else is left and the error is `Uncertain`. Otherwise the error is `Uncertain` and names what to inspect. Each Git step shares the helper's 30-second limit.

## Safety

- Only native, user-approved checkout identities grant filesystem access; path strings from clients grant nothing.
- Saves check content versions. Replacing an existing file requires explicit consent and moves the old one to Trash.
- Helper processes run in their own process group. Stopping one (cancellation, a limit) sends the group SIGTERM, then SIGKILL after 2 seconds, and waits for it to exit, so Git and its children can clean up first.
- Files must be UTF-8 text up to 2 MiB. Filesystem changes and SQLite commits are not one atomic transaction.

## Checks

Requires macOS with Xcode command-line tools:

```sh
bun run --cwd packages/workspace build
bun run --cwd packages/workspace typecheck
bun run --cwd packages/workspace lint
bun run --cwd packages/workspace test
```

Tests run under `bun test` (1.4.4) and use temporary repositories and stores and the real native helper. Run them serially with other resource-heavy suites. Source calls `fs.closeSync` and `fs.watch` through the default `node:fs` import so tests can mock them; Bun's named imports are not live bindings.
