# Moonbase

A macOS Electron workbench with a local React/Monaco editor and optional remote Pi Durable chat. Workspace, editor, SSH and Pi services share the application contracts and one scoped Effect runtime per process.

This foundation contains shared application contracts, UI recipes and tool configuration. See [module boundaries](MODULES.md), [design rules](DESIGN.md) and [source provenance](docs/source-snapshot/README.md). Desktop and standalone chat setup, native prerequisites and integration commands belong to the later module PRs that add those applications.

Run the foundation checks with Bun 1.4.4 and Node 26.13.0:

```sh
bun install --frozen-lockfile
bun run check:foundation
bun run typecheck
bun run lint
bun run test
bun run format:check
```

Lint runs oxlint; typecheck runs TypeScript through Nx. Generated test output belongs in ignored `test-results/`; build and package output belongs in `dist/` and `release/`.

The desktop remains pending human acceptance. Real SSH/provider, signing/notarization, VoiceOver, physical durability and Intel execution require separate qualification.

The frozen snapshot documents the extraction baseline; active `packages/ui` recipes evolve independently while the archived sources and hashes remain unchanged.

The [originating brief](docs/agents/prompts/OVERNIGHT.txt) is retained as historical requirements.
