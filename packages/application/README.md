# Application contracts

`@moonbase/application` owns shared typed commands, queries, subscriptions, dispatch, cancellation and errors. Feature packages implement its Effect service contracts; each process composes those services into one scoped root runtime.

| Export | Purpose |
| --- | --- |
| `./client` | Browser-safe editor commands and workspace types |
| `./chat-client` | Browser-safe chat commands and types |
| `./chat-schema` | Shared Effect schemas and synchronous chat input/output decoders |
| `./connection-client` | Browser-safe connection commands and types |
| `./host-client` | Browser-safe host identity and health types |
| `./services` | Effect service contracts and resource cleanup helpers |
| `./handlers` | Shared command dispatch and subscriptions |
| `./runtime-client` | Clients bound to the existing process runtime |
| `./host-health` | Privileged host authentication helpers |

Renderers receive browser-safe clients. Native and transport entry points validate and authorize unknown inputs before entering the same handlers. Checkout, client, request, host, store and task identities remain exact across retries and uncertain outcomes.

Chat DTO and command types derive from `./chat-schema` through type-only imports. The client exports emit no Effect code; privileged consumers import the schema entry explicitly. Its decoders reject unexpected request fields and project replies to known fields, retaining the existing text, identity and delivery bounds. Invalid requests report `InvalidInput`; malformed replies consistently report `Incompatible`, replacing the old field-specific reply codes. Both use safe messages without rejected values. Domain errors keep their own codes, and mutation uncertainty remains with the consuming module. Authority checks remain with the consuming module; decoding a shape grants no permission to use its identities. Schemas create no service graph or application runtime.

Run package checks from the repository root:

```sh
bun run --cwd packages/application typecheck
bun run --cwd packages/application lint
bun run --cwd packages/application test
```
