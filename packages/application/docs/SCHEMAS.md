# Effect clients

Shared shapes and strict decoder policies live in [contracts](../../contracts/docs/SCHEMAS.md). Application owns invocation and observation in the caller-supplied runtime.

## Caller-owned runtime

`@moonbase/application/runtime/effect-client` exports:

```ts
normalizeApplicationError(value: unknown): ApplicationError;

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

`normalizeApplicationError` lets Promise IO adapters create typed failures before inspecting their outcomes. It preserves authentic branded errors by identity and returns fixed `Unavailable` / `Application effect failed` for unknown values, without inspecting private diagnostics.

The helpers never acquire services, create/dispose a runtime or retry commands. An empty renderer runtime (`R = never`, `E = never`) works for injected browser clients/models. Pre-aborted commands dispatch nothing. Typed error identity/target and composite cleanup evidence survive normalization; interruption alone becomes `Cancelled`. Unknown defects and unexpected runner failures use static safe diagnostics. `releaseResource` likewise redacts unknown cleanup failures before combining them with a command cause; explicitly authored `ApplicationError` values retain their safe owner diagnostics. This does not stringify raw Cause/FiberFailure objects or change the general-purpose `ApplicationError.fromUnknown` conversion.

`normalizeApplicationError` and `releaseResource` have their single implementation in `@moonbase/effect`; invocation reexports the normalizer for its existing callers. `ApplicationError` is defined by `@moonbase/contracts/errors`, and `CommandOptions` / `ObservationClose` by `@moonbase/contracts/common`. Contracts `services` owns the canonical service tags and privileged ports. None of these definitions authorizes a browser consumer to obtain a private endpoint.

`ObservationClose = () => Promise<void>` is an Effect-free public type. Close fences event delivery immediately, interrupts the actual observation, and joins its exit/finalizers. Repeated close returns the same promise and outcome. Active failures reach `onError`; cleanup failure after deliberate close rejects the close promise, without duplicate active callback delivery. The application root retains and observes cleanup after its panel disappears, and drains those tasks before root disposal. Snapshot-store subscriptions remain synchronous. Closing observation never rolls back mutations or Stops remote work.

```ts
const close = client.watch(input, receive, reportActiveFailure);
// After the preservation gate, remove the panel and retain this task at the root.
await close(); // May reject with a normalized cleanup failure.
```

## Runtime-bound clients and dispatch

`@moonbase/application/runtime/clients` exports the existing direct Promise facades:

```ts
makeEditorClient(runtime: ManagedRuntime<WorkspaceService, ApplicationError>): EditorClient;
makeChatClient(runtime: ManagedRuntime<ChatService, ApplicationError>): ChatClient;
makeConnectionClient(runtime: ManagedRuntime<ConnectionService, ApplicationError>): ConnectionClient;
```

Each facade binds the supplied process runtime and forwards the original operation/input/options to invocation. `runtime/handlers` exports `workspaceCommand`, `chatCommand`, `connectionCommand` and the corresponding `workspaceWatch`, `chatWatch`, `connectionWatch`; each selects the same injected service port. UI, native and transport entry points share these handlers. No adapter, serialization round trip, queue, runtime or backend is installed by binding a facade or importing these modules. Named infrastructure process roots consume these public runtime entries; reusable service exports depend on contracts and the focused shared helpers instead.

Feature extraction uses `src/features/chat` and `src/features/editor`, with internal imports of `../../runtime/effect-client.ts`; feature tickets own their controller/state APIs and tests, while `src/runtime/{handlers,clients,effect-client}.ts` remains the shared invocation implementation. Composition will own application lifecycle in its own runtime files. Do not reacquire a model while binding its controller.

The old `handlers`, `runtime-client` and `effect-client` exports are identity-preserving aliases until migration cleanup. Canonical DTO/client exports live in contracts and emit no Effect implementation; contracts schemas/services and all three application runtime entries are browser-safe and Effect-dependent. Portable bundle tests inspect their actual transitive inputs, excluding UI, Node, providers and infrastructure implementations.
