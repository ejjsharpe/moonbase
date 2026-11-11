# Moonbase

A macOS workbench for editing local projects and chatting with Pi Durable agents, locally or on a remote host over SSH.

| Module | Owns |
| --- | --- |
| [Contracts](packages/contracts/README.md) | Shared DTOs, schemas, client interfaces and Effect service ports |
| [Effect helpers](packages/effect/README.md) | Shared failure normalization and resource release |
| [Application](packages/application/README.md) | Headless editor/chat controllers, composition and lifecycle |
| [Workbench](packages/workbench/README.md) | Project file sidebar, buffers and React/Monaco editor |
| [Workspace](packages/workspace/README.md) | Local files, Git, recovery storage and file watching |
| [Pi runtime](packages/pi-runtime/README.md) | Pi chat execution, provider setup and credentials |
| [Daemon protocol](packages/daemon-protocol/README.md) | The daemon's signed health, authenticated WebSocket, its server, the remote client services and host folder authority |
| [SSH](packages/ssh/README.md) | Authenticated SSH port forwarding to a chat host |
| [UI](packages/ui/README.md) | Shared StyleX tokens, recipes and icons |
| [Config](packages/config/README.md) | Lint, formatting and TypeScript defaults |
| [Desktop](apps/desktop/README.md) | Electron app: navigation, Chat view, native capabilities and packaging |
| [Daemon](apps/daemon/README.md) | Bun process root that serves chats from its own data directory |

See [AGENTS.md](AGENTS.md) for contribution rules.

## Development

Use Bun 1.4.4 and Node 26.13.0. Native workspace and desktop builds require macOS and Xcode command-line tools.

```sh
bun install --frozen-lockfile
bun run check:foundation
bun run typecheck
bun run lint
bun run test
bun run format:check
bun run test:editor-integration
bun run test:chat-integration
```

`bun run test` runs package suites serially, because concurrent native/process fixtures can delay file-watcher delivery past test deadlines. These are the PR checks; the browser and Electron Playwright suites (`packages/workbench` `test:ui`, `apps/desktop` `test:browser`, `test:native` and `test:package`) run in the `nightly` workflow, which can also be run by hand from Actions. Generated test output goes in ignored `test-results/`; build output goes in `dist/` and `release/`.

PR titles use Conventional Commits, for example `fix(editor): retain drafts`; the `conventional-commits` check enforces this. PRs are squash-merged with the PR title as the commit subject.
