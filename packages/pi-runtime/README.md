# Pi runtime

`@moonbase/pi-runtime` implements the contracts `ChatService` on Pi Durable, which owns execution, transcripts and tasks. Layers create no runtime; process roots compose them.

| Export | Role |
| --- | --- |
| `.` | Remote fixed-settings `PiRuntimeLive(config)`, per-conversation `LocalPiRuntimeLive(config)`, privileged `LocalPiControl`, and `LocalHostLive(config)`: the contracts `LocalHostService` (folder approvals, chat folder checks, active work, mark as project) over `LocalPiControl` |
| `./local-models`, `./providers`, `./credentials` | Local provider catalog, provider sign-in and injected encrypted credential storage |
| `./claude-code` | Claude Pro/Max subscription through the user's Claude Code login ([pi-claude-code](https://github.com/earendil-works/pi-claude-code)) |
| `./folders` | `createFolderApprovals(file)`: approved working folders, re-checked by identity on use; `checkChatFolder(chatFolders, path)` |
| `./host-configuration` | `decodeDaemonSettings` for the daemon's `daemon.json`, and `prepareFixedSettingsHost` for a fixed-settings host's providers and tools |
| `./server` | `serveChat(config, client, daemon?)`: authenticated loopback listener for a remote host or the daemon; `makeDaemonClient(runtime)` binds a local daemon's folder, control and provider setup services |
| `./remote` | `RemoteChatLive`, `RemoteLocalHostLive` and `RemoteProviderSetupLive({host, openUrl, sameMachine})`: client-side services over an injected `ConnectionService` |
| `./loopback` | `LoopbackConnectionLive({directory})`: privileged `ConnectionService` for a daemon on this machine |

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

