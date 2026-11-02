# Moonbase

A macOS workbench for local editing and optional remote Pi Durable chat. Reusable packages own feature behavior; clients compose them through public interfaces and supply platform capabilities.

| Module | Owns |
| --- | --- |
| [Contracts](packages/contracts/README.md) | Independent DTOs, schemas, clients and Effect service ports |
| [Effect helpers](packages/effect/README.md) | Safe shared failure normalization and resource release |
| [Application](packages/application/README.md) | Headless editor/chat features, composition, lifecycle and shared dispatch |
| [Editor](packages/editor/README.md) | React/Monaco presentation receiving an application controller |
| [Workspace](packages/workspace/README.md) | Local files, Git and recovery persistence |
| [Pi runtime](packages/pi-runtime/README.md) | Pi chat execution, host transport and remote adapter |
| [SSH](packages/ssh/README.md) | Scoped, authenticated SSH connectivity |
| [UI](packages/ui/README.md) | Shared StyleX tokens and recipes |
| [Config](packages/config/README.md) | Lint, formatting and TypeScript defaults |
| [Desktop](apps/desktop/README.md) | Electron composition, native authority and packaging |

Packages consume public exports, accept injected dependencies and stay independent of client applications. Each process owns one scoped Effect runtime; standalone clients acquire only the capabilities they use. See [AGENTS.md](AGENTS.md) for contribution rules and [DESIGN.md](docs/DESIGN.md) for UI guidance.

Use [`createMoonbaseApplication`](packages/application/docs/LIFECYCLE.md) with injected clients, stable identities and synchronous storage for editor-only, chat-only or combined applications. Each application owns one client runtime and independent feature scopes; Electron main keeps its privileged runtime. The [direct headless consumer](packages/application/docs/HEADLESS-CONSUMER.md) demonstrates ordinary TypeScript use and the separate responsibilities of a future process/language adapter.

The [architecture and baseline](docs/HEADLESS-ARCHITECTURE.md) records enforced ownership, public exports, helper decisions and compatibility evidence. The [epic delivery ledger](https://github.com/ejjsharpe/moonbase/issues/63#issuecomment-6585556403) tracks final review, source, controlled, native and packaged acceptance separately.

## Development

Use Conventional Commit PR titles, for example `fix(editor): retain drafts` or `feat: add workspace search`. The required `conventional-commits` check validates titles, and PRs use squash merging with the PR title as the commit subject. Keep that generated subject when merging.

Use Bun 1.4.4 and Node 26.13.0. Workspace/native desktop builds require macOS and Xcode command-line tools.

```sh
bun install --frozen-lockfile
bun run check:foundation
bun run typecheck
bun run lint
bun run test
bun run format:check
```

The root source test command runs package suites serially because concurrent native/process fixtures can delay filesystem watcher delivery beyond its existing deadline. Each package retains its own test concurrency and timeouts.

Package READMEs cover setup and focused checks. The [editor/workspace](tests/editor-workspace/README.md) and [chat](tests/chat/README.md) suites test cross-module integration. Generated test output belongs in ignored `test-results/`; build/package output belongs in `dist/` and `release/`.

Human acceptance remains pending. Controlled tests do not qualify real SSH/providers, packaged/native interaction, signing/notarization, VoiceOver, physical durability or Intel execution.
