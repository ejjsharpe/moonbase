# Moonbase

A macOS Electron workbench with a local React/Monaco editor and optional remote Pi Durable chat. Workspace, editor, SSH and Pi services share the application contracts and one scoped Effect runtime per process.

This foundation provides shared application contracts, dispatch adapters, UI styles and regression tests. It does not yet include a runnable desktop or standalone chat application; their implementations and setup instructions arrive in later PRs.

See [module boundaries](MODULES.md) and [design rules](DESIGN.md). Application contract documents live in `packages/application`. Source provenance and the checksum-verified reference snapshot are retained alongside the code.

Run the foundation checks:

```sh
bun install --frozen-lockfile
bun run check:foundation
bun run typecheck
bun run lint
bun run test
```

Lint currently runs TypeScript diagnostics. Native workspace checks in later PRs require macOS and Xcode command-line tools. Generated test output belongs in ignored `test-results/`; build and package output belongs in `dist/` and `release/`.

The desktop remains pending human acceptance. Real SSH/provider, signing/notarization, VoiceOver, physical durability and Intel execution require separate qualification.
