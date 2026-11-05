# Project workbench

`@moonbase/workbench` presents one supplied project/checkout using a headless editor controller. It owns the file sidebar, buffers/file tabs, comparisons, Monaco, file lookup and editor dialogs. It installs no model, runtime, desktop bridge or backend capability. Application owns buffers, recovery, exact Save/Discard/Cancel decisions and cleanup.

## Use

```tsx
import { Workbench, type WorkbenchHandle } from '@moonbase/workbench';
import { configureMonacoWorkers } from '@moonbase/workbench/workers';

// The browser root acquires the controller and configures workers once.
configureMonacoWorkers();
<Workbench controller={editor} checkout={checkout} ref={handle} />;
```

Pass the exact open `CheckoutTarget`, including project, host and checkout identity, or `undefined` for the empty view. The workbench renders that checkout independently of the controller's selected checkout. File lookup stays within it. `renderLayout({ explorer, editor })` optionally arranges or omits the supplied views; the default renders a resizable explorer beside the editor. This layout seam shares the same controller and dialogs without exposing internal component state. The consumer owns project selection and supplies a new checkout when navigating; it should keep the workbench mounted to retain Monaco models, undo, selections, comparisons and view positions. Independent editor clients need distinct stable recovery identities.

The file tree renders only viewport rows and the focused row. It keeps one Tab stop on the tree; rows accept native pointer focus and return it to the tree, clearing keyboard-only outlines when switching to the mouse. Hover and selection share rounded row corners. Expansion and selection use set lookups rather than repeated array searches. Collapsing a folder performs no listing IO; reopening immediately displays its retained listing while refreshing it through the controller. First-open entries appear before Git finishes. All files remain visible, including those covered by an older saved hide preference; ignored entries receive the shared muted colour and a Git-ignored accessibility description when classification arrives. Overlapping reads share work, and newer directory reads fence older entry and classification replies.

Secondary-click (including macOS Control-click), ContextMenu and Shift+F10 open a file/folder row's Base UI menu. Rename, filesystem Copy and Move to Trash use the row menu and existing mutation dialogs; the sidebar has no bottom action row. Invoking a selected row preserves the complete selection and range anchor; an unselected row replaces them. Invocation moves logical tree focus without opening files or expanding folders. One menu belongs to each tree, independently of virtual rows, and dismisses on scroll movement after opening, target loss, checkout changes, hiding or unmounting. A queued scroll notification from earlier keyboard navigation keeps the menu open while its captured scroll position still matches.

Menus capture exact checkout identities and full relative paths before opening a dialog. Dialogs show the captured host/root and paths, retain their target across navigation, and visibly refuse an unavailable checkout. Escape returns focus to the invoking visible tree; Tab continues traversal. Actions transfer focus into the dialog, whose close returns to that tree only while its exact checkout is still displayed and visible. A competing dialog dismisses an unchosen menu without returning tree focus, including across independent workbenches and while the menu's initial focus is still pending. Existing recovery, replacement consent and uncertain-operation handling remain with the supplied controller.

| Export | Purpose |
| --- | --- |
| `.` | `Workbench`, `WorkbenchProps` and `WorkbenchHandle` |
| `./workers` | Five Monaco workers for browser roots with Vite-compatible `?worker` support |

`selectClipboardImports(checkout)` optionally supplies approved clipboard references when files are pasted into the explorer. Both keyboard paste and a native Paste event use the exact captured checkout and the existing import dialog; editable fields and Monaco retain normal text paste. The supplied explorer keeps this behavior in custom `renderLayout` compositions. Compact controls use the shared Tabler outlined icons and retain their accessible action names and titles. Tree rows use file and folder icons, switching to an open-folder icon when expanded; a reserved disclosure column aligns file and folder names.

