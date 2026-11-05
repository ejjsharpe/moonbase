# Host coordination and private data

`PiRuntimeLive` acquires resources in its caller's root scope. It creates no runtime. The standalone `host.ts` owns the process runtime; `RemoteChatLive` receives an existing connection capability and contains no host, provider, SQLite or private-configuration implementation.

## Private implementation

`index.ts` exposes the existing configuration/layer API and maps each `ChatServiceShape` operation explicitly. Both fixed-settings `PiRuntimeLive` and per-conversation `LocalPiRuntimeLive` use the same private owners. No private module has a package export.

`commands.ts` owns `Host` and its mutable command state: captured inputs, actor/request/operation/target bindings, pending intents, keyed admission, reconciliation, exact Stop, terminal waits, watches and local activity inspection. It authorizes session and conversation reads before calling projection. Receipt lookup may reconcile existing admission evidence but never submits.

`history.ts` receives only the acquired Harness and the immutable session, store identity, target, settings and snapshot values needed for projection. It receives no Host, command callbacks or lifecycle state. It retains descending scans, the 32-row budget, serialized 240 KiB list/250 KiB history candidate limits, escaped byte accounting, identity-bound cursors and the start/continuation sentinel. Live projection retains durable entry IDs, eight legacy tool previews and safe failed/parked/pending messages. Its additive transcript capture pins live/control/result references and a committed history boundary in one transaction. The private `transcript.ts` normalizes ordered retained blocks, pairs tool results through public task attribution, and owns content selection/prefix validation plus ephemeral authenticated read cursors. It imports no application or head lifecycle.

`resources.ts` owns runtime/configuration and canonical cwd/model validation, exclusive SQLite acquisition with its 30 ms busy timeout, database → storage → Harness cleanup transfer, strict store-owner validation before `resume()` and explicit root scope construction. Its tool environment callback reads owned conversation settings through `documents.ts`, without reaching into Host. `documents.ts` declares Request/Store/Metadata once and shares exact record IDs and metadata/settings validation; `runtime-types.ts` contains only erased configuration and retained-work types. `private-schema.ts` and `validation.ts` keep their existing strict decoding and command/output boundaries.

## Admission and cancellation

The root owns local SDK calls as Effect child work through actual Promise settlement. Cancelling a caller interrupts its join. Before admission, a cancelled per-conversation semaphore waiter cannot submit. After the admission section starts, cancellation cannot release its lease or close backing resources while the SDK call continues. The keyed semaphore entry disappears after its last holder/waiter leaves.

The admission lease covers immutable reservation, public `submissionByRequest` lookup, `submit({whenBusy: 'reject'})`, and receipt reconciliation. It never covers model/tool execution. Other conversations, reads and exact Stop use independent work. Pi Durable owns tasks, submissions, transcripts and execution; this coordination adds no durable queue or scheduler.

Matching explicit retries reuse the original serialized request binding and admission. Reads, startup, watch acquisition, reconnect and uncertain outcomes never submit reserved work. Creation commit/reply-read loss remains `Uncertain`.

Stop reserves its own immutable request and checks the captured conversation/submission/task, including a captured null task. Its one-second Effect deadline starts before joining `abortTask` and covers that join plus terminal observation. Timeout returns `pending`, while the abort request remains root-owned. A separately cancellable Chord Context closes only the terminal waiter, and its SDK Promise is joined before releasing that observation. Neither timeout nor caller cancellation follows a successor task. A late abort failure remains available to root cleanup even after a `pending` response.

Watch acquisition registers commit and close subscriptions before the initial snapshot. Each subscription has its own release finalizer. The awaitable client close fences delivery, joins finalizers and reports cleanup failure; root teardown also closes outstanding observations. Closing a watch never Stops a task.

Local observation filters public committed changes before scheduling reads, retains one bounded history window and reuses safe scoped scheduler status between task/registry invalidations. The acquired registry and public parked/migration-failure reports notify only content-free status invalidation; no SDK diagnostics or task graph are retained. Each watch owns those additional listeners in the same observation scope. Unsafe authority/source/control changes fence captures; progress alone schedules replacement without starving coherent publications. Snapshot retirement attempts capture/project afresh with those same scoped caches. A private retirement failure superseded by an unsafe revision consumes the already queued refresh; ordinary errors propagate. Watch reads use root-owned `Host.read` settlement, so closing a listener need not wait for a noncancelable SDK read, while root disposal still must. See [observation budgets/API evaluation and downstream handoff](OBSERVATION.md).

## Resource release

Each acquired database, storage, Harness and execution environment immediately receives a finalizer. Successful storage acquisition transfers database cleanup ownership; successful Harness acquisition transfers storage cleanup ownership. Failed acquisition retains the previous owner. Release attempts continue after failures, and the application error boundary preserves safe typed/composite evidence while redacting unknown diagnostics. Retained adapters compose every failed exit as an Effect cause. After successful root acquisition, `runApplicationEffect(runtime, runtime.disposeEffect)` preserves that composite at the Promise boundary.

Root finalizers run in this order:

1. Reject new commands and watch acquisitions.
2. Close subscriptions and terminal-wait scopes.
3. Interrupt gate waiters and drain started local SDK admission/transaction work through actual settlement.
4. Close Harness, allowing it to interrupt its owned model/tool invocations under Pi restart semantics.
5. Join outstanding abort adapters and surface their retained failures.
6. Release any still-owned storage/database and the execution environment.

This order follows the explicit registrations in `resources.ts`: environment cleanup, database, storage, retained aborts, Harness, local SDK work scope, retained terminal waiters, observation scope and finally the command fence. The retained adapters collect safe composite failures even after their original callers leave. No resource manager or additional runtime changes that ordering.

