# Local workspace

`@moonbase/workspace` is a reusable local macOS workspace service, independent of the editor UI or client shell. It handles:

- Files: reading, version-checked saves, create/move/copy and Finder Trash.
- Discovery: Git status/comparisons, file lookup and filesystem watching.
- Recovery: SQLite storage for drafts, editor state and interrupted operation results.

It implements the contracts in [`@moonbase/contracts`](../contracts/README.md). The [headless application editor](../application/docs/EDITOR.md) owns buffers and Save/Discard/Cancel decisions; its presentation owns rendering. Workspace owns local IO, validation and persistence.

## Integration

`WorkspaceLive(config)` provides the scoped `WorkspaceService` and privileged `WorkspaceNative` service for approved native imports. Compose it once in the process root’s Effect runtime and use the shared application handlers/client for all entry points. Dispose the runtime after the editor’s preservation gate succeeds.

Configure a stable `hostId` and a fresh `dataDirectory` outside approved checkouts. State lives in `moonbase-workspace-v1.sqlite`; legacy state is never read, imported or removed. Packaged apps must supply absolute `filesystemHelper` and `ripgrepExecutable` paths, shipping the native helper outside asar and standalone ripgrep 15.2.0. System Git defaults to `/usr/bin/git`.

Native adapters use `WorkspaceNative.capture({checkout, clientId, paths})` for approved OS selections and install a release owner before publishing the returned references. `WorkspaceNative.release({checkout, clientId, references})` promptly closes unclaimed references for that exact owner; missing or already claimed references are harmless. A batch containing another owner's known reference rejects before releasing any reference. Capture interruption joins its helper and releases unobserved results. References expire after five minutes; claim transfers their descriptors to the admitted mutation, so expiry or document cleanup cannot close a descriptor that mutation still uses.

See the [standalone example](examples/local.ts) for runtime/client wiring and [public types](../contracts/src/workspace.ts) for commands and results.

## Safety

Only native/user-approved exact checkout identities grant filesystem access. Saves check content versions; replacements require explicit consent and use Trash. Replacement names match destinations ignoring case and Unicode normalization, while consent retains the existing object's exact path and identity. Copied/imported folders retain source permission bits, including sticky and set-group-ID bits; the top-level folder receives its final mode after staging identity validation and publication. Consumers must preserve affected dirty drafts before mutations, retain immutable request identities across retries, and block destructive actions while outcomes are uncertain. Recovery uses compare-and-swap revisions and [exact publication receipts](../contracts/docs/RECOVERY-PUBLICATIONS.md).

The root scope owns command settlement, helper processes, observations and native references. Overlap leases serialize same-checkout ancestor/descendant/root and NFC/case conflicts while unrelated paths remain concurrent. Cancelling a queued operation releases its waiting lease without admission. Cancelling a caller after admission stops its wait and signals supported IO; the workspace retains the lease and descriptors until actual helper exit and recovery settlement. Save's immutable reservation remains protected through staging/replacement. No cancellation establishes rollback.

Observation close awaits its scoped watcher/debounce finalizers. Root disposal stops admissions, signals cancellable work, releases observations/unclaimed references, joins started work and helpers, then closes directory descriptors and SQLite. It attempts all releases and reports failures rather than claiming successful cleanup. These scopes use the caller's existing Effect context and acquire no runtime.

Saved recovery and private journal/approval/receipt records use strict schemas. Unfamiliar nested fields, malformed values or foreign recovery contexts reject before automatic rewriting; the affected original rows remain untouched and subsequent publication cannot overwrite them. Recognized version-one optional fields, including previous-producer Save ordering metadata, remain supported. Indexed pending/relevant reads do not parse settled Save history. This is rejection policy, with no migration, import or reset.

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
