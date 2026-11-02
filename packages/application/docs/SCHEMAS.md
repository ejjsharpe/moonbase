# Effect clients

Shared shapes and strict decoder policies live in [contracts](../../contracts/docs/SCHEMAS.md). Application owns invocation and observation in the caller-supplied runtime.

## Caller-owned runtime

`effect-client` exports:

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

`ObservationClose = () => Promise<void>` is an Effect-free public type. Close fences event delivery immediately, interrupts the actual observation, and joins its exit/finalizers. Repeated close returns the same promise and outcome. Active failures reach `onError`; cleanup failure after deliberate close rejects the close promise, without duplicate active callback delivery. The application root retains and observes cleanup after its panel disappears, and drains those tasks before root disposal. Snapshot-store subscriptions remain synchronous. Closing observation never rolls back mutations or Stops remote work.

```ts
const close = client.watch(input, receive, reportActiveFailure);
// After the preservation gate, remove the panel and retain this task at the root.
await close(); // May reject with a normalized cleanup failure.
```

The `client`, `chat-client`, `connection-client` and `host-client` exports use type-only schema imports and emit no Effect implementation. Explicit schema and effect-client exports are browser-safe and Effect-dependent; they include no privileged backend/service composition.
