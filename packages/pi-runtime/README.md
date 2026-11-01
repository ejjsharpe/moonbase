# Personal chat host

`@moonbase/pi-runtime` implements personal chat v0 through the shared application command handlers. It has three separate public entry points:

| Export | Role |
| --- | --- |
| `.` | `PiRuntimeLive(config)` provides the Pi-backed `ChatService`. |
| `./server` | `serveChat(config, rootBoundChatClient)` acquires the authenticated loopback listener in the caller's Effect scope. |
| `./remote` | `RemoteChatLive` provides the same service using an injected `ConnectionService`; its graph contains no Pi, SQLite or provider implementation. |

Services create no runtime. `src/host.ts` is the standalone process composition root: one `ManagedRuntime`, one shared `makeChatClient`, one Pi Harness/store and a scoped listener. HTTP requests call that injected client, so native/local/network entry points share the application handlers. There is no feature dispatcher, transcript store or scheduler alongside Pi.

## Run the independent host

Use **Node 26.13.0**, the qualified host baseline, and the pinned workspace dependencies and an explicit private configuration file:

```sh
node --experimental-strip-types packages/pi-runtime/src/host.ts /absolute/private/moonbase-host.json
```

The JSON file contains exactly `host: {hostId, storeId}`, `actorId`, absolute `cwd`, absolute `databasePath`, `model: {provider, modelId}`, `port` and private `token`. Choose a new Moonbase database path and an existing working directory. The port must be 1–65535; the listener binds only `127.0.0.1`. Provision a separate private random host key outside source control. It must be 16–4096 printable non-space ASCII characters and must not reuse public identities/settings. Keep the configuration file private; the command accepts its path, never the key itself as an argument.

The CLI installs Pi's normal coding-tools registry (`read`, `write`, `edit`, `bash`) and OpenAI/Anthropic provider factories. Select a model present in the pinned catalog and existing host-side credentials through Pi's normal environment resolution (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`). There is no credential discovery/import, login UI or credential-management store here. The programmatic layer accepts an existing public Pi `Models` collection and optional Pi `Registry`, without introducing another extension system. Coding tools use the configured cwd and host OS authority; cwd is context, not a filesystem sandbox.

The host prints public readiness/error categories only. Start it independently of SSH or a desktop client. A tunnel does not install/start/Stop this host or its jobs. SIGINT/SIGTERM closes its listener and Harness; this interrupts active invocations under Pi's restart policy, rather than explicitly aborting conversations. Reopen the same exact store/settings to resume Pi's already admitted work. Existing stores with a different host/actor/cwd/model, or Pi conversations lacking Moonbase ownership metadata, reject instead of silently retargeting/importing them.

The host acquires actual exclusive SQLite ownership before serving, with a 30 ms contention timeout. Its one-row lock-acquisition table only forces a real SQLite write; its contents are never an ownership receipt or another event store. Pi owns conversations, entries, tasks, submissions and Moonbase's identity/request documents. SQLite WAL/NORMAL is not a power-loss durability guarantee.

## Commands and pending input

Use `makeChatClient(runtime)` from `@moonbase/application/runtime-client`. The shared [CHAT contract](../application/CHAT.md) specifies the eight commands and all wire shapes. A minimal root consumer composes `PiRuntimeLive`, creates a saved chat with `createChat`, submits `sendChat`, then queries `getChat` / `getChatSend`. Remote consumers compose `RemoteChatLive` with their existing connection layer; see [the typed consumer example](examples/remote.ts).

Every mutation binds `(actorId, requestId)` to its complete validated operation/host/store/target/payload in a Pi document. Matching retries resolve the original intent; changed reuse rejects, including reuse across conversations or operations. Keep the original ID and text until a persisted admission receipt is resolved. Admission does not mean completion.

Published Pi Durable 1.4.0 has no transactional submit. Send first commits its immutable reservation, calls ordinary `conversation.submit` with `whenBusy: "reject"`, then binds the public submission record. A lost response/restart uses public `submissionByRequest` without another Send. If no admission is found, the intent remains visibly reserved; only an explicit matching retry may submit it. Read queries, startup, reconnect and subscriptions never submit reserved requests. Busy attempts retain their intent for deliberate retry. A fixed-size pending count is updated atomically with each request document; it is not an execution queue.

Caller cancellation closes a wait, not admitted Pi work. View unsubscribe removes only its bounded observation resources. Per-conversation admission coordination waits only for admission/storage, never model/tool completion, so unrelated queries/chats and Stop remain usable.

Stop binds a new request ID to the exact saved conversation, submission and captured task ID. A null task can only withdraw that queued submission. An already-placed null target never falls through to a running task. A superseded/terminal task never follows a successor or later input. `pending` means cooperative cancellation has not joined within the short wait; it does not claim termination or undo tool effects. Pi can resume provider/task work after interruption, and external effects have no general exactly-once guarantee.

## Delivery and authentication

History scans at most 32 records per page, newest first, with authority-bound opaque continuation cursors. Each text preview is at most 4096 UTF-8 bytes, each live view has at most eight tool activities, and actual escaped JSON stays below 256 KiB including its envelope. A byte cap can shorten a page while preserving its next cursor. Delivery bounds do not bound Pi's internal cache or stored transcript. Views use commit invalidations registered before the initial read, one sliding refresh token and no full-transcript `Conversation.watch`. There are at most 64 local observers; the remote view polls bounded replacement snapshots every 250 ms.

The server implements the unchanged nonce/HMAC health protocol plus the single-use challenge/RPC protocol in `application/CHAT.md`. It keeps at most 128 grants for 20 monotonic seconds, consumes a verified grant synchronously before dispatch, rejects replay/capacity/expiry/old-server grants, and signs exact response status/body bytes. All RPCs, including reads, require fresh challenge authentication. The remote adapter verifies challenge proof and expected health before disclosing input, validates/project outputs, rejects redirects/non-loopback origins, rechecks the current connection generation after awaits and accepts no bearer/health-proof fallback. Input is capped at 32 KiB, raw bodies at 64 KiB, and one 20-second deadline covers challenge plus RPC/body reading. Reader and listener releases use the shared cleanup normalization convention.

The reusable key and endpoint remain privileged. HMAC adds authentication, not encryption; SSH provides transport encryption in the later composition. Live relaying is not ruled out. Disconnect/reconnect changes connectivity only and never invents another Send.

The package `engines` field documents the host/CLI qualification baseline. The host guard stays in `.`; it is absent from `./remote`. The compiled remote entry is separately tested under **Electron 45.1.0 / Node 24.22.1** against an outside Node 26 host, without Pi/provider/SQLite inputs. This is a runtime-boundary check, not packaged Electron/native UI acceptance.

See [EVIDENCE.md](EVIDENCE.md) for commands/results and [PROVENANCE.md](PROVENANCE.md) for pins/assets. Real provider/SSH-host, packaged application, human and power-loss checks remain pending.
