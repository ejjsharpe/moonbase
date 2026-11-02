# Application runtime

`@moonbase/application` owns shared typed dispatch, runtime-bound Promise clients and reusable headless feature behavior. Independent definitions, schemas and Effect service ports live in [`@moonbase/contracts`](../contracts/README.md); reusable infrastructure implements those ports without depending on application behavior. Process roots compose only their needed capabilities in one scoped runtime.

The root `createMoonbaseApplication` factory composes supplied editor/chat capabilities into one headless application with direct controllers, synchronous unload preservation and coordinated Quit/disposal. It supports independent and combined features, with visible optional-chat degradation. See [application lifecycle and usage](docs/LIFECYCLE.md) for the API, admission fence, prompt handoff and root-owned panel cleanup.

The [direct headless consumer](docs/HEADLESS-CONSUMER.md) runs all three compositions without Electron through public APIs. Foundation checks audit its browser bundle and execute its emitted JavaScript; the guide records the data/runtime seam and the separate qualification a future process/language adapter would require.

| Export | Purpose |
| --- | --- |
| `.` | Headless application factory, lifecycle snapshots and types |
| `chat` | Scoped headless chat model, bound controller and synchronous draft preservation |
| `editor` | Headless editor model/controller, close prompts, workflow sessions and state |
| `testing/memory-workspace` | Concrete volatile workspace capability for tests and demos; excluded from `editor` imports |
| `runtime/handlers` | Shared command dispatch and subscriptions |
| `runtime/clients` | Editor/chat/connection clients bound to an existing process runtime |
| `runtime/effect-client` | Invocation and awaitable observation close bound to a supplied runtime |

`@moonbase/contracts` supplies the single error brand, decoder functions and service tags. `@moonbase/effect` owns shared safe normalization/release behavior; application invocation reexports its normalizer. Runtime helpers create no runtime, retry no operation and leave injected resource ownership with their caller. Only the application factory owns the client runtime it creates.

Use the public runtime entries directly from TypeScript. `makeEditorClient`, `makeChatClient` and `makeConnectionClient` bind the process root's existing runtime to the same typed handlers; they acquire no second service graph. Headless features use a caller-supplied runtime and bind their already-acquired models. The [chat API](docs/CHAT.md) preserves synchronous snapshots/drafts/storage and reports awaitable observation cleanup; importing or acquiring it neither installs backend capabilities nor Connects, Sends or Stops. Command cancellation affects that invocation; observation close fences delivery immediately and awaits its actual finalizers. Synchronous snapshot subscriptions retain their separate synchronous unsubscribe API. See the [runtime API handoff](docs/SCHEMAS.md) for exact signatures and ownership.

Renderers receive browser-safe clients. Native/transport adapters validate and authorize unknown inputs before shared handlers; infrastructure retains domain validation and resource ownership. DTO types use erased schema imports. Shape validation grants no authority, and privileged endpoint credentials never belong in renderer bridges.

See [Effect invocation and observation cleanup](docs/SCHEMAS.md), [contract schema policies](../contracts/docs/SCHEMAS.md), [chat admission/RPC](../contracts/docs/CHAT.md), [host authentication](../contracts/docs/HOST-PROTOCOL.md) and [recovery publications](../contracts/docs/RECOVERY-PUBLICATIONS.md).

The [headless editor](docs/EDITOR.md) acquires once in a supplied scope and binds to the caller's runtime. `@moonbase/editor` only presents the supplied controller. Synchronous snapshots/recovery readiness, exact close prompts and awaitable disposal retain their existing contracts; unmounting presentation never owns model lifetime.

```sh
bun run --cwd packages/application typecheck
bun run --cwd packages/application lint
bun run --cwd packages/application test
```
