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
- Remote hosts stream snapshots over an authenticated `chat-stream-v1` channel; messages are HMAC-authenticated, and OpenSSH provides transport encryption.

## Checks

```sh
bun run --cwd packages/pi-runtime typecheck
bun run --cwd packages/pi-runtime lint
bun run --cwd packages/pi-runtime test
bun run test:chat-integration
```

Tests use controlled providers and temporary SQLite stores, never real provider quota or SSH hosts.
