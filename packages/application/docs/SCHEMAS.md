# Shared shapes and Effect clients

Application schemas define structural/value bounds, not authority. Workspace owns path/filesystem identity, baselines, recovery membership and receipt relationships; Pi owns durable admission; SSH owns executable/key/policy checks; desktop owns document/native grants and transport envelope limits.

| Export | Schemas | Synchronous decoders |
| --- | --- | --- |
| `workspace-schema` | Existing workspace/editor DTO names with `Schema` suffix, `WorkspaceIdentifierSchema`, `WorkspaceWatchInputSchema`, `workspaceInputSchemas`, `workspaceOutputSchemas` | `decodeWorkspaceInput`, `decodeWorkspaceOutput`, `decodeWorkspaceWatchInput`, `decodeWorkspaceEvent`, `decodeEditorRecovery`, `isWorkspaceCommand` |
| `connection-schema` | `ConnectionProfileSchema`, `ConnectionSnapshotSchema`, `connectionInputSchemas`, `connectionOutputSchemas` | `decodeConnectionInput`, `decodeConnectionOutput`, `decodeConnectionProfile`, `decodeConnectionSnapshot`, `isConnectionCommand` |
| `host-schema` | `ChatIdentifierSchema`, `ChatHostTargetSchema`, `ChatHostHealthSchema` | `decodeChatHostTarget`, `decodeChatHostHealth` |
| `error-schema` | `ApplicationErrorCodeSchema`, `ApplicationErrorDTOSchema` | `decodeApplicationErrorDTO` |
| `chat-schema` | Existing chat schemas; identifier/host-target exports alias `host-schema` | Existing `decodeChatInput`, `decodeChatOutput`, `isChatCommand` |

The workspace registries cover openCheckout, readFile, saveFile, listDirectory, gitStatus, readComparison, lookupFiles, inspectEntries, mutate, operationStatus, acknowledgeOperation, loadRecovery, persistRecovery and getRecoveryPublication. The connection registries cover getConnection, connect and disconnect, including exact undefined output for void commands.

Request decoders reject unfamiliar fields recursively and use safe `InvalidInput` errors. Ordinary successful reply/event decoders project recognized fields and use `Incompatible` on malformed data. Optional undefined fields are omitted; mutable DTO fields/arrays, null distinctions and dynamic record keys remain supported. Workspace request/client identities retain their own 160-character grammar; chat/connection/host identities retain their separate 256-character grammar. Text byte limits and filename UTF-16 limits remain distinct.

Saved recovery is the exception to wire projection. Call `decodeEditorRecovery` on saved unknown data before rebuilding or publishing model state. `decodeWorkspaceInput('persistRecovery', ...)` and `decodeWorkspaceOutput('loadRecovery', ...)` reject unfamiliar saved fields at every nested object level. The latter validates the original state before projecting ordinary reply fields. Rejection never authorizes rewriting, resetting or migration. Private saved envelopes remain with their owning package. Direct use of Schema APIs must supply the appropriate excess-property policy; the public decoders enforce it.

A decoded error DTO is ordinary data. It does not pass `ApplicationError.is`; transport adapters explicitly construct branded errors after validation and retain their own message/size caps. No rejected value appears in decoder diagnostics.

## Caller-owned runtime

`effect-client` exports:

```ts
runApplicationEffect<A, R, E extends ApplicationError>(
  runtime: ManagedRuntime<R, E>,
  effect: Effect<A, ApplicationError, R>,
  options?: CommandOptions,
): Promise<A>

observeApplicationStream<A, R, E extends ApplicationError>(
  runtime: ManagedRuntime<R, E>,
  stream: Stream<A, ApplicationError, R>,
  receive: (event: A) => void,
  onError: (error: ApplicationError) => void,
): ObservationClose
```

The helpers never acquire services, create/dispose a runtime or retry commands. An empty renderer runtime (`R = never`, `E = never`) works for injected browser clients/models. Pre-aborted commands dispatch nothing. Typed error identity/target and composite cleanup evidence survive normalization; interruption alone becomes `Cancelled`. Unknown defects and unexpected runner failures use static safe diagnostics. `releaseResource` likewise redacts unknown cleanup failures before combining them with a command cause; explicitly authored `ApplicationError` values retain their safe owner diagnostics. This does not stringify raw Cause/FiberFailure objects or change the general-purpose `ApplicationError.fromUnknown` conversion.

`ObservationClose = () => Promise<void>` is an Effect-free public type. Close fences event delivery immediately, interrupts the actual observation, and joins its exit/finalizers. Repeated close returns the same promise and outcome. Active failures reach `onError`; cleanup failure after deliberate close rejects the close promise, without duplicate active callback delivery. The application root retains and observes cleanup after its panel disappears, and drains those tasks before root disposal. Snapshot-store subscriptions remain synchronous. Closing observation never rolls back mutations or Stops remote work.

```ts
const close = client.watch(input, receive, reportActiveFailure);
// After the preservation gate, remove the panel and retain this task at the root.
await close(); // May reject with a normalized cleanup failure.
```

The `client`, `chat-client`, `connection-client` and `host-client` exports use type-only schema imports and emit no Effect implementation. Explicit schema and effect-client exports are browser-safe and Effect-dependent; they include no privileged backend/service composition.
