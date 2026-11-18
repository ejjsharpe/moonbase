# Daemon

`@moonbase/daemon` is the process root that runs chats and the workspace (files, Git, worktrees, search and watching) on Bun 1.4.4. It owns one data directory and serves both over the authenticated sockets of [`@moonbase/daemon-protocol/server`](../../packages/daemon-protocol/README.md): chat, folders and provider setup at `/v3/rpc`, the file host at `/v3/workspace`, signed health at `/v1/health`. It has no exports. The desktop app ships it and starts one per user-data profile on `<user data>/daemon-v1` (see the [desktop README](../desktop/README.md#local-chat)).

```sh
bun run --cwd apps/daemon dev /absolute/private/data-directory
```

The data directory is its only argument; everything else is read from files inside it, never from the environment, so launchd can start it unchanged. The directory must be 0700, owned by you and not a symlink; files are 0600 and opened without following links. Anything else, or a malformed file, is refused with a message that names no path or contents.

| Entry | Purpose |
| --- | --- |
| `identity.json` | Random host, store and actor IDs, created once |
| `token` | 32 random bytes, base64url: a client's whole authority |
| `daemon.json` | Optional settings (below); absent means local mode |
| `daemon.lock` | One daemon per directory |
| `endpoint.json` | `{port, pid, version, protocol, build}` while listening; `build` is the bundle's SHA-256, or `development` |
| `chat.sqlite` | Pi Durable store |
| `credentials/`, `chats/` | Encrypted provider credentials; folders of chats without a project |
| `workspace/` | The file host's store: approvals and the save and operation journals |
| `approved-folders.json` | Local mode: folders a client approved (`src/folder-approvals.ts`) |
| `logs/` | `daemon.log`, rotated at 1 MiB to `daemon.1.log`…`daemon.3.log` |

`daemon.json`, decoded strictly by `src/daemon-settings.ts`:

```json
{ "mode": "local", "credentialKey": { "source": "keychain" } }
{ "mode": "local", "credentialKey": { "source": "file", "path": "/absolute/private/key" } }
{ "mode": "host", "port": 8787, "approvedRoots": ["/Users/me/Projects"], "credentialKey": { "source": "file", "path": "/Users/me/MoonbaseHost/credential.key" } }
```

Both modes serve the same chat runtime, provider setup and folders to any token holder. The daemon reads no provider keys from its environment and never opens a browser: sign-in links go back to the client. Claude Code uses the `claude` CLI (`PI_CLAUDE_CODE_COMMAND`, else PATH), signed in with `claude auth login` on the daemon's machine.

- **Local mode** listens on an ephemeral 127.0.0.1 port, keeps its credential key in the Keychain (default) or a private key file, and lets a chat use a folder in `approved-folders.json` or the root of an approved checkout. It exits after 5 minutes with no client request, watch or workspace connection and no active work.
- **Host mode** listens on its configured 127.0.0.1 `port` (0 for any free one) for clients over the [SSH forward](../../packages/ssh/README.md), never idles out, and always uses its key file (the login keychain is usually locked without a GUI session). A chat may use one of `approvedRoots` or a folder under one: 1–64 absolute roots, each named by its real path, none inside another, and none holding or inside the data directory or key file. A chat worktree is made in `<repository>-worktrees` beside its repository, so the repository must sit inside a root, not be one. A path through a link is refused, and each root is re-checked on use, so one replaced since startup approves nothing. Host mode adds `roots-v1` (`listHostFolders`) since clients have no picker for its disk.

## Workspace file host

- On macOS with the native helper (`workspace/filesystem` beside the bundle's `daemon/` folder, or `packages/workspace/dist/filesystem` from source), the daemon composes `WorkspaceHostLive` from [`@moonbase/workspace`](../../packages/workspace/README.md) with system Git (`/usr/bin/git`) and the same ripgrep as chat search. Without the helper, off macOS, or if it fails to compose, it serves chats only.
- In both modes a root may not hold or sit inside `token`, `credentials/`, `workspace/` or the credential key file. Local mode refuses roots inside the data directory except under `chats/`; host mode opens only real paths under `approvedRoots`.
- `captureImports` and `turnChatIntoProject` are local mode only. A captured source is held to no root policy, so the caller must pass only native-picker or drop paths.
- Shutdown stops admitting, closes the workspace (at most 5 seconds), then the server, which waits for running file host mutations (at most 5 seconds), then the runtime, and exits even if a helper never did.

## Process

- One Effect program on `BunRuntime.runMain` (`src/daemon-process.ts`). `SIGTERM` or `SIGINT` interrupts it and its scope closes everything in reverse; interrupted runs resume on the next start through Pi Durable.
- `Config` (`src/daemon-config.ts`) comes from arguments only, with defaults for the `idle`, `poll`, `workspaceClose` and `serverClose` waits. `daemon.json` and the other data files are private files, not `Config`.
- Requests, watches and workspace connections are held in scopes against one `SubscriptionRef` (`src/daemon-stop.ts`) that refuses new ones once stopping; the idle wait is a `Clock` fiber (`src/idle.ts`).
- Start prints one `{"event":"ready",…}` line on stdout; a failure prints one `{"event":"failed","error":…,"message":…}` line on stderr and exits 1.
- The journal (`src/journal.ts`) records only lifecycle events and failure tags: never tokens, credentials, paths, request bodies or chat text.

## Remote host

A remote host, such as a Mac mini reached only over SSH, runs the daemon in host mode under launchd. On the host:

1. Install Moonbase, or copy the Bun 1.4.4 runtime with `dist/daemon/daemon.mjs` and `inert-mcp.mjs` from `bun run --cwd apps/daemon build`, plus `filesystem` from `bun run --cwd packages/workspace build` as `workspace/filesystem` beside the `daemon/` folder (optionally ripgrep as `workspace/ripgrep/rg`). Sign in to Claude Code with `claude auth login` if you use it.
2. Make a private data directory (`mkdir -m 700 -p ~/MoonbaseHost/data`) and write its host-mode `daemon.json` (0600). Make the key file with `(umask 077; openssl rand -base64 32 > credential.key)`, or let the first sign-in create it.
3. Save this LaunchAgent as `~/Library/LaunchAgents/app.moonbase.host.plist`, with your own paths:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>app.moonbase.host</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Applications/Moonbase.app/Contents/Helpers/bun</string>
    <string>--no-env-file</string>
    <string>--config=/dev/null</string>
    <string>--no-install</string>
    <string>/Applications/Moonbase.app/Contents/Resources/daemon/daemon.mjs</string>
    <string>/Users/me/MoonbaseHost/data</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/me/MoonbaseHost/data</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/Users/me/.local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>WS_NO_BUFFER_UTIL</key><string>1</string>
    <key>WS_NO_UTF_8_VALIDATE</key><string>1</string>
  </dict>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>/Users/me/MoonbaseHost/data/launchd.log</string>
  <key>StandardErrorPath</key><string>/Users/me/MoonbaseHost/data/launchd.log</string>
</dict>
</plist>
```

4. Load it with `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/app.moonbase.host.plist` at the Mac, or with `user/$(id -u)` from an SSH session. `launchctl bootout` with the same domain sends `SIGTERM`, which stops it cleanly.

On the client, the [desktop app's remote configuration](../desktop/README.md#remote-chat) names an SSH alias for the host, its `port`, the `host` and `actorId` from `identity.json`, and its `token`. Copy the token through a pipe or an editor, never in a command's arguments. Host-key checking stays on.

## Build and package

```sh
bun run --cwd apps/daemon build   # dist/daemon/daemon.mjs and inert-mcp.mjs
```

The daemon ships as the Bun 1.4.4 runtime plus an esbuild bundle, run as `bun daemon.mjs <data directory>`. The desktop package puts the runtime at `Moonbase.app/Contents/Helpers/bun`, the bundle in `Contents/Resources/daemon/` and the native helper and ripgrep in `Contents/Resources/workspace/`, which only the daemon reads.

- It is not a `bun build --compile` executable: Claude Code starts its `inert-mcp.mjs` helper with `process.execPath`, which inside a compiled executable is in Bun's virtual `/$bunfs` and can't be loaded.
- `scripts/prepare-bun.mjs` downloads the release and the licence notices of Bun and the packages its lockfiles pin, and refuses any archive, executable or notice whose SHA-256 differs from the pinned one: the archive and executable pins are in `scripts/prepare-bun.mjs`, the licence files' in `scripts/bun-packages.json` (regenerated by `scripts/bun-packages.mjs`). Packaging and `check:package` check them again.
- Bun always runs with `--no-env-file --config=/dev/null --no-install` from inside the data directory, so it loads no `.env` or `bunfig.toml` and never auto-installs a package. Desktop's `findDaemonCommand` also drops `NODE_OPTIONS`, `NODE_PATH` and every `BUN_*` variable from the environment and sets `WS_NO_BUFFER_UTIL=1` and `WS_NO_UTF_8_VALIDATE=1`.
- Known issue: Claude Code starts its helper as plain `bun` in the chat's project folder, so that helper still reads the folder's `.env` and `bunfig.toml`.

## Checks

```sh
bun run --cwd apps/daemon typecheck
bun run --cwd apps/daemon lint
bun run --cwd apps/daemon test
```

Tests use temporary data directories, in both modes. `test:linux` leaves out `test/macos/`, which needs the built native helper and which `test:macos` runs. `test/faux-daemon.ts` is the test entry: the real daemon with faux providers scripted by `faux.json` in the data directory and an in-memory credential key (or the key file `daemon.json` names), so no test reaches a provider or the Keychain. The desktop's native tests run it too.
