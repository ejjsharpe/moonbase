# Workbench

`@moonbase/workbench` renders one project checkout using a supplied headless editor controller: the file sidebar, buffer tabs, comparisons, Monaco, file lookup and editor dialogs. It installs no model, runtime or backend capability. The application owns buffers, recovery and Save/Discard/Cancel decisions.

```tsx
import { Workbench, type WorkbenchHandle } from '@moonbase/workbench';
import { configureMonacoWorkers } from '@moonbase/workbench/workers';

configureMonacoWorkers(); // once per browser root
<Workbench controller={editor} checkout={checkout} ref={handle} />;
```

Pass the exact open checkout, or `undefined` for the empty view. `renderLayout({ explorer, editor })` lets the consuming app place or omit the explorer. Optional `selectNativeImports` and `selectClipboardImports` supply approved file references for imports; the workbench never receives raw OS paths. Unmounting releases presentation resources without disposing the controller.

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
