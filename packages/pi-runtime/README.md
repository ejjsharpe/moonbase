# Pi chat runtime

`@moonbase/pi-runtime` implements independent contracts `ChatService`; process roots bind it through the shared application handlers. Pi Durable owns execution, transcripts, tasks and request metadata; clients do not add an execution store or scheduler.

| Export | Role |
| --- | --- |
| `.` | Remote fixed-settings `PiRuntimeLive(config)`, per-conversation `LocalPiRuntimeLive(config)` and privileged `LocalPiControl` |
| `./local-models`, `./providers`, `./credentials` | Pinned local provider catalog, document-owned setup and injected encrypted persistence |
| `./server` | `serveChat(config, rootBoundChatClient)`: scoped authenticated loopback listener |
| `./remote` | `RemoteChatLive`: service using an injected `ConnectionService`, without Pi/SQLite/provider code |

Reusable service exports consume `@moonbase/contracts` and focused Effect helpers; shared authentication comes only from the named `@moonbase/ssh/host-health` leaf. Layers create no runtime. `src/host.ts` is a standalone process root with one runtime, Harness/store and listener. Remote clients compose the remote and connection layers in their own root; see the [consumer example](examples/remote.ts).

See [local runtime, setup, credentials and qualification](docs/LOCAL.md) for embedded desktop use. Local and remote scopes share their caller’s root runtime; layers create none.

## Host setup

Use Node 26.13.0 and pinned workspace dependencies. Start the host separately on its machine:

```sh
node --experimental-strip-types packages/pi-runtime/src/host.ts /absolute/private/moonbase-host.json
```

The private JSON file contains exactly:

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

Choose a new Moonbase database namespace and an existing cwd. The listener binds only `127.0.0.1`; ports are 1–65535. The key must be 16–4096 printable non-space ASCII characters, separate from public identities, and kept out of source control, arguments and logs.

The CLI installs Pi coding tools (`read`, `write`, `edit`, `bash`) and OpenAI/Anthropic provider factories. Select a model in the pinned catalog with existing host-side `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` credentials. The cwd is tool context, not a filesystem sandbox. Programmatic consumers may inject public Pi `Models` and an optional `Registry`.

The host acquires exclusive SQLite ownership before serving. Existing stores with incompatible host/actor/cwd/model or unowned conversations reject instead of importing or retargeting. SIGINT/SIGTERM releases the listener/Harness; reopening the exact store/settings follows Pi restart semantics for already admitted work. WAL/NORMAL and external tool effects carry no general power-loss or exactly-once guarantee.

## Command semantics

Use `makeChatClient(runtime)` and the [chat contract](../contracts/docs/CHAT.md). Mutations bind actor/request IDs to full immutable inputs. Preserve originals across uncertain outcomes; reconnect, reads and subscriptions never resend. Send reserves metadata before Pi submission; a reserved request without admission requires explicit matching retry. Stop targets only its captured submission/task. Cancellation or disconnect does not establish remote termination.

The server implements the [health](../contracts/docs/HOST-PROTOCOL.md) and [challenge/RPC](../contracts/docs/CHAT.md#stateful-loopback-protocol) protocols. The remote adapter validates replies and exact connection generations. A lost, unproved or malformed mutation response may mean admission and remains `Uncertain`. Keys/endpoints stay privileged. HMAC authenticates messages; SSH supplies transport encryption.

Local SDK work and exact abort requests remain root-owned through settlement; caller cancellation releases only its wait. Shutdown closes observations, drains local admission work, closes Harness, then joins aborts and cleans remaining resources. Private configuration and app-owned saved payloads use strict schemas; malformed/foreign data blocks rewriting or resubmission. See [ownership and private formats](docs/OWNERSHIP.md).

## Checks

```sh
bun run --cwd packages/pi-runtime typecheck
bun run --cwd packages/pi-runtime lint
bun run --cwd packages/pi-runtime test
bun run test:chat-integration
```

Tests use controlled providers and temporary SQLite. The host baseline is separate from the compiled remote adapter's Electron 45.1.0 / Node 24.22.1 runtime check. These do not qualify real provider/SSH access, shipped host notices, packaged UI or human acceptance.