`selectNativeImports(checkout)` returns approved opaque native references, never raw OS source paths. The optional picker control sits with the creation and reveal tools above the tree. Native picker selection and `WorkbenchHandle.importFiles(checkout, references)` share the editor's destination/replacement dialog and capture the exact checkout before asynchronous selection. Consumers route clipboard/drop selections through that handle. Approval and trust-boundary validation remain with the platform and workspace.

Buffer tabs are square and flush, with shared file icons, truncated filenames and full-height dividers. The active tab joins the editor breadcrumb row below; close controls appear on selection, hover or keyboard focus without shifting the strip. Preview italics, unsaved markers and full-path accessible labels/titles remain available. A compact 28px breadcrumb row shows the checkout basename and relative file path, with a brighter current filename and no toolbar buttons. Right-click a file tab (or press Shift+F10 while it has keyboard focus) for the existing file-view and tab commands. Save remains available through Command/Ctrl+S; retained uncertain saves keep an explicit Retry Save notice.

`WorkbenchHandle.keyDown/keyUp` lets a consumer forward shortcuts from its own project navigation. The workbench handles keys within its own view. Consumers can forward unhandled bubbling events from their navigation, checking `event.defaultPrevented`; handled editor shortcuts stop propagation. `visible={false}` suppresses hidden Monaco position writes; the consumer hides the containing panel. Unmount cancels an outstanding close prompt and releases presentation resources, without disposing the controller.

An asynchronous editor action restores its owning view's focus without taking focus back from a newer menu, dialog or another workbench. Its focus request retains the initiating element and is consumed once after the target renders.

## Composition and lifecycle

```tsx
<Workbench
  controller={editor}
  checkout={checkout}
  renderLayout={({ explorer, editor }) => (
    <ProjectLayout tools={explorer} content={editor} />
  )}
/>
```

`ProjectLayout` is supplied by the consuming app. It can place the explorer in either sidebar, or render only the editor; the workbench retains shared editor dialogs and shortcuts.

The consuming app owns main navigation, custom project layout, adjacent panels and cross-panel interactions. Use `renderLayout` to position the explorer and editor in app-owned containers; omitting the explorer leaves keyboard file lookup and editing available. For example, desktop composes this workbench and its separate Chat view, routes project/Chat navigation and controls observation visibility. A chat sidebar can be placed alongside the workbench without coupling their feature code. Workbench has no Chat or application lifecycle dependency.

The consumer reveals the editor before calling `application.prepareQuit()` so exact close prompts and uncertainty controls remain available, and routes preservation failures to the relevant feature. It retains `canUnload()` vetoes, inert presentation after consent, native acknowledgments, unmount and awaited `application.dispose()`. See [application lifecycle](../application/docs/LIFECYCLE.md) and [desktop handoff](../../apps/desktop/docs/LIFECYCLE.md).

## Checks

From the repository root:

```sh
bun run --cwd packages/workbench typecheck
bun run --cwd packages/workbench lint
bun run --cwd packages/workbench check:renderer
bun run --cwd packages/workbench build
bun run --cwd packages/workbench test:ui
bun run --cwd packages/workbench demo
```

The browser demo renders two project workbenches with independent buffers/recovery and no Electron globals. `?remote` gives the second workbench a controlled remote identity with matching checkout ID/path names; `?clipboard` installs the explorer paste fixture. Save/recovery race fixtures compose their own project selection outside the workbench. Editor/import/context-menu regressions cover exact identities, focus, disposal, virtualization and uncertain publications. Desktop owns the browser shell/Chat fixture and regressions (`bun run --cwd apps/desktop test:browser`).

Headless source suites remain in application. The [editor/workspace](../../tests/editor-workspace/README.md) and [chat](../../tests/chat/README.md) suites exercise controlled IO through public boundaries. Desktop separately qualifies native and packaged execution. Browser fixtures do not establish production web storage or transport, real SSH/providers, OS gestures or VoiceOver. Distribution must retain notices for actual dependencies, including Monaco workers/fonts. See [delivery evidence](docs/VALIDATION.md).
