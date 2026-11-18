# Moonbase

A macOS workbench for editing local projects and chatting with Pi Durable agents, locally or on a remote host over SSH.

The daemon owns projects: it serves files, saves, Git, worktrees, search and watching, and chats, over one authenticated WebSocket. Electron is a client of the local daemon; it keeps the native pickers, clipboard, Finder and each client's own drafts. A daemon in host mode serves its approved roots the same way to clients on other machines.

| Module | Owns |
| --- | --- |
| [Contracts](packages/contracts/README.md) | Shared DTOs, schemas, client interfaces and Effect service ports |
| [Application](packages/application/README.md) | Headless editor/chat controllers, composition and lifecycle |
| [Workbench](packages/workbench/README.md) | Project file sidebar, buffers and React/Monaco editor |
| [Workspace](packages/workspace/README.md) | The macOS file host (files, Git, worktrees, search, watching, journals) and the client recovery store (drafts, editor state) |
| [Chat runtime](packages/chat-runtime/README.md) | Pi chat execution, provider setup and credentials |
| [Daemon protocol](packages/daemon-protocol/README.md) | The daemon's signed health, authenticated WebSocket, its server, the remote client services and host folder authority |
| [SSH](packages/ssh/README.md) | Authenticated SSH port forwarding to a chat host |
| [UI](packages/ui/README.md) | Shared StyleX tokens, recipes and icons |
| [Config](packages/config/README.md) | Lint, formatting and TypeScript defaults |
| [Desktop](apps/desktop/README.md) | Electron app: navigation, Chat view, native capabilities and packaging |
| [Daemon](apps/daemon/README.md) | Bun process root that serves chats and the workspace (files, Git, worktrees, search, watching) from its own data directory |

See [AGENTS.md](AGENTS.md) for contribution rules.

## Development

Use Bun 1.4.4 and Node 26.13.0. Native workspace and desktop builds require macOS and Xcode command-line tools.

```sh
bun install --frozen-lockfile
bun run check # affected typecheck and tests, lint, format and foundation
bun run check:foundation
bun run typecheck
bun run lint
bun run test
bun run format:check
bun run --cwd test/editor-workspace test:macos
bun run --cwd test/chat test
```

`check:foundation` also checks that the Electron version pinned in the manifests, the packaging config and the workspace runtime gate agree.

`bun run test` runs three package suites at a time; each runs its files in up to `MOONBASE_TEST_WORKERS` processes (default 4: Bun `--parallel`, Node `--test-concurrency`), as the chat integration suite does. PR checks run tests that need macOS (each package's `test/macos/` and all of `packages/workspace`, through `test:macos`) on one macOS runner, and the rest (`test`, or `test:linux` in packages tagged `macos-tests`) on Linux; the browser Playwright suites (`packages/workbench` `test:ui`, `apps/desktop` `test:browser`) run on Linux, and Electron's (`test:native` and `test:package`, one macOS job each) on two more. A PR runs only the suites of the packages it changes and their dependents; a push to main runs them all. Generated test output goes in ignored `test-results/`, with each Playwright run's per-test timings (`timings.json`); build output goes in `dist/` and `release/`.

PR titles use Conventional Commits, for example `fix(editor): retain drafts`; the `conventional-commits` check enforces this. PRs are squash-merged with the PR title as the commit subject.
