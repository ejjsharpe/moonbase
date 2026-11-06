# Contracts

`@moonbase/contracts` holds the definitions shared by application, presentation and infrastructure: DTOs, command/client interfaces, schemas, errors and Effect service ports. It imports only its own definitions and Effect, and creates no runtime.

| Subpath | Contents |
| --- | --- |
| `workspace`, `chat`, `connection`, `host`, `providers` | Browser-safe DTOs, command/client interfaces and protocol constants |
| `errors`, `common` | `ApplicationError`, error codes, `CommandOptions`, `ObservationClose`, and `areJsonValuesEqual` / `getJsonKey` (key-order-safe equality and keys for plain decoded data) |
| `*-schema`, `schema` | Request, saved-data and wire-reply decoders, and shared schema constructors |
| `services` | Privileged Effect service ports and endpoint types |

Chat Find (`getChatFindExpression`) matches the literal query in original text with simple Unicode case folding and no normalization: ẞ matches ß and Σ matches ς, but ß never matches SS and NFC/NFD spellings differ.

`CheckoutTarget.worktree` is `main` or `linked`; worktrees of one repository share `projectId`.

Client entries use type-only schema imports, so they emit no Effect runtime code. `services` is privileged: `ConnectionService.endpoint` carries origin and key data that must never reach renderers, settings or logs.

```sh
bun run --cwd packages/contracts typecheck
bun run --cwd packages/contracts lint
bun run --cwd packages/contracts test
```
