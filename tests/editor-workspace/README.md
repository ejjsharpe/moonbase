# Editor/workspace integration

Exercises the public editor controller against the real workspace service using temporary Git repositories, files and recovery stores. Covers saves, conflicts, mutations, uncertain delivery and restart recovery.

Run from the repository root on macOS with the pinned Node/Bun tooling and Xcode command-line tools:

```sh
bun run test:editor-integration
```

The command typechecks the suite and builds the native filesystem helper before testing. These checks do not establish packaged desktop or manual UI acceptance.
