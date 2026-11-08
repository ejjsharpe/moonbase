# Workbench

`@moonbase/workbench` renders one project checkout using a supplied headless editor controller: the file sidebar, buffer tabs, comparisons, Monaco, file lookup and editor dialogs. It installs no model, runtime or backend capability. The application owns buffers, recovery and Save/Discard/Cancel decisions.

```tsx
import { Workbench, type WorkbenchHandle } from '@moonbase/workbench';
import { configureMonacoWorkers } from '@moonbase/workbench/workers';

configureMonacoWorkers(); // once per browser root
<Workbench controller={editor} checkout={checkout} ref={handle} />;
```

Pass the exact open checkout, or `undefined` for the empty view. `renderLayout({ explorer, editor })` lets the consuming app place or omit the explorer.

⌘P opens the picker: Go to finds files, and `>` lists commands (⌘⇧P opens it there); ⇥ switches to Find, which searches file contents and previews each match (⌘⇧F opens it with the editor's selected text). An app adds chats, projects and its own commands with `pickerEntries`, opens the picker from anywhere with the handle's `openPicker(mode)`, and brings the editor into view in `onShowEditor`. Optional `selectNativeImports` and `selectClipboardImports` supply approved file references for imports; the workbench never receives raw OS paths. The file tree's right-click menu also offers Copy Path, Reveal and Mention in Chat when the app supplies `copyPaths`, `revealPath` and `mentionInChat`; each gets the checkout and its relative paths, and the same shortcuts work in the tree. The explorer's "…" menu holds New File/Folder, Import Files (with `selectNativeImports`), Collapse All Folders, Reveal Active File, Go to File and Refresh. An app whose window already names the open file passes `showBreadcrumbs={false}`; `sidebarHidden` slides the explorer away, and `shortcuts` adds the app's own keys to the short list shown when no file is open. Unmounting releases presentation resources without disposing the controller.

| Export | Purpose |
| --- | --- |
| `.` | `Workbench`, `WorkbenchProps` and `WorkbenchHandle` |
| `./workers` | Monaco workers for browser roots |

## Checks

```sh
bun run --cwd packages/workbench typecheck
bun run --cwd packages/workbench lint
bun run --cwd packages/workbench check:renderer
bun run --cwd packages/workbench build
bun run --cwd packages/workbench test:ui
bun run --cwd packages/workbench demo
```

The demo renders two project workbenches with independent buffers; `?remote` gives the second a remote identity and `?clipboard` installs a paste fixture.
