# SSH

`@moonbase/ssh` exports `SshLive(config)`, a scoped `ConnectionService` that forwards a local loopback port to a remote chat host over OpenSSH. `@moonbase/ssh/configuration` exports the configuration schema and decoder; `@moonbase/ssh/host-health` is the shared authenticated health check used by SSH and Pi: HMAC-SHA256 proofs under `moonbase-daemon-health-v1` in both directions, over the host's identity, protocol version, version and capabilities.

## Configuration

Supply `profile: {id, label, destination, remotePort, expected: {hostId, storeId}}`, a private `token` and an optional absolute `sshExecutable` (default `/usr/bin/ssh`). For a [host-mode daemon](../../apps/daemon/README.md#remote-host), `remotePort` is its `port`, `expected` the `host` in its `identity.json` and `token` the contents of its `token` file, copied through a pipe or an editor, never in a command's arguments (the [desktop README](../../apps/desktop/README.md#remote-chat) shows one way). The destination is an SSH alias, host, bracketed IPv6 address or `user@host`. Keep the configuration outside source control with private permissions.

Ports, proxies, keys and known hosts belong in your OpenSSH configuration. The profile must keep host-key checking on and must not add forwards or authentication bypasses; incompatible policy is rejected, not rewritten. Authentication uses your existing SSH config, agent and keys, and local commands, agent forwarding and X11 forwarding are disabled.

Each connection runs one foreground OpenSSH child forwarding `127.0.0.1:ephemeral → remote 127.0.0.1:remotePort`. It reports connected only after authenticated health succeeds for the exact host and store. Disconnect never stops remote work. Only privileged code may read `ConnectionService.endpoint`; keep its origin and key out of renderers, arguments and logs.

```sh
node --experimental-strip-types packages/ssh/examples/connect.ts /absolute/private-connection.json
```

## Checks

```sh
bun run --cwd packages/ssh typecheck
bun run --cwd packages/ssh lint
bun run --cwd packages/ssh test
bun run test:chat-integration
```

Tests use controlled child processes and TCP, never a real SSH host. Use only a host the user has named for manual checks.
