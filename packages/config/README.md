# Shared configuration

`@moonbase/config` supplies the repository's lint, formatting and TypeScript defaults:

- `./oxlint` exports `base`, `node` and `web` presets.
- `./oxfmt` exports formatting settings.
- `./typescript/base.json` exports the shared TypeScript configuration.

Root configuration files select project-specific overrides. Run `bun run lint` and `bun run format:check` from the repository root, and `bun run --cwd packages/config test` for configuration, independent-contract and headless model graph checks. These allow browser-safe Effect and `lru-cache` while rejecting privileged implementations and UI dependencies from headless exports.
