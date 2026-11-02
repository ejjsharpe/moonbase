# Application contracts

`@moonbase/application` owns shared typed commands, queries, subscriptions, dispatch, cancellation and errors. Feature packages implement its Effect service contracts; client process roots compose only the services they need into one scoped runtime.

| Export | Purpose |
| --- | --- |
| `./client` | Browser-safe editor commands and workspace types |
| `./chat-client` | Browser-safe chat commands and types |
| `./connection-client` | Browser-safe connection commands and types |
| `./host-client` | Browser-safe host identity and health types |
| `./chat-schema` | Effect schemas and synchronous chat input/output decoders |
| `./workspace-schema`, `./connection-schema`, `./host-schema` | Shared mutable DTO schemas and synchronous decoders |
| `./error-schema` | Shared error-code/DTO schema and decoder |
| `./effect-client` | Invocation and awaitable observation close bound to a supplied runtime |
| `./services` | Effect service contracts and resource cleanup helpers |
| `./handlers` | Shared command dispatch and subscriptions |
| `./runtime-client` | Clients bound to an existing process runtime |
| `./host-health` | Privileged host authentication helpers |

Renderers receive browser-safe clients. Native and transport adapters validate and authorize unknown inputs before invoking shared handlers; feature services retain domain validation and resource ownership. DTO types use type-only schema imports so browser clients emit no Effect code. Request decoders reject unknown fields; reply decoders project known fields. Saved recovery rejects unfamiliar nested fields before projection or publication. Shape validation grants no authority. See [schema policies and Effect clients](docs/SCHEMAS.md) for the export matrix, decoder policies and awaitable observation cleanup contract.

Read the relevant contract when changing [chat admission or RPC](docs/CHAT.md), [connection lifecycle](../ssh/README.md#lifecycle-and-authority), [host authentication](docs/HOST-PROTOCOL.md) or [recovery publications](docs/RECOVERY-PUBLICATIONS.md).

From the repository root:

```sh
bun run --cwd packages/application typecheck
bun run --cwd packages/application lint
bun run --cwd packages/application test
```
