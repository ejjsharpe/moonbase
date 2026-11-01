# Moonbase

A macOS Electron workbench with a local React/Monaco editor and optional remote Pi Durable chat. Workspace, editor, SSH and Pi services share the application contracts and one scoped Effect runtime per process.

Each application and package keeps its setup and public interface in its README:

| Package | Purpose |
| --- | --- |
| [Desktop](apps/desktop/README.md) | Electron workbench and native packaging |
| [Chat](packages/chat/README.md) | Headless client chat state and preservation |
| [Application](packages/application/README.md) | Shared commands, clients and Effect service contracts |
| [Editor](packages/editor/README.md) | React/Monaco workbench |
| [Workspace](packages/workspace/README.md) | Local files, Git and recovery |
| [Pi runtime](packages/pi-runtime/README.md) | Chat host and remote adapter |
| [SSH](packages/ssh/README.md) | Scoped SSH connections |
| [UI](packages/ui/README.md) | Shared StyleX tokens and recipes |
| [Config](packages/config/README.md) | Shared lint, format and TypeScript configuration |

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

The [editor/workspace](tests/editor-workspace/README.md) and [chat](tests/chat/README.md) integration suites exercise public module boundaries.