The host does not wait for every model task to become terminal before closing Harness. A noncooperative SDK admission may delay clean shutdown; its database cannot safely be closed early. Failed cleanup is not a clean shutdown claim.

## Private schemas

All private decoders reject unfamiliar object fields recursively with static errors. They do not publish rejected values, paths, credentials or SDK diagnostics. Models and Registry remain injected public capabilities, retaining their identity; their internals are not decoded.

| Format | Supported representation |
| --- | --- |
| CLI JSON, at most 64 KiB | Exactly `host`, `actorId`, `cwd`, `databasePath`, `model`, `port`, `token`; host/model objects are strict. Absolute paths are at most 4096 UTF-8 bytes; cwd resolves to an existing directory. Port is an integer 1–65535; token is 16–4096 printable non-space ASCII characters. |
| `PiRuntimeLive` configuration | Exactly `host`, `actorId`, `cwd`, `databasePath`, `model`, `models`, optional `registry`. Omitted/undefined Registry uses the existing default. Provider uses the shared chat identifier grammar; model ID is at most 256 UTF-8 bytes. |
| `serveChat` configuration | Exactly `host`, `token`, `port`; programmatic port 0 retains ephemeral-listener support. |
| `moonbase.chat.store`, family key `identity`, session scope, version 1 | Exactly `{identity: string}`. The serialized identity contains strict host/actor/canonical cwd/model settings and must match the configured owner. |
| `moonbase.chat.metadata`, family key `metadata`, conversation scope, version 1 | Exactly `{identity, title, createdAt, pending}`; title is at most 200 UTF-8 bytes, date is parseable, pending is a nonnegative safe integer. Existing latest/current document semantics are unchanged. |
| `moonbase.chat.request`, session family, version 1 | Exactly `{binding, conversationId, submissionId, pending}`; IDs use existing positive safe-integer decimal strings or explicit null. Binding is the original JSON string for strict Create/Send/Stop input plus its operation. Actor/request/target and receipt correspondence are checked before reconciliation. |
| Cursor, at most 1024 UTF-8 bytes | Base64url JSON `{kind, conversationId?, scan}`; kind is `list` or `history`, and the identity/view must match. `scan: null` and exact `{start: true}` retain their recognized start representations. Other scan records contain JSON values and remain opaque public SDK continuation data. |

The public Pi document API enforces family kind, scope, semantics and version; no migration function is installed. Payload validation examines only Moonbase-owned values. It never inspects provider documents or SDK internals. Invalid/foreign/unsupported saved data blocks the affected operation before any automatic rewrite or resubmission, retaining original payload and binding bytes. No fields are projected away, no namespace is reset, and no legacy store is imported.

## Qualification

Package tests use temporary SQLite, counted faux models/tools, controlled SDK-boundary failures, Node child hosts and loopback HTTP. The compiled remote-entry check runs Electron 45.1.0 in Node mode without foreground UI. Cross-module chat tests use controlled forwarding. These checks do not qualify integrated desktop/native/package behavior, real providers/SSH, physical durability, Intel execution or distribution.

## Local ownership extension

Local stores use a strict `{host, actorId, mode: "local"}` identity and require conversation metadata `settings: {cwd, model}`; fixed-settings remote identities and metadata remain unchanged. Local settings belong to immutable Create request bindings. The same resource/admission/Stop ownership above applies. See [local setup and qualification](LOCAL.md).

Transcript content/around-entry commands bypass admission and the legacy whole-invocation uninterruptible wrapper. `Host.read` owns the Promise through settlement in root work, signals cancellation between bounded reads/normalization slices, and drains before Harness release. Caller interruption closes only its join. Cursor MAC keys and live incarnations belong to the acquired Harness lifetime, with no new saved document/schema. See [exact DTO/cursor semantics](../../contracts/docs/TRANSCRIPTS.md).

Nested result projection resolves public `ToolTaskInput` attribution before reading the parent's keyed `NestedCallDoc`; both its index and result must name that exact child task. The result is transient SDK-owned state that retires with the parent, so disappearance invalidates the live source rather than producing an available empty result. Public result content is normalized through the same inert text/media/details projection as ordinary tool results.

Nested input projection keeps requested arguments independent of mutable slot arguments. Running execute checkpoints prove the recorded execution input; after settlement, public result `durationMs` proves execution occurred and the final slot arguments supply that input. Without either proof, the projection makes no executed-input claim. These reads stay in the existing root-owned read operation and check cancellation between SDK calls and bounded normalization slices.

`history.projectSnapshot` retries only the private `NestedSourceRetired` signal, for at most three complete capture/projection attempts. `transcript.ts` raises it only after a missing nested document and a fresh matching parent-task read confirms `completing`/`terminal`. Missing active documents, malformed identities, storage/authority failures and ordinary `Conflict` remain failures. Each retry recaptures live/control/history and its committed upper boundary together; content selections never use this retry. The existing command work scope still owns all SDK Promises through settlement, including observation close/root disposal.

## Network observations

`server.ts` owns up to 64 network watches and awaits their supplied observation closes, retaining release failures for root shutdown. The server transports existing projections without command/history reads. Peer close fences callbacks before joining cleanup; #122 root work retains noncancelable SDK reads through actual settlement. `remote.ts` owns the captured verified generation, connection subscription, bounded decoder/assembly/output queues, reader/AbortController and separate liveness/retry timers. It never disconnects SSH, replays a mutation or Stops work. [Stream protocol](STREAMING.md) records exact limits and failure behavior.
