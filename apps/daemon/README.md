# Daemon

`@moonbase/daemon` is the process root that runs chats on Bun 1.4.4. It owns one data directory and serves a Pi runtime over the authenticated HTTP host protocol of [`@moonbase/pi-runtime/server`](../../packages/pi-runtime/README.md). It has no exports. The desktop app ships it (below) but does not start it yet.

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
| `endpoint.json` | `{port, pid, version, protocol}`, written once listening, removed on a clean exit and, if a crash left one, once the lock is taken |
| `chat.sqlite` | Pi Durable store |
| `credentials/`, `approved-folders.json`, `chats/` | Local mode: encrypted provider credentials, approved folders, folders of chats without a project |
| `logs/` | `daemon.log`, rotated at 1 MiB to `daemon.1.log`…`daemon.3.log` |

`daemon.json`, decoded strictly:

```json
{ "mode": "local", "credentialKey": { "source": "keychain" } }
{ "mode": "local", "credentialKey": { "source": "file", "path": "/absolute/private/key" } }
{ "mode": "host", "cwd": "/absolute/folder", "model": { "provider": "openai", "modelId": "gpt-6-sol" }, "port": 8787 }
```

- **Local mode** listens on an ephemeral 127.0.0.1 port. It runs the local Pi runtime with the local provider catalog and the Claude Code subscription; credentials are encrypted under a key in the Keychain (the default) or a private key file, which is checked at startup and created at the first sign-in. A chat may use only a folder in `approved-folders.json`. Besides chat it serves provider setup, folder approvals and control over the same protocol, and advertises them in signed health (`daemon-local-v1`, `providers-v1`, `folders-v1`), so a token holder can drive it completely: through `LoopbackConnectionLive` with `RemoteChatLive`, `RemoteLocalHostLive` and `RemoteProviderSetupLive` from [pi-runtime](../../packages/pi-runtime/README.md). Admissions and Quit are its own concern, not a client's. The daemon never opens a browser: sign-in links go back to the client, and ChatGPT's loopback callback runs in the daemon.
- **Host mode** advertises only `chat-v0`. It is the fixed-settings runtime of the standalone host (`host.ts`) on the configured port, with host-side provider keys. Until remote hosts move to the daemon (DM-07), host mode still reads those keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) and `PI_CLAUDE_CODE_COMMAND` from its environment, as `host.ts` does. Local mode reads no provider keys; like any Claude Code client it takes the Claude CLI from `PI_CLAUDE_CODE_COMMAND` when set, otherwise from PATH and the usual install locations.

On start it prints one JSON `ready` line on stdout (`{"event":"ready","host":…,"port":…}`); failures print one `failed` line on stderr and exit 1, including "already running" when another daemon holds the lock. `SIGTERM` or `SIGINT` stops admitting (new requests and runs are refused at once), closes the server and runtime, closes Claude Code's workers, removes `endpoint.json` and exits 0; interrupted runs resume on the next start through Pi Durable. A local daemon also exits by itself after 5 minutes with no authenticated client request in flight, no open watch and no active work; host mode never idles out. Logs record only lifecycle events and failure codes: no token, credentials, request bodies or chat text.

## Build and package

```sh
bun run --cwd apps/daemon build   # dist/daemon/daemon.mjs and inert-mcp.mjs
```

The daemon ships as the Bun 1.4.4 runtime plus an esbuild bundle `daemon.mjs`, with Claude Code's tool-inventory helper `inert-mcp.mjs` beside it, run as `bun daemon.mjs <data directory>`. It is not a `bun build --compile` executable: Claude Code resolves its helper beside the bundle and starts it with `process.execPath` and `BUN_BE_BUN=1`, and inside a compiled executable that path is in Bun's virtual `/$bunfs`, which the helper process can't load.

The desktop package puts the runtime at `Moonbase.app/Contents/Helpers/bun` and the bundle and helper in `Contents/Resources/daemon/`, outside the asar. `scripts/prepare-bun.mjs` downloads `bun-darwin-aarch64.zip` from Bun's GitHub release into a fresh cache, with licence texts: Bun's, WebKit's and those of the libraries Bun's licence names that the `bun-v1.4.4` tag pins, each from the pinned commit, and those of every crate in Bun's `Cargo.lock` and every npm package in the lockfile of its embedded Node.js polyfills. `scripts/bun-packages.mjs` takes each package's licence files (or README, if it has none) from its crates.io or npm archive, checked against the lockfile's checksum, and `scripts/bun-packages.json` pins their SHA-256 (run the script to regenerate it). Code Bun ports from other projects (esbuild, typescript-go, ESLint, Prettier, oxc and the rest its licence lists) and the polyfills it vendors outside that lockfile have no revision in the tag, so only Bun's licence names them. It refuses the archive, the executable inside it, a lockfile, a package archive or any notice whose SHA-256 differs from the pinned one, before unpacking it or running Bun; packaging and `check:package` check the executable and notices again. The packaged daemon searches chat files with the app's own ripgrep, `workspace/ripgrep/rg` beside its `daemon/` folder; run from source or on a host without it, it uses `rg` on PATH, then Git. In development the app would run `bun src/main.ts` from the `bun` on PATH, with no packaging step. Either way it runs `bun --no-env-file --config=/dev/null` from inside the data directory, so Bun loads no `.env` or `bunfig.toml` (whose `preload` runs code) from the folder the app was launched from. Claude Code starts its helper as plain `bun inert-mcp.mjs` from its own working folder, which Moonbase doesn't control, so that helper still reads that folder's `.env` and `bunfig.toml` (for DM-06/DM-07).

The release runtime is signed by Oven. Signing Moonbase (not done yet) means re-signing it with Bun's JIT entitlements under the hardened runtime: `com.apple.security.cs.allow-jit`, `allow-unsigned-executable-memory`, `disable-executable-page-protection`, `allow-dyld-environment-variables` and `disable-library-validation` (Bun's own `entitlements.plist`).

## Checks

```sh
bun run --cwd apps/daemon typecheck
bun run --cwd apps/daemon lint
bun run --cwd apps/daemon test
```

Tests run under `bun test` with temporary data directories. `test/faux-daemon.ts` is the test entry: the real daemon with faux providers (including faux sign-ins for every provider setup offers), scripted by `faux.json` in the data directory, and an in-memory credential key, so no test reaches a provider, the sign-in callback port or the Keychain.
