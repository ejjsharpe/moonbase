# Daemon protocol

`@moonbase/daemon-protocol` is the daemon's wire protocol: signed health, the two Effect RPC sockets, the daemon's listener and the client services over them. It holds no chat engine or file host; the daemon passes its chat, folder, provider setup and file host services to `serveChat`, and clients get the contracts services back. Folder approval policy belongs to the [daemon](../../apps/daemon/README.md).

`src/server/` is the listener and handlers, `src/client/` the links, remote services and connections, and `src/` what both use (signed health and the upgrade proof). Electron main bundles only `src/client/` and `src/`.

| Export | What it gives |
| --- | --- |
| `./server` | `serveChat(config, services, options?)`, the 127.0.0.1 listener; `localDaemonCapabilities` and `hostDaemonCapabilities` |
| `./remote` | `RemoteDaemonLive` (chat, folders and provider setup over one `DaemonRpcLink`), its parts, `RemoteWorkspaceHostLive` and `EndpointConnectionLive` |
| `./loopback` | `LoopbackConnectionLive({directory})`, a privileged `ConnectionService` for the daemon on this machine |
| `./health` | Signed health: `checkHostHealth`, `createHostHealthReply`, `validateHostHealth`, `requestUpgradeNonce` |

Remote hosts run the [daemon](../../apps/daemon/README.md#remote-host) in host mode, reached through [`@moonbase/ssh`](../ssh/README.md).

## Rules worth knowing

- **Two sockets, one listener (D10).** `/v3/rpc` serves chat, folders, control and provider setup; `/v3/workspace` serves the file host, so a large file never delays chat. Each has its own connections and limits. Signed health is at `/v1/health`.
- **Upgrades are authenticated before Bun accepts them (D13).** The client takes a single-use nonce from signed health and offers the socket's protocol (`moonbase.rpc.v3` or `moonbase.workspace.v3`) plus `moonbase.proof.<nonce>.<hmac>`: an HMAC under the token over the nonce, host and that protocol, so a proof opens only its own socket. No message is read before that. Every reconnect proves itself again.
- **Refusals:** wrong proof, wrong host binding or a replayed nonce 401; any `Origin` header 403; a `Host` other than `127.0.0.1:<port>`, another path, a query or a malformed handshake 400; past the socket's connection cap 503.
- **Signed health** is HMAC-SHA256 both ways (`moonbase-daemon-health-v1`) over the host's identity, protocol, version and capabilities. The client reads at most 8 KiB, follows no redirects and gives the check 5 s.
- **Capabilities.** Every host has `chat-v0` and `rpc-v1`; a daemon adds `daemon-local-v1`, `providers-v1` and `folders-v1`, host mode `roots-v1`, and one with a file host `workspace-v2`. The server serves only what it advertises, and the client checks the capability before sending (`IncompatibleHostError` `not-served`). The protocol is version 3.
- **Mutations are never resent.** A dropped or late mutation reply is `UncertainError`. Daemon mutations carry request IDs, and the server returns a recent request's outcome again instead of rerunning it. Workspace mutations (`isHostMutation`) are journalled by the host under their request ID: a repeat replays the first outcome, and one left uncertain is reported `InterruptedRequestError`, so the client inspects and mints a new ID.
- **Mutations run to completion** once admitted, even if their connection drops. Reads are interrupted when their caller cancels. A request past a connection's limits is refused `HostUnavailableError` (`busy`) before it runs, so a refused mutation was never applied.
- **Errors (D11, D14).** Each procedure declares its error union; a handler sends only errors that union names (tag and fields, never a cause) and anything else as `HostUnavailableError`. The client decodes only those, and `presentRemoteError` and `presentWorkspaceError` replace any text a host could fill with the client's own.
- **Host ownership.** Every request names its host, and each workspace input's checkout must be that host's (`UnauthorizedError`, checked by both sides).
- **Decode once, where a value arrives.** The server decodes requests, the client replies; the workspace client also checks its inputs before sending. Services on either side, and `serveChat`'s config, are trusted.
- **Loopback.** `LoopbackConnectionLive` reads `identity.json`, `endpoint.json` and `token` on each connect as private files in a private directory, never following links (`O_NOFOLLOW`, so Node `fs` rather than the Effect `FileSystem`). A restarted daemon starts a new generation; requests bound to the old one fail. Its endpoint holds the token, so it never reaches a renderer.
- **Clocks.** Deadlines, idle close and watch reconnect backoff (250, 500, 1000 ms) run on the Effect `Clock`.
- **Bun.** `serveChat` runs only under Bun (`Bun.serve`, so the upgrade can be checked before it is accepted); the client side also runs on Node and in Electron.
- **Known limit, accepted:** `Bun.serve` has no TCP connection cap or header deadline and restarts its idle timer on every byte, so a local process can hold many slow connections. Bun also applies one message bound to the whole listener, the workspace socket's, so it buffers an authenticated `/v3/rpc` message up to 16 MiB + 64 KiB before that socket's 256 KiB check closes it (1009). The request and socket caps still hold, and the listener binds only 127.0.0.1.

### Limits

From `rpcLimits` and `workspaceRpcLimits` in `@moonbase/contracts/rpc-upgrade`, and `hostDeadlinesMs` in `workspace-host-schema`.

| Bound | `/v3/rpc` | `/v3/workspace` |
| --- | --- | --- |
| Connections | 32 | 32 |
| Running requests per connection | 32 | 32, plus 2 for `saveStatus`/`operationStatus` |
| Watches per connection | 64 | 64 |
| Message the daemon accepts | 256 KiB | 16 MiB + 64 KiB (16 MiB of JSON) |
| Plain request input held per connection | none | 32 MiB |
| Queued replies before the daemon stops reading | 16 MiB | 64 MiB |
| Message the client accepts | 1 MiB | 16 MiB + 64 KiB |
| Client reply deadline | 20 s | reads 20 s, lookup and search 30 s, mutations 60 s, worktree and `git init` 120 s |
| Client drops a connection silent for | 5 s (Effect RPC's default) | 158 s (`workspacePingTimeoutMs`), so a 16 MiB reply at 128 KiB/s fits |

Shared: upgrade nonces live 30 s, at most 64 outstanding; a connection silent for 30 s is closed (clients ping every 5 s); the daemon writes one message at a time, waits while Bun buffers more than 1 MiB and cuts a client that drains none for 20 s; a client connects within 20 s. The HTTP side answers 128 requests at once (more get 503) and closes an idle connection after 10 s. `serveChat` waits `closeMs` (5 s) for running mutations when it closes.

`RemoteWorkspaceHostLive` keeps the daemon's places and 32 MiB input bound itself, so the daemon never refuses an honest client: a request waits up to its deadline for room (`busy`, unsent, past it). It refuses a request too large to send (`request-too-large`).

## Checks

```sh
bun run --cwd packages/daemon-protocol typecheck
bun run --cwd packages/daemon-protocol lint
bun run --cwd packages/daemon-protocol test
```

`test` runs under `bun test` against the real chat engine (`@moonbase/chat-runtime`, a dev dependency) with controlled providers, a controlled file host and temporary stores. One case runs the compiled remote client in the pinned Electron, as desktop main does.
