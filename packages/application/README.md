# Application runtime

`@moonbase/application` owns shared typed dispatch and runtime-bound Promise clients. Independent definitions, schemas and Effect service ports live in [`@moonbase/contracts`](../contracts/README.md); reusable infrastructure implements those ports without depending on application behavior. Process roots compose only their needed capabilities in one scoped runtime.

| Export | Purpose |
| --- | --- |
| `runtime/handlers` | Shared command dispatch and subscriptions |
| `runtime/clients` | Editor/chat/connection clients bound to an existing process runtime |
| `runtime/effect-client` | Invocation and awaitable observation close bound to a supplied runtime |
| `handlers`, `runtime-client`, `effect-client` | Temporary aliases of the canonical runtime entries |
| `client`, `chat-client`, `connection-client`, `host-client` | Temporary aliases of canonical contracts client definitions |
| `chat-schema`, `workspace-schema`, `connection-schema`, `host-schema`, `error-schema` | Temporary aliases of canonical contracts schemas |
| `services` | Temporary canonical service-tag aliases and `releaseResource` compatibility export |
| `host-health` | Temporary privileged alias of `@moonbase/ssh/host-health`; excluded from portable graphs |

The compatibility exports retain the exact canonical error brand, decoder functions and service tags; they are removed after all migration callers move. `@moonbase/effect` owns shared safe normalization/release behavior; application preserves its existing public normalizer reexport. Application invocation creates no runtime, retries no operation and leaves injected resource ownership with its caller.

Use the public runtime entries directly from TypeScript. `makeEditorClient`, `makeChatClient` and `makeConnectionClient` bind the process root's existing runtime to the same typed handlers; they acquire no second service graph. Headless features use a caller-supplied runtime and bind their already-acquired models. Command cancellation affects that invocation; observation close fences delivery immediately and awaits its actual finalizers. Synchronous snapshot subscriptions retain their separate synchronous unsubscribe API. See the [runtime API handoff](docs/SCHEMAS.md) for exact signatures and ownership.

Renderers receive browser-safe clients. Native/transport adapters validate and authorize unknown inputs before shared handlers; infrastructure retains domain validation and resource ownership. DTO types use erased schema imports. Shape validation grants no authority, and privileged endpoint credentials never belong in renderer bridges.

See [Effect invocation and observation cleanup](docs/SCHEMAS.md), [contract schema policies](../contracts/docs/SCHEMAS.md), [chat admission/RPC](../contracts/docs/CHAT.md), [host authentication](../contracts/docs/HOST-PROTOCOL.md) and [recovery publications](../contracts/docs/RECOVERY-PUBLICATIONS.md).

```sh
bun run --cwd packages/application typecheck
bun run --cwd packages/application lint
bun run --cwd packages/application test
```
