# Editor/workspace integration

Runs the application's editor services against the real workspace service, with temporary Git repositories, files and recovery stores. Requires macOS with the Xcode command-line tools; runs under `bun test`.

```sh
bun run --cwd test/editor-workspace test:macos
```

- `unsaved-work.test.ts` holds the exhaustive never-lose-unsaved-work cases (a crash before a flush, an edit during a save, a lost save reply, move and Trash with open drafts, two windows, Quit), each checked after a restart.
- `strict-recovery.test.ts` checks that a stored recovery of an unknown format is refused and left untouched.
- `daemon.test.ts` runs two editor clients, each with its own recovery store, on one checkout through a real daemon process (the faux test entry, in temporary data).
- `integration.test.ts` covers saves, conflicts, mutations and restart recovery; `editor-workspace-fixture.ts` is the shared setup.
