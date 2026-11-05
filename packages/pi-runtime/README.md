# Pi chat runtime

`@moonbase/pi-runtime` implements independent contracts `ChatService`; process roots bind it through the shared application handlers. Pi Durable owns execution, transcripts, tasks and request metadata; clients do not add an execution store or scheduler.

| Export | Role |
| --- | --- |
| `.` | Remote fixed-settings `PiRuntimeLive(config)`, per-conversation `LocalPiRuntimeLive(config)` and privileged `LocalPiControl` |
| `./local-models`, `./providers`, `./credentials` | Pinned local provider catalog, document-owned setup and injected encrypted persistence |
| `./server` | `serveChat(config, rootBoundChatClient)`: scoped authenticated loopback listener |
| `./remote` | `RemoteChatLive`: service using an injected `ConnectionService`, without Pi/SQLite/provider code |

Reusable service exports consume `@moonbase/contracts` and focused Effect helpers; shared authentication comes only from the named `@moonbase/ssh/host-health` leaf. Layers create no runtime. `src/host.ts` is a standalone process root with one runtime, Harness/store and listener. Remote clients compose the remote and connection layers in their own root; see the [consumer example](examples/remote.ts).

See [local runtime, setup and credentials](docs/LOCAL.md) for embedded desktop use. Local and remote scopes share their caller’s root runtime; layers create none.

Provider setup publishes maintained Moonbase defaults and SDK-supported reasoning efforts. Local Create validates the chosen effort, stores it with the immutable conversation settings and configures Pi's thinking level before the first Send. Defaults do not override a client's explicit saved preference.

The runtime implementation stays private behind those exports:

- `src/index.ts` keeps configuration types, layers and explicit service wiring.
- `src/commands.ts` owns request authority, admission, reconciliation, exact Stop, watches and local activity inspection.
- `src/history.ts` projects bounded lists, history and live task/tool snapshots from the acquired Harness and immutable authority values.
- `src/resources.ts` validates configuration and acquires SQLite, storage, Harness, tool environments and root work/observation scopes in release order.
- `src/documents.ts` owns the unchanged document families, exact IDs and shared metadata/settings checks; `src/runtime-types.ts` holds erased shared types. Existing private schemas and validation remain their own leaves.

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

The server implements the [health](../contracts/docs/HOST-PROTOCOL.md) and [challenge/RPC](../contracts/docs/CHAT.md#stateful-loopback-protocol) protocols. The remote adapter validates replies and exact connection generations. Installed network servers advertise `chat-stream-v1` and stream supplied watch snapshots; only older hosts without this feature use 250 ms polling. See [stream proofs, budgets, reconnection and tests](docs/STREAMING.md). A lost, unproved or malformed mutation response may mean admission and remains `Uncertain`. Keys/endpoints stay privileged. HMAC authenticates messages; SSH supplies transport encryption.

Local SDK work and exact abort requests remain root-owned through settlement; caller cancellation releases only its wait. Shutdown closes observations, drains local admission work, closes Harness, then joins aborts and cleans remaining resources. Private configuration and app-owned saved payloads use strict schemas; malformed/foreign data blocks rewriting or resubmission. See [ownership and private formats](docs/OWNERSHIP.md).

## Checks

```sh
bun run --cwd packages/pi-runtime typecheck
bun run --cwd packages/pi-runtime lint
bun run --cwd packages/pi-runtime test
bun run test:chat-integration
```

Tests use controlled providers and temporary SQLite. The host baseline is separate from the compiled remote adapter's Electron 45.1.0 / Node 24.22.1 runtime check. These do not qualify real provider/SSH access, shipped host notices, packaged UI or human acceptance.

`test/commands.test.ts` covers immutable requests, saved-data rejection, authority and restart; `test/history.test.ts` covers bounded history/live projection and failure/tool states; `test/lifecycle.test.ts` covers admission, cancellation, Stop, watches and acquisition/shutdown. Each case acquires its own fixture from `test/runtime-fixture.ts`; Node's test-file isolation keeps SDK mocks separate. `test/transport.test.ts` and `test/host-process.test.ts` retain transport and actual host-process coverage, including an audit of the compiled remote bundle's actual inputs. Local/provider/credential suites remain separate.

`test/observation.test.ts` instruments public SDK reads and subscriptions over temporary Pi stores. It covers held text/thinking/tool progress, unrelated conversations, history/status reuse, startup/recovery, scheduler blockage, slow consumers, bounded pages and held cleanup. See [local observation](docs/OBSERVATION.md) for the selected public Pi API, invalidation and byte budgets, cleanup settlement, SDK limits and test coverage.

Structured transcripts use the private `transcript.ts` owner for ordered parts, exact sources, authenticated cursors and bounded retained-content reads. `history.ts` captures coherent live/history boundaries and around-entry windows. See [read contracts](../contracts/docs/TRANSCRIPTS.md). `test/transcript.test.ts` reconstructs every manifest/chunk continuation for 1,100 durable entries, more than 32 ordered blocks, multi-megabyte escaped text/JSON/patch/details and binary image bytes within the page and chunk bounds. It also covers identity/revision/cursor mismatch and tampering, redacted thinking, reused and ambiguous tool IDs, requested versus executed arguments, dropped live tails, held reads across completion and restart, and fixed-prefix appends versus replacement. The public SDK materializes a retained record in memory; these limits bound transport and paging, not that allocation.

Completed nested-tool activity reads the exact retained public `NestedCallDoc` result, validated against its child/parent/call identities. Cleared live-slot previews are not completion evidence; missing retained content remains explicitly unavailable.

Nested requested arguments come from immutable task input. Executed arguments require an execute checkpoint or a settled result with SDK execution-time evidence; pending and blocked requests are never labeled executed.

Snapshot projection recaptures the full live/history view up to three times when a nested document disappears and the SDK confirms its parent is ending. Other failures propagate immediately. Explicit content selections keep their captured source and still fail with `Conflict` on retirement.

Complete saved-conversation Find is implemented by private `find.ts`, sharing `transcript.ts`'s display-content policy without eagerly hashing parts or decoding images. Authenticated continuations seek directly to message/block/auxiliary positions rather than reconstructing a growing prefix. Local and authenticated remote handlers advertise `transcript-find-v1`. See [Find bounds and cancellation](docs/FIND.md); existing mutation formats, stores and observation behavior are unchanged.
