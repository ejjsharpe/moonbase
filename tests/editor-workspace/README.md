# Editor/workspace integration

Runs the public editor controller against the real workspace service with temporary Git repositories, files and recovery stores. Covers saves, conflicts, mutations, uncertain delivery and restart recovery. `daemon.test.ts` runs two editor clients, each with its own recovery store, on one checkout through a real daemon process (the faux test entry, in temporary data) over its WebSocket. Runs under `bun test`. Requires macOS with Xcode command-line tools.

```sh
bun run test:editor-integration
```
