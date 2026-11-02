# Editor presentation

`@moonbase/editor` renders a supplied `EditorController` from `@moonbase/application/editor` using React and Monaco. Application owns the headless buffers, tabs, lookup/mutation sessions, Save/Discard/Cancel and recovery behavior; see the [headless editor API and lifecycle](../application/docs/EDITOR.md). Presentation creates no workspace capability, model or Effect runtime.

## Use

```tsx
import { EditorWorkbench } from '@moonbase/editor';
import { configureMonacoWorkers } from '@moonbase/editor/workers';

// The browser root configures workers once and supplies its acquired controller.
configureMonacoWorkers();
<EditorWorkbench controller={editor} />;
```

The composition root acquires `makeEditorModel` once in its aggregate scope, then binds that exact instance with `makeEditorController`; both factories come from `@moonbase/application/editor`. Each editor needs a distinct stable recovery `clientId`; Monaco models also use the controller's separate random `instanceId`. The volatile demo capability comes from `@moonbase/application/testing/memory-workspace` and makes no filesystem or durability claim.

| Export | Purpose |
| --- | --- |
| `.` | Workbench, props and UI handle; temporary headless compatibility reexports |
| `./workers` | Monaco workers for a browser root with Vite-compatible `?worker` support |
| `./state`, `./memory` | Temporary forwarding aliases of application entries, removed after callers migrate |

Shells may supply `selectCheckout` and `selectNativeImports`; native imports use approved opaque references, never raw OS source paths. Picker, clipboard and drop share `EditorWorkbenchHandle.importFiles(checkout, references)` and its destination/replacement dialog. `EditorWorkbenchHandle.prepareQuit()` delegates to the controller's authoritative close gate.

## View and application lifetime

The view renders the exact `closePrompt` and answers Save/Discard/Cancel through `answerClose(promptId, choice)`. Stale answers are ignored. Dismissal or unmount answers Cancel to an outstanding prompt; a hidden mounted workbench keeps it. Keep the editor mounted while hidden to retain Monaco undo, cursor and scroll state. Unmount releases Monaco models/listeners and popup sessions; it never disposes the application model.

The head owns synchronous `recoveryReady` unload vetoes, preservation decisions and eventual controller/scope/runtime disposal. Cleanup failure remains visible to that owner after panel removal. No data is imported, migrated or deleted by this presentation package. All IO and native authority enter through injected contracts/capabilities.

## Checks

From the repository root:

```sh
bun run --cwd packages/editor typecheck
bun run --cwd packages/editor lint
bun run --cwd packages/editor check:renderer
bun run --cwd packages/editor build
bun run --cwd packages/editor test:ui
bun run --cwd packages/editor demo
```

The five headless source suites now run with `bun run --cwd packages/application test`. Playwright requires its pinned Chromium (`bun x playwright install chromium`). The demo composes one memory-service runtime and two editor controllers. The [editor/workspace suite](../../tests/editor-workspace/README.md) tests real IO through public boundaries. Packaged/native interaction, VoiceOver and human acceptance require desktop qualification. Distribution must retain notices for actual bundled dependencies, including Monaco workers/fonts.
