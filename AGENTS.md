# Working on Moonbase

Moonbase is prerelease. The code and tests are the source of truth; docs only describe how things are today. Read the root README and the README of each module you change.

Nothing here is set in stone. If a task would be better served by changing the architecture, a design choice or a saved/wire format, propose it rather than working around it. Formats can change without migrations or compatibility shims unless the task asks for them. Data may be lost between versions while Moonbase is prerelease: a change can start from a fresh store instead of migrating, but leaves the old data on disk untouched rather than deleting it.

## Structure

- Packages own behavior; apps compose packages and supply platform integration. Consume other modules through their public exports and inject dependencies rather than importing an app.
- `bun run check:foundation` enforces the current package boundaries. If you intentionally change a boundary, change the checker in the same PR.
- Keep changes in scope. Reuse existing modules before adding abstractions, and add flexibility only for a concrete consumer.
- Name functions with verb phrases (`findFile`, `saveDraft`) and variables/types with noun phrases.
- UI uses `packages/ui` StyleX tokens/recipes and Base UI. The tokens are the design reference.

## Testing

- Test nontrivial behavior through public interfaces, including failure, cancellation and cleanup paths.
- Tests use temporary directories, stores and repositories, faux providers and injected platform capabilities. Never read or write the real OS clipboard in tests; inject callbacks.

## Safety

- Never lose a user's unsaved work, and never delete or overwrite real user data or state outside temporary test locations.
- Keep credentials and host keys out of the repository, logs, URLs, process arguments and renderer code.
- Don't spend real provider quota, connect to an SSH host the user hasn't named, or bypass SSH host-key checking without explicit authorization.
- Don't deploy, publish releases or merge PRs.

## PRs and docs

Use Conventional Commit PR titles and link PRs with T3 when available. Keep docs short. Put provenance, test logs and handoff notes in PR descriptions, not committed docs.
