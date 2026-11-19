# Shared configuration

`@moonbase/config` supplies the repository's lint, formatting and TypeScript defaults. The root `oxlint.config.mts`, `oxfmt.config.mts` and `tsconfig.base.json` apply them and add project-specific overrides.

| Export | Gives |
| --- | --- |
| `./oxlint` | `base`, `node` and `web` presets, and `effectNativeRules(allowed)`/`effectNativeOff` for D15 |
| `./oxfmt` | Formatting settings |
| `./typescript/base.json` | The shared TypeScript configuration |

D15's rules forbid `setTimeout`, `setInterval`, `Date.now`, `performance.now`, `AbortController`, `new Promise` and runtime `run*` calls in production code. The root `oxlint.config.mts` lists the edge files that may use them, each lifting only what it names, with its reason.

Run `bun run lint` and `bun run format:check` from the repository root. `bun run --cwd packages/config test` lints and formats fixtures in a temporary repository with the root configuration, to check the project's own rules and their exceptions.
