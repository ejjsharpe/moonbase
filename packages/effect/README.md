# Focused Effect helpers

`@moonbase/effect` owns three existing portable helpers used by application, workspace, Pi and SSH. It depends only on independent contracts and Effect; it creates no runtime or scheduler.

- `safeApplicationFailure(value, fallback)` preserves an owner-authored branded error, otherwise returns a fixed safe `Unavailable` diagnostic.
- `normalizeApplicationError(value)` uses the existing `Application effect failed` fallback without inspecting unknown diagnostics.
- `releaseResource(release)` awaits actual cleanup and makes a redacted cleanup failure observable as an Effect defect. Typed owner errors retain their safe diagnostics.

Runtime-bound invocation/observation remains application behavior. This package contains no general utilities, backend implementations or authority. Its four existing consumers justify this shared ownership without service-to-application back edges.

```sh
bun run --cwd packages/effect typecheck
bun run --cwd packages/effect lint
bun run --cwd packages/effect test
```
