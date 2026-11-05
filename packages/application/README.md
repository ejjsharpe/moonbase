# Application

`@moonbase/application` holds the headless editor and chat features: controllers, shared command dispatch, cancellation, composition and lifecycle. It imports no Node, Electron, React or infrastructure implementation; callers inject clients and platform capabilities.

`createMoonbaseApplication` composes editor-only, chat-only or combined applications in one client runtime, with coordinated Quit (preservation, Save/Discard/Cancel prompts) and disposal. [`examples/headless.ts`](examples/headless.ts) runs all three compositions without Electron.

| Export | Purpose |
| --- | --- |
| `.` | Application factory, lifecycle snapshots and types |
| `chat` | Headless chat model and controller, including transcript navigation and Find |
| `editor` | Headless editor model and controller |
| `testing/memory-workspace` | In-memory workspace capability for tests and demos |
| `runtime/handlers` | Shared command dispatch and subscriptions |
| `runtime/clients` | Editor, chat and connection clients bound to an existing runtime |
| `runtime/effect-client` | Invocation and observation helpers bound to a supplied runtime |

Renderers receive browser-safe clients. Native and transport adapters validate and authorize input before calling the shared handlers; schema validation alone grants no authority. A `ChatClient` that receives untrusted data decodes and size-bounds every reply and snapshot (the Pi runtime's local and remote services; desktop forwards them to the renderer unchanged); shared chat code trusts `ChatClient` outputs and checks only their meaning: echoed sources and selections, cursors, offsets, authority and liveness.

```sh
bun run --cwd packages/application typecheck
bun run --cwd packages/application lint
bun run --cwd packages/application test
node packages/application/scripts/measure-editor-snapshots.mjs   # editor snapshot timing harness
```
