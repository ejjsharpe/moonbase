# Effect helpers

`@moonbase/effect` holds small Effect helpers shared by application, workspace, Pi and SSH:

- `safeApplicationFailure(value, fallback)` keeps an owner-authored `ApplicationError`, otherwise returns a safe `Unavailable` error.
- `normalizeApplicationError(value)` does the same with a fixed fallback message, without exposing unknown diagnostics.
- `releaseResource(release)` awaits cleanup and surfaces a redacted cleanup failure as an Effect defect.

```sh
bun run --cwd packages/effect typecheck
bun run --cwd packages/effect lint
bun run --cwd packages/effect test
```
