# Host coordination and private data

`PiRuntimeLive` acquires resources in its caller's root scope. It creates no runtime. The standalone `host.ts` owns the process runtime; `RemoteChatLive` receives an existing connection capability and contains no host, provider, SQLite or private-configuration implementation.

## Admission and cancellation

The root owns local SDK calls as Effect child work through actual Promise settlement. Cancelling a caller interrupts its join. Before admission, a cancelled per-conversation semaphore waiter cannot submit. After the admission section starts, cancellation cannot release its lease or close backing resources while the SDK call continues. The keyed semaphore entry disappears after its last holder/waiter leaves.

The admission lease covers immutable reservation, public `submissionByRequest` lookup, `submit({whenBusy: 'reject'})`, and receipt reconciliation. It never covers model/tool execution. Other conversations, reads and exact Stop use independent work. Pi Durable owns tasks, submissions, transcripts and execution; this coordination adds no durable queue or scheduler.

Matching explicit retries reuse the original serialized request binding and admission. Reads, startup, watch acquisition, reconnect and uncertain outcomes never submit reserved work. Creation commit/reply-read loss remains `Uncertain`.

Stop reserves its own immutable request and checks the captured conversation/submission/task, including a captured null task. Its one-second Effect deadline starts before joining `abortTask` and covers that join plus terminal observation. Timeout returns `pending`, while the abort request remains root-owned. A separately cancellable Chord Context closes only the terminal waiter, and its SDK Promise is joined before releasing that observation. Neither timeout nor caller cancellation follows a successor task. A late abort failure remains available to root cleanup even after a `pending` response.

Watch acquisition registers commit and close subscriptions before the initial snapshot. Each subscription has its own release finalizer. The awaitable client close fences delivery, joins finalizers and reports cleanup failure; root teardown also closes outstanding observations. Closing a watch never Stops a task.

## Resource release

Each acquired database, storage, Harness and execution environment immediately receives a finalizer. Successful storage acquisition transfers database cleanup ownership; successful Harness acquisition transfers storage cleanup ownership. Failed acquisition retains the previous owner. Release attempts continue after failures, and the application error boundary preserves safe typed/composite evidence while redacting unknown diagnostics.

Root finalizers run in this order:

1. Reject new commands and watch acquisitions.
2. Close subscriptions and terminal-wait scopes.
3. Interrupt gate waiters and drain started local SDK admission/transaction work through actual settlement.
4. Close Harness, allowing it to interrupt its owned model/tool invocations under Pi restart semantics.
5. Join outstanding abort adapters and surface their retained failures.
6. Release any still-owned storage/database and the execution environment.

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