- Both modes run on Node 26.13 or newer or exactly Bun 1.4.4; the local runtime also runs on the qualified Electron (45.1.0, Node 24.22.1). Anything else is refused as `Incompatible` before the store opens. Bun and Electron are qualified exactly, so upgrading either is a deliberate change. SQLite goes through chord's `node:sqlite` adapter on every runtime.
- Mutations carry request IDs bound to their full input. A lost or unproved reply is `Uncertain`; callers retry with the original request rather than resending, and reconnects never resend.
- `listChats` gives each chat's `activity`: `running` while a submission owns it, else how its latest generation ended (`idle`, `stopped`, `failed`), with when it started or ended (or the chat's creation time if it never ran).
- A local `createChat` without `cwd` is a chat without a project: after `approveCreation` accepts it, the runtime makes it a new, empty, private folder under `chatFolders`, named for the day, the title's first words and a short id (`2026-11-08-tidy-the-composer-a1b2c3d4`), and lists it with `ownFolder: true`. It is refused when `chatFolders` is unset or sits inside a Git checkout, where the agent's Git commands would act on that repository. The runtime never deletes a chat's folder, so the agent's files stay until you remove them; it removes only an empty one it made for a request that made no chat. `LocalPiControl.markFolderAsProject` clears `ownFolder` once the host has opened that folder as a project.
- `settleChat` stores when a chat was settled in its metadata (`settledAt` in listings and snapshots) or clears it; repeating the current state commits nothing, and a new Send unsettles the chat.
- `findChatFiles` lists the chat's working folder on the host with ripgrep (`ripgrepExecutable`, else `rg` on PATH) or, without it, `git ls-files`, honouring ignore files and skipping dependencies. A listing runs in its own process group with a 10 s budget. Its budget or closing the runtime stops it: the whole group gets SIGTERM, then SIGKILL 2 s later, and the search or close waits for it to exit. Cancelling a search leaves the listing running, since other searches of that folder share it. A new chat may search only the remote host's fixed folder, or a local folder `approveFolder` accepts. Mentions reach the agent as the `@path` text; the agent reads the files itself.
- Stop targets only the captured submission/task. Cancelling or disconnecting a client never stops remote work.
- Remote hosts stream snapshots over an authenticated channel; messages are HMAC-authenticated, and OpenSSH provides transport encryption.
- The protocol is version 2: requests, replies and stream frames are HMAC-SHA256 under the domains `moonbase-daemon-v1` and `moonbase-daemon-stream-v1`, and health under `moonbase-daemon-health-v1`. Protocol 1 hosts and clients are refused.
- Signed health lists capabilities. Every host has `chat-v0`. A server given `daemon` operations (a local-mode daemon) adds `daemon-local-v1` (local-mode chats, `getActiveWork`, `markFolderAsProject`), `providers-v1` (provider setup) and `folders-v1` (`approveFolder`, `listRecentFolders`, `checkChatFolder`). The client checks the capability in each challenge's signed health before sending, so nothing reaches a host that doesn't advertise what it needs: from such a host, `createChat` with `settings`, a `mode: 'local'` `getChatHost` reply and every daemon operation are `Incompatible`.
- Daemon operations are strictly decoded on both sides and listed in explicit handler maps; their inputs name the host, which the server checks. Provider setup is scoped to an owner the client names (Electron uses its document id), so one owner never sees or answers another's flow; `releaseProviderOwner` ends an owner. The mutations (`approveFolder`, `markFolderAsProject`, provider login, answer, cancel and logout) carry request IDs echoed in their replies: a lost or unproved reply is `Uncertain` and is never resent, and the server returns a recent request's outcome again rather than rerunning it. Provider setup state is polled.
- `openProviderUrl` over the protocol returns the sign-in URL, checked against the providers' sign-in origins (`https://auth.openai.com`) by the daemon and again by the client, which opens it through its own `openUrl`; the daemon never opens a browser. `ProviderSetupLive` without `openUrl` (the daemon's) refuses `openProviderUrl`, and `ProviderSetupService.getProviderUrl` reads the link instead. ChatGPT's loopback callback (`127.0.0.1:1455`) runs in the daemon, so it finishes sign-in when the browser is on the daemon's machine; otherwise the user pastes the final redirect URL. `RemoteProviderSetupLive`'s `sameMachine` says which applies, and the pasted-code prompt says so.
- `LoopbackConnectionLive` takes the expected host and store from the daemon's `identity.json` when it is built, and on each connect reads `identity.json`, `endpoint.json` and `token` again (private files in a private directory, never followed through links) and verifies signed health for that host and store. A connect that finds the same daemon keeps its generation; a restarted or replaced one starts a new generation, and requests bound to the old one fail. It is privileged: its endpoint holds the token, so it never reaches a renderer.
- A snapshot's running response carries its text parts whole (`truncated: false`) while its parts' text fits `chatLiveTextBytes` (64 KiB) in all, so the reply renders as it streams without content reads; past that, a part keeps its preview and is read. Stored entries' parts always carry previews. The history page in the snapshot gives way to the live text, oldest entries first, to stay within a frame.
- `./credentials` stores one encrypted file per provider through injected encryption: Electron's `safeStorage` today, or `createKeyEncryption(source)`, AES-256-GCM with a random nonce per write and the provider id authenticated, under a 256-bit key from one source. `createKeychainKeySource` keeps the key in a generic-password item (service `Moonbase daemon credentials`, account the `storeId`), written and read by `/usr/bin/security -i` with commands on stdin, never in arguments; it takes an explicit keychain file for tests. Like a 0600 key file, the item is readable by any process running as the same user, through `/usr/bin/security`. `createKeyFileSource` uses an explicit absolute key file for headless and remote hosts: base64 of 32 bytes (`openssl rand -base64 32`), a 0600 regular file owned by the user, not a symlink, in a folder no one else can write to. `createMemoryKeySource` is for tests. The first write creates the key, and concurrent reads and writes share one load or create, so a locked keychain prompts once; a locked keychain (`security` exit 36), a failing `security` or an unusable key file is `Unavailable`, and no other source is tried. A credential that can't be opened under the current key, such as after the key was removed, fails to read; signing in again replaces it and signing out removes it, while a locked keychain or a failed file check leaves it untouched. `MOONBASE_TEST_KEYCHAIN=1` enables the test that creates and deletes a temporary macOS keychain; CI sets it on its ephemeral macOS runner.
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

`test` runs the suite under `node --test` (`test:node`) and then under `bun test` (`test:bun`). The Electron cases run in the pinned Electron under either. Host-process tests run the bundled host on the suite's runtime, and its store ownership and SIGKILL recovery on both Node and Bun. Tests use controlled providers and temporary SQLite stores, never real provider quota or SSH hosts.
