# Workbench

`@moonbase/workbench` renders one project checkout using a supplied headless editor controller: the file sidebar, buffer tabs, comparisons, Monaco, file lookup and editor dialogs. It installs no model, runtime or backend capability. The application owns buffers, recovery and Save/Discard/Cancel decisions.

```tsx
import { Workbench, type WorkbenchHandle } from '@moonbase/workbench';
import { configureMonacoWorkers } from '@moonbase/workbench/workers';

configureMonacoWorkers(); // once per browser root
<Workbench controller={editor} checkout={checkout} ref={handle} />;
```

Pass the exact open checkout, or `undefined` for the empty view. `renderLayout({ explorer, editor })` lets the consuming app place or omit the explorer.

⌘P opens the picker (Ctrl+P off a Mac): Go to finds files, and `>` lists commands (⌘⇧P opens it there); ⇥ switches to Find, which searches file contents and previews each match (⌘⇧F opens it with the editor's selected text). An app adds chats, projects and its own commands with `pickerEntries`, opens the picker from anywhere with the handle's `openPicker(mode)`, and brings the editor into view in `onShowEditor`. Optional `selectNativeImports` and `selectClipboardImports` supply approved file references for imports; the workbench never receives raw OS paths. The file tree's right-click menu also offers Copy Path, Reveal and Mention in Chat when the app supplies `copyPaths`, `revealPath` and `mentionInChat`; each gets the checkout and its relative paths, and the same shortcuts work in the tree. Tree rows colour a changed file's name and mark it M (modified), A (added), D (deleted), U (untracked), ! (conflicted) or T (type changed), choosing what happened to it when it is both staged and unstaged (a new file edited since staging is still A; one untracked by `git rm --cached` is U), else the strongest; a folder with changed files beneath it shows a dot in their strongest colour, a diamond when one is conflicted. The Changes view lists Conflicts, Staged, Changes and Untracked with the same marks, and opens a conflicted file itself, unless both sides deleted it. The explorer's "…" menu holds New File/Folder, Import Files (with `selectNativeImports`), Undo Move, Collapse All Folders, Reveal Active File, Go to File and Refresh. Rename (F2), Duplicate and New File/Folder type the name in the tree row itself: Enter or moving focus elsewhere in the window commits (switching windows doesn't), Escape cancels, an error shows beside the field, and replacing an existing entry asks first, starting on Cancel. Names are taken as typed, spaces included. A name can't contain `/`, so New File/Folder create only in an existing folder: the one whose menu was used or, from the "…" menu, the focused folder or file's folder, else the root. Move to Trash and Import keep their dialogs. Dragging a row moves it, or the whole selection when the row is selected, into the folder dropped on: a folder row, a file row's folder, or the root from the empty area, which is highlighted with what it shows. Holding ⌥ (Alt) copies instead; a collapsed folder hovered for a moment expands, and the tree scrolls near its edges. A drop into a dragged folder, where nothing would move, or from another checkout or editor is refused; OS files dropped on the window still import through the app. The drag carries `application/x-moonbase-entries` (JSON with the editor, checkout key and paths) and the relative paths as `text/plain`. ⌘Z in the tree (Ctrl+Z off a Mac), or Undo in the "…" menu, moves the checkout's last dragged or renamed entries back, unsaved text included, once it has checked they're still there and their original paths are free; copies and creates aren't undone. An app whose window already names the open file passes `showBreadcrumbs={false}`; `sidebarHidden` slides the explorer away, `onShowSidebar` asks for it back when Show Files (⌘⇧E), Show Changes or Reveal Active File needs it, and `shortcuts` adds the app's own keys to the short list shown when no file is open. Unmounting releases presentation resources without disposing the controller.

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
