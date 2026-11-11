# Daemon

`@moonbase/daemon` is the process root that runs chats on Bun 1.4.4. It owns one data directory and serves a Pi runtime over the authenticated HTTP host protocol of [`@moonbase/pi-runtime/server`](../../packages/pi-runtime/README.md). It has no exports. The desktop app ships it (below) and starts it for each user-data profile, on `<user data>/daemon-v1` (see the [desktop README](../desktop/README.md#local-chat)).

```sh
bun run --cwd apps/daemon dev /absolute/private/data-directory
```

The data directory is its only argument (a second one is refused); everything else is read from files inside it, never from the environment or other arguments, so launchd can start it unchanged. It creates the directory if needed (its parent must exist). The directory must be 0700, owned by you and not a symlink; files are 0600, opened without following links and checked once open. Anything else, or a malformed file, is refused with a message that names no path or contents.

| Entry | Purpose |
| --- | --- |
| `identity.json` | Random host, store and actor IDs, created once |
| `token` | 32 random bytes, base64url: a client's whole authority |
| `daemon.json` | Optional settings (below); absent means local mode |
| `daemon.lock` | One daemon per directory, taken before the store opens |
| `endpoint.json` | `{port, pid, version, protocol, build}` (`build`: the bundle's SHA-256, or `development` from source), written once listening, removed on a clean exit and, if a crash left one, once the lock is taken |
| `chat.sqlite` | Pi Durable store |
| `credentials/`, `chats/` | Encrypted provider credentials; folders of chats without a project |
| `approved-folders.json` | Local mode: folders a client approved |
| `logs/` | `daemon.log`, rotated at 1 MiB to `daemon.1.log`…`daemon.3.log` |

`daemon.json`, decoded strictly:

```json
{ "mode": "local", "credentialKey": { "source": "keychain" } }
{ "mode": "local", "credentialKey": { "source": "file", "path": "/absolute/private/key" } }
{ "mode": "host", "port": 8787, "approvedRoots": ["/Users/me/Projects"], "credentialKey": { "source": "file", "path": "/Users/me/MoonbaseHost/credential.key" } }
```

Both modes serve the same runtime: local-mode chats that each choose their folder, model and reasoning effort, provider setup with credentials encrypted under the daemon's key, the local provider catalog and the Claude Code subscription, settle, `@` search and transcripts. A token holder drives either completely over the same protocol, through `RemoteChatLive`, `RemoteLocalHostLive` and `RemoteProviderSetupLive` from [pi-runtime](../../packages/pi-runtime/README.md) on a loopback or SSH connection. Signed health advertises `daemon-local-v1`, `providers-v1` and `folders-v1` in both modes. The daemon never opens a browser: sign-in links go back to the client, and ChatGPT's loopback callback runs in the daemon. Chats without a project get a new folder in `chats/`. Admissions and Quit are the daemon's concern, not a client's. The daemon reads no provider keys from its environment; like any Claude Code client it takes the Claude CLI from `PI_CLAUDE_CODE_COMMAND` when set, otherwise from PATH and the usual install locations, and Claude Code signs in with `claude auth login` on the daemon's machine.

- **Local mode** listens on an ephemeral 127.0.0.1 port. Its credential key is in the Keychain (the default) or a private key file. A chat may use only a folder in `approved-folders.json`, which the client approves from its native picker or editor.
- **Host mode** listens on its configured 127.0.0.1 `port`, for clients on other machines over the [SSH forward](../../packages/ssh/README.md), and never idles out. Its credential key is always the key file it names (`openssl rand -base64 32`, or created at the first sign-in), since the login keychain is usually locked without a GUI session. A chat may use one of `approvedRoots` (1–64 absolute folders, each named by its real path, none inside another, and none holding or inside the data directory or the key file) or a folder under one, named by its real path: a path through a link is refused, so a link inside a root can't lead out of it. Each root is checked at startup (a missing one is refused) and must stay the directory it was, so a root replaced by another folder or a link approves nothing until the daemon restarts. A client has no picker for the host's disk, so host mode also advertises `roots-v1`, whose `listHostFolders` lists the roots and then the folders directly inside each (hidden ones and links left out, at most 256 in all); `approveFolder` checks a folder against the roots and stores nothing, recent folders are always empty, and `markFolderAsProject` is `Incompatible`.

On start it prints one JSON `ready` line on stdout (`{"event":"ready","host":…,"port":…}`); failures print one `failed` line on stderr and exit 1, including "already running" when another daemon holds the lock. `SIGTERM` or `SIGINT` stops admitting (new requests and runs are refused at once), closes the server and runtime, closes Claude Code's workers, removes `endpoint.json` and exits 0; interrupted runs resume on the next start through Pi Durable. A local daemon also exits by itself after 5 minutes with no authenticated client request in flight, no open watch and no active work; a host-mode daemon never idles out. Logs record only lifecycle events and failure codes: no token, credentials, request bodies or chat text.

## Remote host

A remote host, such as a Mac mini reached only over SSH, runs the daemon in host mode under launchd. On the host:

1. Install Moonbase (its bundled runtime and daemon need no code signing), or copy the Bun 1.4.4 runtime with `dist/daemon/daemon.mjs` and `inert-mcp.mjs` from `bun run --cwd apps/daemon build`. Sign in to Claude Code with `claude auth login` if you use it.
2. Make a private data directory (`mkdir -m 700 -p ~/MoonbaseHost/data`) and write its `daemon.json` (mode 0600) in host mode, as above. The daemon creates `identity.json` and `token` there when it first starts.
3. Save this LaunchAgent as `~/Library/LaunchAgents/app.moonbase.host.plist`, with your own paths. It runs the runtime as the app does, from inside the data directory, restarts it if it exits, and keeps launchd's own output private in the data directory beside the daemon's `logs/`:

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

4. Load it with `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/app.moonbase.host.plist` when you are logged in at the Mac, or from an SSH session with `user/$(id -u)` in place of `gui/$(id -u)`. `launchctl bootout` with the same domain sends `SIGTERM`, which stops it cleanly; interrupted runs resume when it starts again.

On the client, the [desktop app's remote configuration](../desktop/README.md#remote-chat) names an SSH alias for the host, the host's `port`, the `host` and `actorId` from its `identity.json`, and its `token`. The token is the host's whole authority: copy it into the configuration through a pipe or an editor, never in a command's arguments. Host-key checking stays on, as the [SSH package](../../packages/ssh/README.md) requires.

## Build and package

```sh
bun run --cwd apps/daemon build   # dist/daemon/daemon.mjs and inert-mcp.mjs
```

The daemon ships as the Bun 1.4.4 runtime plus an esbuild bundle `daemon.mjs`, with Claude Code's tool-inventory helper `inert-mcp.mjs` beside it, run as `bun daemon.mjs <data directory>`. It is not a `bun build --compile` executable: Claude Code resolves its helper beside the bundle and starts it with `process.execPath` and `BUN_BE_BUN=1`, and inside a compiled executable that path is in Bun's virtual `/$bunfs`, which the helper process can't load.

The desktop package puts the runtime at `Moonbase.app/Contents/Helpers/bun` and the bundle and helper in `Contents/Resources/daemon/`, outside the asar. `scripts/prepare-bun.mjs` downloads `bun-darwin-aarch64.zip` from Bun's GitHub release into a fresh cache, with licence texts: Bun's, WebKit's and those of the libraries Bun's licence names that the `bun-v1.4.4` tag pins, each from the pinned commit, and those of every crate in Bun's `Cargo.lock` and every npm package in the lockfile of its embedded Node.js polyfills. `scripts/bun-packages.mjs` takes each package's licence files (or README, if it has none) from its crates.io or npm archive, checked against the lockfile's checksum, and `scripts/bun-packages.json` pins their SHA-256 (run the script to regenerate it). Code Bun ports from other projects (esbuild, typescript-go, ESLint, Prettier, oxc and the rest its licence lists) and the polyfills it vendors outside that lockfile have no revision in the tag, so only Bun's licence names them. It refuses the archive, the executable inside it, a lockfile, a package archive or any notice whose SHA-256 differs from the pinned one, before unpacking it or running Bun; packaging and `check:package` check the executable and notices again. The packaged daemon searches chat files with the app's own ripgrep, `workspace/ripgrep/rg` beside its `daemon/` folder; run from source or on a host without it, it uses `rg` on PATH, then Git. In development the app runs `bun src/main.ts` from the `bun` on PATH, with no packaging step. Either way it runs `bun --no-env-file --config=/dev/null --no-install` from inside the data directory, so Bun loads no `.env` or `bunfig.toml` (whose `preload` runs code) from the folder the app was launched from, and never fetches and runs a package from the npm registry for an import the bundle can't resolve (the bundle has no `node_modules` above it, so Bun's auto-install would otherwise be on; the bundled `ws` asks for its optional `bufferutil`). Desktop's `findDaemonCommand` returns `command`, `args`, `cwd` and `env`, and callers spawn exactly those, with `env` as the whole environment: the caller's, without `NODE_OPTIONS` or any `BUN_*` variable (`BUN_OPTIONS` would add options such as `--preload`), plus `WS_NO_BUFFER_UTIL=1` and `WS_NO_UTF_8_VALIDATE=1`. Known issue: Claude Code starts its helper as plain `bun inert-mcp.mjs` with `BUN_BE_BUN=1` from the chat's project folder, which Moonbase doesn't control, so that helper still reads that folder's `.env` and `bunfig.toml`; the `claude` CLI is itself a Bun executable and may read `BUN_OPTIONS`, so it needs its own handling.

The release runtime is signed by Oven. Signing Moonbase (not done yet) means re-signing it with Bun's JIT entitlements under the hardened runtime: `com.apple.security.cs.allow-jit`, `allow-unsigned-executable-memory`, `disable-executable-page-protection`, `allow-dyld-environment-variables` and `disable-library-validation` (Bun's own `entitlements.plist`).

## Checks

```sh
bun run --cwd apps/daemon typecheck
bun run --cwd apps/daemon lint
bun run --cwd apps/daemon test
```

Tests run under `bun test` with temporary data directories, in both modes. `test/faux-daemon.ts` is the test entry: the real daemon with faux providers (including faux sign-ins for every provider setup offers), scripted by `faux.json` in the data directory, and an in-memory credential key (or the key file `daemon.json` names, so sign-ins survive a restart), so no test reaches a provider, the sign-in callback port or the Keychain. The desktop's native tests run this entry too.
