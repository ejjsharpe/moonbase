# Daemon

`@moonbase/daemon` is the process root that runs chats on Bun 1.4.4. It owns one data directory and serves a Pi runtime over the authenticated HTTP host protocol of [`@moonbase/pi-runtime/server`](../../packages/pi-runtime/README.md). It has no exports, and the app does not use it yet.

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

- **Local mode** listens on an ephemeral 127.0.0.1 port. It runs the local Pi runtime with the local provider catalog and the Claude Code subscription; credentials are encrypted under a key in the Keychain (the default) or a private key file, which is checked at startup and created at the first sign-in. A chat may use only a folder in `approved-folders.json`. The daemon never opens a browser.
- **Host mode** is the fixed-settings runtime of the standalone host (`host.ts`) on the configured port, with host-side provider keys. Until remote hosts move to the daemon (DM-07), host mode still reads those keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) and `PI_CLAUDE_CODE_COMMAND` from its environment, as `host.ts` does; local mode reads none.

On start it prints one JSON `ready` line on stdout (`{"event":"ready","host":…,"port":…}`); failures print one `failed` line on stderr and exit 1, including "already running" when another daemon holds the lock. `SIGTERM` or `SIGINT` stops admitting (new requests and runs are refused at once), closes the server and runtime, closes Claude Code's workers, removes `endpoint.json` and exits 0; interrupted runs resume on the next start through Pi Durable. A local daemon also exits by itself after 5 minutes with no authenticated client request in flight, no open watch and no active work; host mode never idles out. Logs record only lifecycle events and failure codes: no token, credentials, request bodies or chat text.

## Checks

```sh
bun run --cwd apps/daemon typecheck
bun run --cwd apps/daemon lint
bun run --cwd apps/daemon test
```

Tests run under `bun test` with temporary data directories. `test/faux-daemon.ts` is the test entry: the real daemon with faux providers, scripted by `faux.json` in the data directory, and an in-memory credential key, so no test reaches a provider or the Keychain.
