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

Import `@moonbase/ui/reset.css` once in the browser root to load the shared Manrope interface and SpaceMono Nerd Font Mono editor faces. Monaco refreshes its cached character widths after document fonts finish loading, including when the editor first renders with a fallback font.

Pass the exact open `CheckoutTarget`, including project, host and checkout identity, or `undefined` for the empty view. The workbench renders that checkout independently of the controller's selected checkout. File lookup stays within it. `renderLayout({ explorer, editor })` optionally arranges or omits the supplied views; the default renders a resizable explorer beside the editor. This layout seam shares the same controller and dialogs without exposing internal component state. The consumer owns project selection and supplies a new checkout when navigating; it should keep the workbench mounted to retain Monaco models, undo, selections, comparisons and view positions. Independent editor clients need distinct stable recovery identities.

The file tree renders only viewport rows and the focused row. It keeps one Tab stop on the tree; rows accept native pointer focus and return it to the tree, clearing keyboard-only outlines when switching to the mouse. Hover and selection share rounded row corners. Expansion and selection use set lookups rather than repeated array searches. Collapsing a folder performs no listing IO; reopening immediately displays its retained listing while refreshing it through the controller. First-open entries appear before Git finishes. All files remain visible, including those covered by an older saved hide preference; ignored entries receive the shared muted colour and a Git-ignored accessibility description when classification arrives. Overlapping reads share work, and newer directory reads fence older entry and classification replies.

| Export | Purpose |
| --- | --- |
| `.` | `Workbench`, `WorkbenchProps` and `WorkbenchHandle` |
| `./workers` | Five Monaco workers for browser roots with Vite-compatible `?worker` support |

`selectClipboardImports(checkout)` optionally supplies approved clipboard references when files are pasted into the explorer. Both keyboard paste and a native Paste event use the exact captured checkout and the existing import dialog; editable fields and Monaco retain normal text paste. The supplied explorer keeps this behavior in custom `renderLayout` compositions. Compact controls use the shared Tabler outlined icons and retain their accessible action names and titles. Tree rows use file and folder icons, switching to an open-folder icon when expanded; a reserved disclosure column aligns file and folder names.

`selectNativeImports(checkout)` returns approved opaque native references, never raw OS source paths. Native picker selection and `WorkbenchHandle.importFiles(checkout, references)` share the editor's destination/replacement dialog and capture the exact checkout before asynchronous selection. Consumers route clipboard/drop selections through that handle. Approval and trust-boundary validation remain with the platform and workspace.

`WorkbenchHandle.keyDown/keyUp` lets a consumer forward shortcuts from its own project navigation. The workbench handles keys within its own view. Consumers can forward unhandled bubbling events from their navigation, checking `event.defaultPrevented`; handled editor shortcuts stop propagation. `visible={false}` suppresses hidden Monaco position writes; the consumer hides the containing panel. Unmount cancels an outstanding close prompt and releases presentation resources, without disposing the controller.

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

The browser demo renders two project workbenches with independent buffers/recovery and no Electron globals. Save/recovery race fixtures compose their own project selection outside the workbench. Editor/import regressions cover exact identities, focus, disposal and uncertain publications. Desktop owns the browser shell/Chat fixture and regressions (`bun run --cwd apps/desktop test:browser`).

Headless source suites remain in application. The [editor/workspace](../../tests/editor-workspace/README.md) and [chat](../../tests/chat/README.md) suites exercise controlled IO through public boundaries. Desktop separately qualifies native and packaged execution. Browser fixtures do not establish production web storage or transport, real SSH/providers, OS gestures or VoiceOver. Distribution must retain notices for actual dependencies, including Monaco workers/fonts. See [delivery evidence](docs/VALIDATION.md).
