# SSH connection capability

`@moonbase/ssh` exports `SshLive(config)`, a scoped `ConnectionService` layer. It depends on application contracts and Effect, with no editor, Electron, Pi or workspace implementation. Compose it once in a privileged process root; `makeConnectionClient(runtime)` uses the shared handlers.

## Configuration and use

Supply one `profile: {id, label, destination, remotePort, expected: {hostId, storeId}}`, private `token` and optional absolute `sshExecutable` (default `/usr/bin/ssh`). Use a separately provisioned application key and keep configuration outside source control with private permissions. Browser commands cannot supply destinations, credentials or forwarded origins.

The destination accepts an SSH alias, host, bracketed IPv6 address or `user@host`. Ports, proxies, keys and known-host policy belong in operator-managed OpenSSH configuration. A dedicated profile must retain host-key checking, disable authentication bypasses and contain no additional forwards/device tunnel or clearing of the required forward. The checked preflight rejects incompatible policy rather than rewriting it. Existing ProxyJump/ProxyCommand and Match hooks remain operator authority.

The [standalone consumer](examples/connect.ts) connects, prints public status, disconnects and disposes its runtime:

```sh
node --experimental-strip-types packages/ssh/examples/connect.ts /absolute/private-connection.json
```

Separately start the [chat host](../pi-runtime/README.md) on the authorized machine with matching host/store/key and a loopback listener. SSH does not provision machines, start services, synchronize files or stop remote jobs.

## Lifecycle and authority

`getConnection` returns the configured profile and current state without connecting. Connect admits only that profile, with a fresh `connectionId` for each attempt. Concurrent Connect calls share one attempt/generation; status remains responsive during startup. Cancelling a waiter while connecting cancels that shared attempt. Disconnect names the exact generation, so stale callers cannot close a newer connection. Repeated Disconnect after release is harmless and never Stops remote work. Unsubscribe releases only its observation, without disconnecting or disposing the root. Cleanup failures stay visible and block a new generation until resolved.

Each generation owns a foreground, nonmultiplexed OpenSSH child and its POSIX process group. The only forward is `127.0.0.1:ephemeral → remote 127.0.0.1:remotePort`. Noninteractive authentication uses existing SSH config/agent/keys. Local commands, agent forwarding and X11 forwarding are disabled. Root disposal releases owned children/helpers, with bounded TERM/KILL cleanup and confirmed group absence; Windows is unsupported. The port reservation is released before SSH binds, so a collision fails the forward rather than providing an atomic handoff.

Connected status requires [authenticated health](../application/docs/HOST-PROTOCOL.md) for the exact host/store/version. Startup is bounded to 20 seconds. Only privileged services may resolve `ConnectionService.endpoint({host})`; lookup never connects or rebinds. Its origin/key must stay out of renderer bridges, arguments and logs. Public errors use bounded diagnostic categories rather than raw SSH output. Health authenticates application identity; OpenSSH supplies machine authentication and encryption. Health proofs do not authorize [chat RPC](../application/docs/CHAT.md#stateful-loopback-protocol), which requires separate authentication with no bearer fallback.

## Checks

```sh
bun run --cwd packages/ssh typecheck
bun run --cwd packages/ssh lint
bun run --cwd packages/ssh test
bun run test:chat-integration
```

Controlled child/TCP tests do not qualify a real SSH handshake, host-key setup, agent or proxy configuration. Use only an explicitly authorized host for manual checks.
