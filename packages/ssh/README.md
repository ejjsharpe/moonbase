# SSH

`@moonbase/ssh` exports `SshLive(config, { verify, startupMs })`, a scoped `ConnectionService` that forwards a local loopback port to a remote chat host over OpenSSH. It holds no protocol code: the consumer injects `verify`, the daemon protocol's signed health check (`checkHostHealth` from `@moonbase/daemon-protocol/health`), which it runs on the forwarded port. `@moonbase/ssh/configuration` exports the configuration schema and `decodeSshConfiguration`, which the consumer applies where it reads the configuration (`SshLive` trusts what it is given) and which fails with `SshConfigurationError`. The connection fails with the `ConnectionService` port's `ConnectionError` (with a `reason`), the health check's `HostVerificationError` and `CancelledError`; it builds no `ApplicationError`.

## Configuration

Supply `profile: {id, label, destination, remotePort, expected: {hostId, storeId}}`, a private `token` and an optional absolute `sshExecutable` (default `/usr/bin/ssh`). For a [host-mode daemon](../../apps/daemon/README.md#remote-host), `remotePort` is its `port`, `expected` the `host` in its `identity.json` and `token` the contents of its `token` file, copied through a pipe or an editor, never in a command's arguments (the [desktop README](../../apps/desktop/README.md#remote-chat) shows one way). The destination is an SSH alias, host, bracketed IPv6 address or `user@host`. Keep the configuration outside source control with private permissions.

Ports, proxies, keys and known hosts belong in your OpenSSH configuration. The profile must keep host-key checking on and must not add forwards or authentication bypasses; incompatible policy is rejected, not rewritten. Authentication uses your existing SSH config, agent and keys, and local commands, agent forwarding and X11 forwarding are disabled.

Each connection runs one foreground OpenSSH child forwarding `127.0.0.1:ephemeral → remote 127.0.0.1:remotePort`. It reports connected only after `verify` succeeds for the exact host and store (retrying while the host is `unreachable`), within `startupMs` (20 s unless a test shortens it). Stopping a connection's process group takes at most `stopTiming.deadlineMs` (2.5 s), with `termGraceMs` (500 ms) between SIGTERM and SIGKILL; tests shorten them. The stop waits on real processes, so it keeps the system clock even when the caller's is a `TestClock`; the startup deadline and the verification retries use the caller's. A stop that fails (`teardown`) keeps the generation, refusing Connect, until a later Disconnect or the layer's close stops it. Disconnect never stops remote work.

The connection's state is a `SubscriptionRef` (`watch` is its changes, at most 64 at once); each generation is a child Scope that owns its processes, and its attempt is a fiber in a `FiberMap` keyed by generation, so a release interrupts only its own. `process.ts` wraps `node:child_process` once instead of using `effect/process`: the group stop has to keep signalling through EPERM until its deadline, fail when the group's absence stays unconfirmed and end pipes a helper holds, and `effect/process`'s own release would signal the group ID again after it was confirmed gone.

The token stays in this process: OpenSSH gets neither it in its arguments nor any environment variable that contains it, and it proves itself to the host only through HMACs (health, then the daemon's WebSocket over the forward), never sending the token itself. Only privileged code may read `ConnectionService.endpoint`; keep its origin and key out of renderers, arguments and logs.

## Checks

```sh
bun run --cwd packages/ssh typecheck
bun run --cwd packages/ssh lint
bun run --cwd packages/ssh test
bun run test:chat-integration
```

Tests use controlled child processes and TCP, never a real SSH host. The policy tests read the real `ssh -G`; the `NoHostAuthenticationForProxyCommand` case is in `test/macos/` because only macOS's OpenSSH knows that option. Use only a host the user has named for manual checks.
