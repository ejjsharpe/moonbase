# Browser workbench

`@moonbase/workbench` owns the shared React shell, project/Chat navigation and internal editor/chat presentation. It renders supplied headless application controllers using Base UI, StyleX and Monaco. It installs no model, runtime, desktop bridge or backend capability. Application owns buffers, recovery, exact Save/Discard/Cancel prompts, feature acquisition and cleanup.

## Use

```tsx
import { Workbench, type WorkbenchHandle } from '@moonbase/workbench';
import { configureMonacoWorkers } from '@moonbase/workbench/workers';

// The browser root acquires one application and configures workers once.
configureMonacoWorkers();
<Workbench application={application} ref={handle} selectCheckout={chooseApprovedRoot} />;
```

The workbench presents the application's first editor and optional Chat, or a chat-only application. Use separate applications for independent workbench clients, each with a distinct stable editor recovery identity. The shell derives project tabs from the controller's exact open-checkout identities and keeps only the visible destination locally; it persists no competing project list. File tabs, tree, comparisons and Monaco remain internal editor features.

| Export | Purpose |
| --- | --- |
| `.` | `Workbench`, props/handle and `WorkbenchStartupFailure` presentation |
| `./workers` | Five Monaco workers for browser roots with Vite-compatible `?worker` support |

Inject only today's native selection capabilities: `selectCheckout`, `selectNativeImports`, `selectClipboardImports` and `selectDroppedImports`. Native imports return approved opaque references, never raw OS source paths. Picker, clipboard, drop and `WorkbenchHandle.importFiles(checkout, references)` share the editor's destination/replacement dialog and capture the exact checkout before asynchronous selection. The consumer retains approval, validation, private configuration and synchronous chat storage.

## View and application lifetime

Project select/close delegates to `selectCheckout`/`closeCheckout`; Chat close/reopen delegates to `application.closeChat/openChat`. Cancel retains work, while pending/failing Chat cleanup remains visible and blocks namespace reuse. Unavailable, initialization-failed and opening Chat remain visible, with explicit retry where available.

The single editor stays mounted across project and Chat navigation, retaining Monaco models, undo, comparisons and view positions. Mouse selection restores content focus; keyboard navigation retains tab focus. Hidden editor shortcuts do not handle Chat input. Chat observation detaches/resumes with visibility without Stop or mutation replay.

`WorkbenchHandle.prepareQuit()` reveals the editor's exact prompts and uncertainty controls, delegates to `application.prepareQuit()` and reveals Chat preservation failures. Use it for the platform Quit presentation handoff. Application remains authoritative for preservation and admission fencing. The platform retains synchronous `canUnload()` vetoes, native action subscriptions, matching Quit/disposal acknowledgments, root unmount and awaited `application.dispose()`. `closing` makes presentation inert after platform consent; prepared/disposed application phases also fence the view.

Unmount cancels an outstanding close prompt and releases presentation resources; it never owns application disposal. See [application lifecycle](../application/docs/LIFECYCLE.md) and [desktop handoff](../../apps/desktop/docs/LIFECYCLE.md).

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

The browser demo renders the real shared shell with memory workspace and optional faux Chat (`/?chat`), without Electron globals. The two clients retain independent buffers/recovery. Save/recovery race demos and existing editor regressions remain under `demo/` and `test/`; the shell suite adds mixed tabs, keyboard/focus, view/undo retention, close decisions, optional Chat retry, held/failing cleanup and Quit from Chat. This proves browser presentation portability, not a production web client or durable browser filesystem.

Headless source suites remain in application. The [editor/workspace](../../tests/editor-workspace/README.md) and [chat](../../tests/chat/README.md) suites exercise real controlled IO through public boundaries. Desktop separately qualifies native and packaged execution. Distribution must retain notices for actual dependencies, including Monaco workers/fonts. See [delivery evidence](docs/VALIDATION.md) for this refactor's commands and limitations.
