# Pi runtime

`@moonbase/pi-runtime` implements the contracts `ChatService` on Pi Durable, which owns execution, transcripts and tasks. Layers create no runtime; process roots compose them.

| Export | Role |
| --- | --- |
| `.` | Remote fixed-settings `PiRuntimeLive(config)`, per-conversation `LocalPiRuntimeLive(config)` and privileged `LocalPiControl` |
| `./local-models`, `./providers`, `./credentials` | Local provider catalog, provider sign-in and injected encrypted credential storage |
| `./claude-code` | Claude Pro/Max subscription through the user's Claude Code login ([pi-claude-code](https://github.com/earendil-works/pi-claude-code)) |
| `./server` | `serveChat(config, client)`: authenticated loopback listener for a remote host |
| `./remote` | `RemoteChatLive`: client-side service over an injected `ConnectionService` |

## Host setup

Build the host, then start it on its own machine:

```sh
bun run --cwd packages/pi-runtime build:host
node packages/pi-runtime/dist/host.mjs /absolute/private/moonbase-host.json
```

`build:host` writes a self-contained `host.mjs` and the `inert-mcp.mjs` it needs to `dist/`, which can be built elsewhere and copied over as a pair.

The private JSON file contains:

```json
{
  "host": { "hostId": "my-host", "storeId": "my-store" },
  "actorId": "personal",
  "cwd": "/absolute/existing/working-directory",
  "databasePath": "/absolute/new-moonbase-state/chat.sqlite",
  "model": { "provider": "configured-provider", "modelId": "configured-model" },
  "port": 8787,
  "token": "SEPARATELY-PROVISIONED-PRIVATE-RANDOM-HOST-KEY"
}
```

The listener binds only `127.0.0.1`; reach it through the [SSH package](../ssh/README.md). The token must be 16–4096 printable non-space ASCII characters, kept out of source control, arguments and logs. The host installs Pi's `read`, `write`, `edit` and `bash` tools and uses host-side `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`, or a Claude subscription with `"model": { "provider": "claude-code", "modelId": "claude-opus-5-5" }` after `claude auth login` on the host. Set `PI_CLAUDE_CODE_COMMAND` if `claude` is not on the host's `PATH`, in `~/.local/bin`, `/opt/homebrew/bin` or `/usr/local/bin`; the host exits unavailable when Claude Code is missing or signed out. **The cwd is tool context, not a filesystem sandbox.**

## Behavior worth knowing

- Mutations carry request IDs bound to their full input. A lost or unproved reply is `Uncertain`; callers retry with the original request rather than resending, and reconnects never resend.
- `listChats` gives each chat's `activity`: `running` while a submission owns it, else how its latest generation ended (`idle`, `stopped`, `failed`), with when it started or ended (or the chat's creation time if it never ran).
- A local `createChat` without `cwd` is a chat without a project: after `approveCreation` accepts it, the runtime makes it a new, empty, private folder under `chatFolders`, named for the day, the title's first words and a short id (`2026-11-08-tidy-the-composer-a1b2c3d4`), and lists it with `ownFolder: true`. It is refused when `chatFolders` is unset or sits inside a Git checkout, where the agent's Git commands would act on that repository. The runtime never deletes these folders, so the agent's files stay until you remove them. `LocalPiControl.markFolderAsProject` clears `ownFolder` once the host has opened that folder as a project.
- `settleChat` stores when a chat was settled in its metadata (`settledAt` in listings and snapshots) or clears it; repeating the current state commits nothing, and a new Send unsettles the chat.
- `findChatFiles` lists the chat's working folder on the host with ripgrep (`ripgrepExecutable`, else `rg` on PATH) or, without it, `git ls-files`, honouring ignore files and skipping dependencies. A new chat may search only the remote host's fixed folder, or a local folder `approveFolder` accepts. Mentions reach the agent as the `@path` text; the agent reads the files itself.
- Stop targets only the captured submission/task. Cancelling or disconnecting a client never stops remote work.
- Remote hosts stream snapshots over an authenticated `chat-stream-v1` channel; messages are HMAC-authenticated, and OpenSSH provides transport encryption.
- `./claude-code` runs the local `claude` CLI, which owns sign-in; Moonbase stores no Claude credentials, and Pi still executes every tool. The library ships TypeScript source, so only bundles (the desktop app and `dist/host.mjs`) can load it, and they ship its `inert-mcp.mjs` beside them. It uses the built-in model list, not Claude Code's account catalog. Hosts close its warm workers with `closeClaudeCodeProcesses()`.
- `claude` is looked up on `PATH`, then in its install locations, and runs with its own directory and those locations on `PATH`, so an npm install's `env node` starts from Finder or a non-login shell. A status check that fails outright reaches provider setup as the provider's `problem` rather than reading as signed out.
- Claude Code runs in, and tells the model, its process's working directory: the library has no per-request cwd. The host changes to its configured `cwd` at startup; local chats, which each have their own folder, state it in a `working-directory` prompt section instead. The library also fixes its tool-inventory helper's env, so Electron's `ELECTRON_RUN_AS_NODE` reaches the helper only because Claude Code passes its own env to MCP servers.
- A dropped or stalled stream reconnects up to three times per outage; an authenticated frame arriving at least half a heartbeat interval after a connection's snapshot renews that budget.

## Checks

```sh
bun run --cwd packages/pi-runtime typecheck
bun run --cwd packages/pi-runtime lint
bun run --cwd packages/pi-runtime test
bun run test:chat-integration
```

Tests use controlled providers and temporary SQLite stores, never real provider quota or SSH hosts.
