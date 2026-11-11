# Working on Moonbase

Moonbase is prerelease. The code and tests are the source of truth; docs only describe how things are today. Read the root README and the README of each module you change.

Nothing here is set in stone. If a task would be better served by changing the architecture, a design choice or a saved/wire format, propose it rather than working around it. Formats can change without migrations or compatibility shims unless the task asks for them.

Data may be lost between versions while Moonbase is prerelease: a change can start from a fresh store instead of migrating.

## Structure

- Packages own behavior; apps compose packages and supply platform integration. Consume other modules through their public exports and inject dependencies rather than importing an app.
- `bun run check:foundation` enforces the current package boundaries. If you intentionally change a boundary, change the checker in the same PR.
- Keep changes in scope. Reuse existing modules before adding abstractions, and add flexibility only for a concrete consumer.
- Name functions with verb phrases (`findFile`, `saveDraft`) and variables/types with noun phrases.
- UI uses `packages/ui` StyleX tokens/recipes and Base UI. The tokens are the design reference.

## Testing

- Test each behavior once, through public interfaces, at the lowest level that proves it. Add a browser or Electron test only for what needs the real boundary.
- Cover one representative failure, cancellation and cleanup path per mechanism. Don't loop a test over every failure point, operation, flag, signal or version unless the code path differs.
- Don't pin exact copy, CSS values, layout, icons, default model ids, version tables or saved-format bytes; assert codes or state. No migration or compatibility tests.
- Extend an existing test instead of adding one per review round, and name tests after the behavior, never "R1" or "round".
- No fixed sleeps or real multi-second waits: inject a clock or deadline, or poll on state. No screenshots or evidence files that nothing asserts on.
- Be exhaustive only at security boundaries (tokens, credentials, HMAC auth, SSH host keys, path and folder authority, supply-chain pinning) and for never losing unsaved work or duplicating a send.
- Reviewers flag overkill tests as should-fix (delete, merge or slim) and don't ask for extra permutations outside those boundaries.
- Tests use temporary directories, stores and repositories, faux providers and injected platform capabilities. Never read or write the real OS clipboard in tests; inject callbacks.
- PR checks run the unit suites and the root integration suites. Browser and Electron Playwright suites run nightly (`nightly` workflow, also runnable by hand); run the ones you touch locally.

## Safety

- Never lose a user's unsaved work, and never delete or overwrite real user data or state outside temporary test locations.
- Keep credentials and host keys out of the repository, logs, URLs, process arguments and renderer code.
- Don't spend real provider quota, connect to an SSH host the user hasn't named, or bypass SSH host-key checking without explicit authorization.

## PRs and docs

Use Conventional Commit PR titles. Keep docs short. Put provenance, test logs and handoff notes in PR descriptions, not committed docs.
