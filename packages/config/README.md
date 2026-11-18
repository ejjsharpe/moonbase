# Shared configuration

`@moonbase/config` supplies the repository's lint, formatting and TypeScript defaults:

- `./oxlint` exports `base`, `node` and `web` presets, and `effectNativeRules`/`effectNativeOff` for D15: production code (`apps/*/src`, `packages/*/src`) may not use `setTimeout`, `setInterval`, `Date.now`, `performance.now`, `AbortController`, `new Promise` or a runtime `run*` call. The root `oxlint.config.mts` lists the edge files that may, each lifting only what it names, with its reason.
- `./oxfmt` exports formatting settings.
- `./typescript/base.json` exports the shared TypeScript configuration.

Root configuration files select project-specific overrides. Run `bun run lint` and `bun run format:check` from the repository root, and `bun run --cwd packages/config test` for configuration, independent-contract and headless model graph checks. These allow browser-safe Effect and `lru-cache` while rejecting privileged implementations and UI dependencies from headless exports.
