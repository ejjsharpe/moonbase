# Moonbase

A macOS workbench for local editing and optional remote Pi Durable chat. Reusable packages own feature behavior; clients compose them through public interfaces and supply platform capabilities.

| Module | Owns |
| --- | --- |
| [Application](packages/application/README.md) | Shared commands, browser clients and Effect service contracts |
| [Editor](packages/editor/README.md) | React/Monaco workbench and independent editor state |
| [Chat](packages/chat/README.md) | Headless chat state and draft preservation |
| [Workspace](packages/workspace/README.md) | Local files, Git and recovery persistence |
| [Pi runtime](packages/pi-runtime/README.md) | Pi chat execution, host transport and remote adapter |
| [SSH](packages/ssh/README.md) | Scoped, authenticated SSH connectivity |
| [UI](packages/ui/README.md) | Shared StyleX tokens and recipes |
| [Config](packages/config/README.md) | Lint, formatting and TypeScript defaults |
| [Desktop](apps/desktop/README.md) | Electron composition, native authority and packaging |

Packages consume public exports, accept injected dependencies and stay independent of client applications. Each process owns one scoped Effect runtime; standalone clients acquire only the capabilities they use. See [AGENTS.md](AGENTS.md) for contribution rules and [DESIGN.md](docs/DESIGN.md) for UI guidance.

## Development

Use Bun 1.4.4 and Node 26.13.0. Workspace/native desktop builds require macOS and Xcode command-line tools.

```sh
bun install --frozen-lockfile
bun run check:foundation
bun run typecheck
bun run lint
bun run test
bun run format:check
```

Package READMEs cover setup and focused checks. The [editor/workspace](tests/editor-workspace/README.md) and [chat](tests/chat/README.md) suites test cross-module integration. Generated test output belongs in ignored `test-results/`; build/package output belongs in `dist/` and `release/`.

Human acceptance remains pending. Controlled tests do not qualify real SSH/providers, packaged/native interaction, signing/notarization, VoiceOver, physical durability or Intel execution.
