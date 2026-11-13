# Effect helpers

`@moonbase/effect` holds small Effect helpers shared by application, workspace, Pi, the daemon protocol and SSH:

- `normalizeApplicationError(value, fallback?)` keeps an `ApplicationError` and replaces anything else with `fallback` (an `Unavailable` error by default), so an unknown failure's diagnostics never reach a user, a log or another process. It is the one normaliser; callers with a domain meaning (a busy conversation, a persistence failure) pass their own fallback.
- `toApplicationError(cause, fallback?)` turns a failed Effect's cause into one error: `Cancelled` when it was only interrupted, its failure or defect when that is a single `ApplicationError`, and otherwise `fallback`.
- `releaseResource(release)` awaits cleanup and surfaces a redacted cleanup failure as an Effect defect.
- `./changes`: `followChanges(subscribe, read, receive, fail)` re-reads a value after each change a source reports, one read at a time; `readOnChange` is the same as a stream that holds only the latest value. The chat engine's watches and the daemon socket's subscriptions both use it.

```sh
bun run --cwd packages/effect typecheck
bun run --cwd packages/effect lint
bun run --cwd packages/effect test
```
