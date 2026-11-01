# Moonbase

A macOS Electron workbench with a local React/Monaco editor and optional remote Pi Durable chat. Workspace, editor, SSH and Pi services share the application contracts and one scoped Effect runtime per process.

See [module boundaries](MODULES.md), [design rules](DESIGN.md), [desktop setup](apps/desktop/README.md) and [standalone chat setup](apps/chat-probe/README.md). Package READMEs describe their public APIs. Source provenance and the checksum-verified reference snapshot are retained alongside the code.

```sh
bun install --frozen-lockfile
bun run check:foundation
bun run typecheck
bun run lint
node scripts/prepare-ripgrep.mjs
bun run test
bun run test:editor-integration
bun run test:chat-integration
```

Native workspace checks require macOS and Xcode command-line tools. Lint currently runs TypeScript diagnostics. Generated test output belongs in ignored `test-results/`; build and package output belongs in `dist/` and `release/`.

The desktop remains pending human acceptance. Real SSH/provider, signing/notarization, VoiceOver, physical durability and Intel execution require separate qualification.
