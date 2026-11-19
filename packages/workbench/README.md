# Workbench

`@moonbase/workbench` renders one project checkout of a supplied editor: the file explorer, buffer tabs, comparisons, Monaco, the picker and the editor's dialogs. It installs no model, runtime or backend capability; the application's editor services own buffers, recovery and the Save/Discard/Cancel decisions. It imports `@moonbase/application/editor`, contracts and `@moonbase/ui`, never `testing/`, the application runtime or privileged packages (`check:renderer` enforces this).

```tsx
import { RegistryProvider } from '@effect/atom-react';
import { makeWorkbenchEditor, Workbench, type WorkbenchHandle } from '@moonbase/workbench';
import { configureMonacoWorkers } from '@moonbase/workbench/workers';

configureMonacoWorkers(); // once per browser root
const editor = makeWorkbenchEditor(context, { copyPaths, revealPath }); // a WorkbenchPlatform
<RegistryProvider>
  <Workbench editor={editor} checkout={checkout} ref={handle} />
</RegistryProvider>;
```

## Public interface

| Export | Gives |
| --- | --- |
| `.` | `Workbench` with `WorkbenchProps` and `WorkbenchHandle`; `makeWorkbenchEditor`/`WorkbenchEditor`; `WorkbenchPlatform`/`WorkbenchPlatformShape`; `makeEditorActions`/`useEditorActions`/`EditorActions`; `useEditorTask`; `pickerCommand`, `pickerMode`, `PickerMode`, `PickerEntry` and `Shortcut`; `isFileDropTaken` |
| `./workers` | `configureMonacoWorkers` for browser roots |

A `WorkbenchEditor` is the built editor's services (`editorLayer`'s context), atoms over them (`makeEditorAtoms`), the app's `WorkbenchPlatform` and an atom runtime (`Atom.runtime`) over both; the workbench runs no runtime of its own. It reads state through `@effect/atom-react` from the surrounding registry. Each action (`useEditorActions` names them) is a service Effect, which a view runs through its own atom function (`useEditorTask`): unmounting the view, or with `replace` starting a newer one, interrupts what it started, and a failure shows in the editor's alerts. The editor's own work (a save, a file operation, a close) runs on past its caller, or on the editor's keep-alive work atom (`actions.start`). Pass the exact open checkout, or `undefined` for the empty view.

The app's platform capabilities (`selectNativeImports`, `selectClipboardImports`, `selectDroppedImports`, `copyPaths`, `revealPath`) are a `WorkbenchPlatform` of Effects, each optional, documented in `src/workbench-platform.ts`. The app plugs in its views through optional props: `renderLayout`, `trailing`, `pickerEntries`, `onShowEditor`, `mentionInChat`, `showBreadcrumbs`, `sidebarHidden`, `onShowSidebar` and `shortcuts`. Each is documented where `WorkbenchProps` is declared in `src/workbench.tsx`.

## Layout

`src/explorer/` (the explorer and Changes view), `src/files-tree/` (the tree: editing names, drag and drop, the file clipboard, Undo Move, Follow Active File), `src/editor-area/`, `src/editor-tabs/`, `src/picker/` (⌘P: Go to, commands and Find) and `src/sidebar/`. Look there for keyboard, drag, paste and reveal behaviour; it is not catalogued here.

## Rules worth knowing

- The workbench never receives raw OS paths. Imports take only the approved references that `selectNativeImports`, `selectClipboardImports` and `selectDroppedImports` return; without `selectDroppedImports`, OS drops pass through to the app.
- Every file operation passes one gate: none of the workbench's own dialogs is open, then the editor's mutation gate (`EditorMutations.admits`, read through `admitsMutation`). Don't run a mutation around it.
- The tree's Cut and Copy use the workbench's own file clipboard; the OS clipboard only gets relative paths as text through `copyPaths`.
- Focus returns through element refs and component handles, never by querying labels.
- Unmounting releases presentation resources, never the editor.

## Checks

```sh
bun run --cwd packages/workbench typecheck
bun run --cwd packages/workbench lint
bun run --cwd packages/workbench check:renderer
bun run --cwd packages/workbench build
bun run --cwd packages/workbench test
bun run --cwd packages/workbench test:ui
bun run --cwd packages/workbench demo
```

`test` runs the logic-only `test/*.test.ts` under Node. `test:ui` builds the demo and runs the Playwright specs in `test/e2e/` against it in parallel; set `MOONBASE_WORKBENCH_PORT` to isolate concurrent runs (default 4176).

The demo builds two editors on one runtime over the faux workspace. Specs drive it through `window.demo` (`client` to observe or delay workspace commands, `interceptMutation` to answer a file operation); `?remote` gives the second editor a remote checkout and `?clipboard` installs a paste fixture.
