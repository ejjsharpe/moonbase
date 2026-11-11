# Effect helpers

`@moonbase/effect` holds small Effect helpers shared by application, workspace, Pi, the daemon protocol and SSH:

- `safeApplicationFailure(value, fallback)` keeps an owner-authored `ApplicationError`, otherwise returns a safe `Unavailable` error.
- `normalizeApplicationError(value)` does the same with a fixed fallback message, without exposing unknown diagnostics.
- `releaseResource(release)` awaits cleanup and surfaces a redacted cleanup failure as an Effect defect.
- `./changes`: `followChanges(subscribe, read, receive, fail)` re-reads a value after each change a source reports, one read at a time; `readOnChange` is the same as a stream that holds only the latest value. The chat engine's watches and the daemon socket's subscriptions both use it.

```sh
bun run --cwd packages/effect typecheck
bun run --cwd packages/effect lint
bun run --cwd packages/effect test
```
