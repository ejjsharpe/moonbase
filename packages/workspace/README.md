# Local workspace

`@moonbase/workspace` is a reusable local macOS workspace service, independent of the editor UI or client shell. It handles:

- Files: reading, version-checked saves, create/move/copy and Finder Trash.
- Discovery: Git status/comparisons, file lookup and filesystem watching.
- Recovery: SQLite storage for drafts, editor state and interrupted operation results.

It implements the contracts in [`@moonbase/application`](../application/README.md). Clients such as the [editor](../editor/README.md) own buffers, rendering and Save/Discard/Cancel decisions; workspace owns local IO, validation and persistence.

## Integration

`WorkspaceLive(config)` provides the scoped `WorkspaceService` and privileged `WorkspaceNative` service for approved native imports. Compose it once in the process root’s Effect runtime and use the shared application handlers/client for all entry points. Dispose the runtime after the editor’s preservation gate succeeds.

Configure a stable `hostId` and a fresh `dataDirectory` outside approved checkouts. State lives in `moonbase-workspace-v1.sqlite`; legacy state is never read, imported or removed. Packaged apps must supply absolute `filesystemHelper` and `ripgrepExecutable` paths, shipping the native helper outside asar and standalone ripgrep 15.2.0. System Git defaults to `/usr/bin/git`.

See the [standalone example](examples/local.ts) for runtime/client wiring and [public types](../application/src/client.ts) for commands and results.

## Safety

Only native/user-approved exact checkout identities grant filesystem access. Saves check content versions; replacements require explicit consent and use Trash. Consumers must preserve affected dirty drafts before mutations, retain immutable request identities across retries, and block destructive actions while outcomes are uncertain. Recovery uses compare-and-swap revisions and [exact publication receipts](../application/docs/RECOVERY-PUBLICATIONS.md).

Files must be strict UTF-8 text up to 2 MiB. The journal retains saved text without compaction. Filesystem changes and SQLite commits are not one atomic transaction. Power-loss survival, packaged Electron behavior and human accessibility acceptance require separate qualification.

## Build and check

Requires macOS with Xcode command-line tools. From the repository root:

```sh
bun run --cwd packages/workspace build
bun run --cwd packages/workspace typecheck
bun run --cwd packages/workspace lint
bun run --cwd packages/workspace test
```

The [editor/workspace integration suite](../../tests/editor-workspace/README.md) checks the public module boundary.
