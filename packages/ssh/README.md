# SSH

`@moonbase/ssh` forwards a local loopback port to a remote chat host over OpenSSH and reports it as a `ConnectionService`. It holds no protocol code: the consumer injects `verify`, the daemon protocol's signed health check (`checkHostHealth` from `@moonbase/daemon-protocol/health`), which it runs on the forwarded port.

| Export | What it gives |
| --- | --- |
| `.` | `SshLive(config, { verify, startupMs?, stopTiming? })`, a scoped `ConnectionService` layer; it fails with `ConnectionError`, `HostVerificationError` and `CancelledError` |
| `./configuration` | `SshConfigurationSchema` and `decodeSshConfiguration`, which fails with `SshConfigurationError`; the consumer decodes where it reads the configuration, and `SshLive` trusts what it is given |

## Configuration

Supply `profile: {id, label, destination, remotePort, expected: {hostId, storeId}}`, a private `token` and an optional absolute `sshExecutable` (default `/usr/bin/ssh`). For a [host-mode daemon](../../apps/daemon/README.md#remote-host), `remotePort` is its `port`, `expected` the `host` in its `identity.json` and `token` the contents of its `token` file, copied through a pipe or an editor, never in a command's arguments. Ports, proxies, keys and known hosts belong in your OpenSSH configuration.

## Rules worth knowing

- **Host-key checking stays on.** The effective configuration (`ssh -G`) must not turn it off, add forwards or bypass host authentication; incompatible policy is rejected, not rewritten. Local commands, agent and X11 forwarding are disabled.
- **The token stays in this process.** OpenSSH gets it neither in its arguments nor in its environment, and it proves itself to the host only through HMACs (health, then the WebSocket upgrade), never sent itself. Only privileged code may read `ConnectionService.endpoint`.
- **Connected means verified.** Each connection runs one foreground OpenSSH child forwarding `127.0.0.1:<ephemeral>` to the remote `127.0.0.1:<remotePort>`, and reports connected only after `verify` succeeds for the exact host and store within `startupMs` (20 s), retrying while health is `unreachable` or `read-failed`.
- **Stopping** a connection's process group takes at most 2.5 s (`deadlineMs`), with 500 ms (`termGraceMs`) between SIGTERM and SIGKILL. It runs on the system clock, since it waits on real processes; the startup deadline uses the caller's. A failed stop (`teardown`) refuses Connect until a later stop succeeds. Disconnect never stops remote work.
- **`process.ts` wraps `node:child_process` once** rather than using `effect/process`, because the group stop must keep signalling through EPERM until its deadline, and `effect/process`'s release would signal the group again after it was confirmed gone.

## Checks

```sh
bun run --cwd packages/ssh typecheck
bun run --cwd packages/ssh lint
bun run --cwd packages/ssh test
bun run --cwd test/chat test
```

Tests run under `node --test` with controlled child processes and TCP, never a real SSH host. The policy tests read the real `ssh -G`; the case only macOS's OpenSSH understands is in `test/macos/`.
