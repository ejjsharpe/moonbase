# Independent contracts

`@moonbase/contracts` owns the shared definitions consumed by application, presentation and reusable infrastructure. It imports only its own definitions and portable Effect. It creates no runtime, acquires no capability and imports no application, Node, UI or provider implementation.

| Public subpath | Responsibility |
| --- | --- |
| `workspace` | Workspace/editor DTOs, command types, `EditorClient`, limits and the existing empty recovery value |
| `chat`, `connection`, `host`, `providers` | Browser-safe DTOs, command/client interfaces and protocol constants |
| `errors` | Canonical branded `ApplicationError` and error-code type |
| `common` | `CommandOptions` and awaitable `ObservationClose` types |
| `providers-schema`, `chat-schema`, `workspace-schema`, `connection-schema`, `host-schema`, `error-schema` | Existing strict request/saved-data decoders and projecting wire-reply decoders |
| `schema` | Shared portable schema constructors |
| `services` | Privileged Effect service ports/tags and endpoint types |

Client entries use erased schema imports, so they emit no Effect runtime code. Explicit schema/service imports may load portable Effect. `workspace` also reexports common/error types to preserve the client surface; every import shares the same error brand and Context service tags.

DTO shape validation grants no authority. `services` is a privileged capability boundary: `ConnectionService.endpoint` carries origin/token configuration that must never enter renderer bridges, public settings or logs. The public `host` entry contains identity/health data, without endpoint credentials. Executable HMAC verification is the Node-only `@moonbase/ssh/host-health` leaf; safe failure/resource helpers belong to `@moonbase/effect`.

Domain inputs/results, snapshots and public error DTOs are serializable data. `ApplicationError` is a runtime class; transports encode/validate the existing error DTO instead. Client methods, callback subscriptions, AbortSignals, cancellation/observation handles, Effect service tags and runtime objects remain in process. A TypeScript consumer uses application controllers directly. A future process/language client needs a concrete adapter and separate transport/runtime qualification; contracts do not supply a generic bridge.

See [schema policies](docs/SCHEMAS.md), [chat admission/protocol](docs/CHAT.md), [host authentication](docs/HOST-PROTOCOL.md) and [recovery publications](docs/RECOVERY-PUBLICATIONS.md). Saved work retains strict version/context/nested-field checks and original bytes on rejection; extraction introduces no data migration or protocol change.

```sh
bun run --cwd packages/contracts typecheck
bun run --cwd packages/contracts lint
bun run --cwd packages/contracts test
bun run check:foundation
```

Tests retain the pre-extraction schema assertions, verify public browser/type-only bundle graphs, and reuse unchanged baseline-produced data through the foundation check.

Local Create includes immutable folder/model settings; local host replies contain `mode: "local"` without global settings. Remote requests/replies retain their existing formats. Provider setup ports expose only catalogs/status and live prompt identities; credentials remain privileged. See the [chat boundary](docs/CHAT.md).

Local settings and conversation summaries accept optional `reasoningEffort`. Provider catalogs expose supported efforts, a model's initial effort and a maintained per-provider default. `ChatModelPreference` describes the portable model/effort choice without folder authority; all additions preserve existing field-absent payloads.
