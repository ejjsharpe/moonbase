# Pi runtime

`@moonbase/pi-runtime` implements the contracts `ChatService` on Pi Durable, which owns execution, transcripts and tasks. Layers create no runtime; process roots compose them.

| Export | Role |
| --- | --- |
| `.` | Remote fixed-settings `PiRuntimeLive(config)`, per-conversation `LocalPiRuntimeLive(config)` and privileged `LocalPiControl` |
| `./local-models`, `./providers`, `./credentials` | Local provider catalog, provider sign-in and injected encrypted credential storage |
| `./server` | `serveChat(config, client)`: authenticated loopback listener for a remote host |
| `./remote` | `RemoteChatLive`: client-side service over an injected `ConnectionService` |

## Host setup

Start a remote host on its own machine:

```sh
node --experimental-strip-types packages/pi-runtime/src/host.ts /absolute/private/moonbase-host.json
```

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

The listener binds only `127.0.0.1`; reach it through the [SSH package](../ssh/README.md). The token must be 16–4096 printable non-space ASCII characters, kept out of source control, arguments and logs. The host installs Pi's `read`, `write`, `edit` and `bash` tools and uses host-side `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`. **The cwd is tool context, not a filesystem sandbox.**

## Behavior worth knowing

- Mutations carry request IDs bound to their full input. A lost or unproved reply is `Uncertain`; callers retry with the original request rather than resending, and reconnects never resend.
- Stop targets only the captured submission/task. Cancelling or disconnecting a client never stops remote work.

## Chat observation

`watch` uses Pi Durable 1.4.0's public `harness.subscribeCommits` and `subscribeClose`. `watchDoc`, conversation `watch` and the experimental `watchEvents` were rejected: they miss metadata, task and submission changes, or carry the full transcript and private documents, and they bound backlog by frame count, not bytes.

- Commits have no atomic attach, so listeners register before the initial capture, and any authority, source or task change discards an in-flight capture. Text, thinking and tool output appear only as Pi commits them (about every 100 ms).
- Only the selected conversation's records and its live, metadata and nested-call documents trigger a refresh, plus store authority and registry changes, Pi's park and migration-failure reports, and session close. Progress-only updates reuse the cached history window (at most 32 rows and 250 KiB) and the scoped `harness.inspect()` blocked reason, such as `restart_limit`.
- Each acquired host allows at most 64 observations, and each one queues a single invalidation, so a slow consumer receives the current snapshot rather than a backlog. Closing an observation releases its listeners immediately. An SDK read that is already running settles before the root is disposed.
- SDK reads still materialize full documents and the session-wide inspection. The bounds above limit what is retained and sent, not SDK memory or CPU.

`serveChat` advertises `chat-stream-v1` and serves `POST /v1/chat/watch`. Each stream starts with a single-use challenge. Every frame is HMAC-signed in a stream-only proof domain and binds the target, connection, stream and contiguous sequence. The client verifies each frame before it decodes or publishes it. OpenSSH provides transport encryption.

- A frame is at most 256 KiB, and a snapshot is sent in base64 fragments of at most 32 KiB decoded. Each side keeps at most one pending snapshot, and newer progress replaces it. The server and each remote client allow at most 64 streams within the server's 128 connections, so RPC, Send and Stop always have room.
- Establishment and the first snapshot must complete within 20 seconds. Heartbeats go out every 10 seconds, the stream idles out after 30 seconds without a frame, and a blocked write gets 20 seconds to drain. Ordinary RPC keeps its own 20-second deadline.
- A watch reconnects at most 3 times in total, after 250, 500 and 1000 ms, each time with a fresh challenge and snapshot. Before each retry, and before a final error, it republishes the last snapshot as `reconnecting`. Authentication, authority and malformed-frame failures end the stream. Reconnecting never resends a mutation or sends Stop.
- A host without the feature keeps 250 ms `getChat` polling. A host that advertised streaming never falls back to polling.

## Checks

```sh
bun run --cwd packages/pi-runtime typecheck
bun run --cwd packages/pi-runtime lint
bun run --cwd packages/pi-runtime test
bun run test:chat-integration
```

Tests use controlled providers and temporary SQLite stores, never real provider quota or SSH hosts.
