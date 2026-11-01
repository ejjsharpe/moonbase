# Editor

`@moonbase/editor` is a reusable React/Monaco workbench with an ordinary TypeScript controller. It owns buffers, tabs, previews, navigation, view positions and recovery coordination. All IO uses an injected `EditorClient`; the renderer imports no filesystem, Electron, Effect runtime, workspace implementation or provider code.

## Use

```ts
import { createEditor } from '@moonbase/editor/state';

const editor = createEditor({ client, clientId: stableUniqueEditorId });
await editor.load();
await editor.openCheckout(approvedRoot);
```

Mount `EditorWorkbench` from `@moonbase/editor` with `controller={editor}`. Shells may supply `selectCheckout` and `selectNativeImports`; native imports use approved opaque references, never raw OS source paths. Picker, clipboard and drop share `EditorWorkbenchHandle.importFiles(checkout, references)` and its destination/replacement dialog.

| Export | Purpose |
| --- | --- |
| `.` | Workbench, UI handle, controller, state types and target key helpers |
| `./state` | Controller/types without React or Monaco |
| `./workers` | `configureMonacoWorkers()` for a browser root with Vite-compatible `?worker` support |
| `./memory` | Volatile `memoryWorkspace(seeds)` service layer for demos/tests |

Applications supply clients and own runtime disposal. A privileged composition root can use `makeEditorClient(runtime)` from `@moonbase/application/runtime-client`; isolated renderers receive a validated bridge client. Each live editor needs a distinct recovery `clientId`; reuse it only to restore that editor after shutdown. Omission generates a random ID.

## Preservation and lifecycle

Save captures an immutable target, request, text and version. Conflicts retain the draft and offer Compare, Overwrite, Reload or Cancel. Lost responses retain original inputs for exact reconciliation; newer edits remain separate. File mutations preserve affected drafts before effects, require explicit replacement consent and keep uncertain outcomes visible. Unresolved destination collisions retain both drafts.

Recovery uses [exact publication receipts](../application/docs/RECOVERY-PUBLICATIONS.md). `getSnapshot().publication` exposes an unresolved publication; `resolveRecoveryPublication()` reconciles it. Uncertainty blocks destructive actions and Quit. Consumers must honor the workbench's `prepareQuit()` Save/Discard/Cancel gate before disposing or unmounting. Completed Saves and confirmed Discards remain facts if a later step fails.

`getSnapshot().recoveryReady` is the synchronous document-unload gate: veto reload while false and keep publication/retry controls available. It does not replace `prepareQuit()`. Keep a hidden editor mounted to retain Monaco models and undo history. Unmount releases models/listeners; controller disposal releases observations without disposing the process runtime or deleting recovery. Force-kill and physical power loss are outside these gates.

## Checks

From the repository root:

```sh
bun run --cwd packages/editor typecheck
bun run --cwd packages/editor lint
bun run --cwd packages/editor test
bun run --cwd packages/editor check:renderer
bun run --cwd packages/editor build
bun run --cwd packages/editor test:ui
bun run --cwd packages/editor demo
```

Playwright requires its pinned Chromium (`bun x playwright install chromium`). The demo composes one memory-service runtime and two editor clients; it does not qualify filesystem safety or durability. The [editor/workspace suite](../../tests/editor-workspace/README.md) tests real IO through public boundaries. Packaged/native interaction, VoiceOver and human acceptance require desktop qualification. Distribution must retain notices for actual bundled dependencies, including Monaco workers/fonts.
