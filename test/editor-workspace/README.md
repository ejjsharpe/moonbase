# Editor/workspace integration

Runs the public editor controller against the real workspace service with temporary Git repositories, files and recovery stores. Covers saves, conflicts, mutations and restart recovery. `unsaved-work.test.ts` holds the exhaustive never-lose-unsaved-work cases (crash before a flush, edits during a save, a lost save reply, moves and Trash, two windows, Quit), each checked after a restart; `strict-recovery.test.ts` checks that a stored recovery of an unknown format is refused and left untouched. `editor-workspace-fixture.ts` is the shared setup. `daemon.test.ts` runs two editor clients, each with its own recovery store, on one checkout through a real daemon process (the faux test entry, in temporary data) over its WebSocket. Runs under `bun test`. Requires macOS with Xcode command-line tools.

```sh
bun run test:editor-integration
```
