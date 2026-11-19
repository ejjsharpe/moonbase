# Moonbase

A macOS workbench for editing local projects and chatting with Pi Durable agents, locally or on a remote host over SSH.

The daemon owns projects and chats: it serves files, saves, Git, worktrees, search, watching and chats over two authenticated WebSockets, one for chat and one for files. Electron is a client of the local daemon; it keeps the native pickers, clipboard, Finder and each client's own drafts. A daemon in host mode serves its approved roots the same way to clients on other machines.

| Module | Owns |
| --- | --- |
| [Contracts](packages/contracts/README.md) | Shared DTOs, schemas, tagged errors, RPC groups and Effect service ports |
| [Application](packages/application/README.md) | Headless editor and chat state as per-concept services and atoms, and their composition |
| [Workbench](packages/workbench/README.md) | Project file sidebar, buffers and React/Monaco editor |
| [Workspace](packages/workspace/README.md) | The macOS file host (files, Git, worktrees, search, watching, journals) and the client recovery store (drafts, editor state) |
| [Chat runtime](packages/chat-runtime/README.md) | Pi chat execution, provider setup and credentials |
| [Daemon protocol](packages/daemon-protocol/README.md) | Signed health, the authenticated RPC sockets, the daemon's listener and the client services over them |
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

- `bun run test` runs three package suites at a time, each in up to `MOONBASE_TEST_WORKERS` processes (default 4).
- PR checks run only the suites of the packages a PR changes and their dependents; a push to main runs them all. Tests that need macOS (each package's `test/macos/`, and all of `packages/workspace`, through `test:macos`) run on one macOS runner and the rest on Linux. The browser Playwright suites (`packages/workbench` `test:ui`, `apps/desktop` `test:browser`) run on Linux, and Electron's (`test:native`, `test:package`) on macOS.
- Test output goes in ignored `test-results/`, build output in `dist/` and `release/`.

PR titles use Conventional Commits, for example `fix(editor): retain drafts`; the `conventional-commits` check enforces this. PRs are squash-merged with the PR title as the commit subject.
