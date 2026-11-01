# Personal chat v0 boundary

This commit defines contracts and shared dispatch only. It implements no Pi host, remote proxy, HTTP authentication or durable admission. The standalone editor needs none of these capabilities. Implementations require separate public-interface tests and independent review.

`application/chat-client` is browser-safe. `ChatService` exposes the eight named commands and scoped bounded `watch({target})`; `chatCommand`/`chatWatch` are their common application entry points. `makeChatClient` receives the existing process runtime. A host installs the Pi-backed service. A privileged desktop installs a remote service that resolves `ConnectionService.endpoint({host})` for the exact connected authority. Neither creates another feature runtime, dispatcher, scheduler or execution store. The remote host has its own process runtime and Pi store. The browser receives no endpoint, key, provider credentials or database path.

## Identity and operations

The operator configures one host/store, one personal `actorId`, one absolute remote working directory and one model. `getChatHost({host})` reports these public settings; it never connects or changes authority. `ChatSession` binds that host/store and actor. `ChatTarget` also binds the saved conversation. The host validates every field against its configuration and Pi-owned conversation metadata before reading or changing it. A valid key does not authorize a different actor/store. A remote cwd is descriptive remote data, never a local editor approval. Existing chats retain their original settings; incompatible configuration fails visibly rather than silently rebinding them.

Stateful request identity is `(actorId, requestId)` within the configured host/store. The bound full input includes the operation and exact target as well as its payload. Reusing an ID for another operation or conversation rejects; conversation-scoped Pi deduplication alone is insufficient. Store this binding in Pi documents, not a second journal. Generate a new ID for a deliberate new action and retain the old one for an uncertain retry.

- `listChats` pages at most 32 saved conversations using an opaque, bounded cursor. `createChat` binds the full session/request/title immutably and returns its original conversation on a matching retry. Changed reuse is `InvalidInput`. Creation, metadata and its request binding belong in one Pi transaction using public creation/document APIs; no legacy import.
- `getChat` returns a bounded replacement snapshot with the newest history page and current run. `getChatHistory` returns the next older page, newest first. Durable entry IDs identify items; reconnect replaces/merges by those IDs rather than appending duplicates.
- `sendChat` binds the exact actor/host/store/conversation/request/text. A matching explicit retry resolves the same intent; changed reuse rejects before Pi submission. `getChatSend` queries that exact intent without submitting. `null` or `reserved` is not proof that an in-flight admission cannot commit. The client keeps its original pending ID and text through loss/reload/reconnect and offers an explicit same-input retry; queries and observer startup never invent another Send.
- `stopChat` binds a request ID to a captured `ChatStopTarget`: exact conversation, immutable submission and a specific task ID, or null for a still-queued submission. Reuse with a different target rejects. A superseded task returns `superseded`; it must not abort whichever task is now current. A queued withdrawal uses the verified submission only. No conversation-wide abort fallback. Repeating a Stop may observe its now-terminal target but cannot touch a later input. `pending` reports cooperative cancellation still unresolved, not successful termination.

The host uses Pi `whenBusy: "reject"`, preventing a later input from joining the same active run. Verify submission ownership and current run membership before Stop. Task IDs can change after a tool round; a client obtains a fresh explicit Stop target from a current snapshot. Never substitute a later task during an old Stop, including a successor, without a new explicit action. A failed/uncertain Stop retains its original immutable target. Cancellation cannot undo completed tool effects and is not an external exactly-once guarantee.

## Pi ownership and publication

Published Pi Durable 1.4.0 lacks transactional `submit(tx,draft)`. Use only its public APIs: reserve immutable request metadata in a Pi document, call ordinary `conversation.submit` with a namespaced stable Pi request ID, then bind the committed submission. This is two-phase admission, not one atomic transaction. A lost response or restart uses public `tx.submissionByRequest` to bind an existing admission without sending. If absent, retain visible reserved/uncertain intent until an explicit matching retry. Namespacing includes actor and conversation; Pi's weaker content deduplication must not bypass Moonbase's immutable binding.

Pi owns execution, tasks, transcripts and request metadata documents. No second execution event store or application scheduling queue. Per-conversation admission coordination may serialize conflicting admissions, but never wait for a model/tool inside the Pi transaction or block status/Stop behind that work. Host resume may resume Pi's already admitted tasks; it never resubmits a reserved app request. Admission receipts mean persisted admission, not completion. Storage failure, parked work and unknown outcomes stay visible. One process must acquire actual exclusive store ownership before serving; no live/legacy store discovery or import.

Observe Pi commit invalidations/document state, then read bounded projections outside synchronous callbacks. Do not mount the full-transcript `Conversation.watch`. Register before initial reads and coalesce refreshes without losing a final update. Each view owns only its observation resources: unsubscribe, disconnect or client Quit never Stop remote work. A host shutdown separately closes its Harness/resources, retaining Pi's restart semantics.

## Bounds and errors

Inputs are at most 32 KiB UTF-8; reject invalid/empty text, NUL and oversize data before reservation/admission. IDs use bounded nonempty ASCII identifiers (at most 256 characters), titles at most 200 UTF-8 bytes, cursors at most 1024 bytes. Reject unknown operations, wrong shapes, unexpected target identity and overlarge HTTP bodies before dispatch. Validate outputs received from the host too; typed dispatch alone does not validate network or Electron callers.

History contains at most 32 entries per page; each text preview is at most 4096 UTF-8 bytes, marked `truncated` when cut. Live text and each tool preview have the same cap; at most eight tool activities per snapshot. Bound metadata and error strings as well. Actual serialized response bytes, including JSON escaping, must not exceed 256 KiB. Projection may return fewer entries to meet that bound, retaining a correct next cursor without skipping omitted entries. Truncation must preserve valid Unicode; no claim bounds Pi's internal cache or stored transcript. A watch coalesces replacement snapshots and retains bounded pending data rather than an ever-growing event queue.

Use existing `ApplicationError` codes: `InvalidInput` for malformed/changed identity, `Unauthorized` for authentication/actor authority, `Incompatible` for wrong host/store/protocol, `Conflict` for busy admission, `Persistence` for definite storage rejection, `Uncertain` for possibly admitted outcomes and `Unavailable` for connectivity. Cancellation describes the caller's wait; it does not imply admitted Pi work stopped. Keep remote error text sanitized and bounded; no raw provider/SSH/configuration/credential dumps. File-specific error targets are not chat authority.

## Stateful loopback protocol

The independent implementation owns the server and privileged remote adapter; both use this wire contract. Keep `/v1/health` and its checked nonce HMAC unchanged. Health proofs do not authenticate stateful requests. There is no bearer-key fallback.

Before each RPC, including reads, the client requests a single-use challenge from `GET /v1/chat/challenge`. Generate a fresh 32-byte canonical base64url client nonce. Headers are `X-Moonbase-Nonce` and `Authorization: Moonbase-RPC-HMAC-SHA256 <lowercase hex proof>`, with HMAC-SHA256 keyed by the configured host key over UTF-8 `JSON.stringify` of:

`["moonbase-chat-v1", "challenge-request", clientNonce, "GET", "/v1/chat/challenge"]`

The server validates that proof, then creates an independent random 32-byte canonical base64url challenge and returns JSON `{challenge,health}`. `health` has the same public identity fields as checked health v1. The response echoes `X-Moonbase-Nonce` and supplies `X-Moonbase-Proof` over:

`["moonbase-chat-v1", "challenge-response", clientNonce, httpStatus, responseBodySha256]`

SHA-256 hashes the exact raw UTF-8 body bytes. The client verifies this proof and expected health before sending any chat input. Cap challenge replies at 8 KiB. The server keeps at most 128 outstanding challenges in its existing HTTP server scope, each bound to its client nonce and a monotonic 20-second expiry. Expire old grants before accepting new ones; reject capacity exhaustion without evicting a grant into an accepted state. Closing/restarting the server drops outstanding grants, making old challenges invalid. This bounded authentication cache is not a durable command/execution store.

`POST /v1/chat` carries UTF-8 JSON `{operation,input}` for exactly the eight commands above, capped at 64 KiB raw request bytes. Headers carry `X-Moonbase-Nonce`, `X-Moonbase-Challenge` and the RPC Authorization scheme above. Its proof covers:

`["moonbase-chat-v1", "request", clientNonce, challenge, "POST", "/v1/chat", bodySha256]`

Before parsing/dispatch, verify the proof and that the challenge is live and bound to this client nonce. Consume it atomically before any asynchronous dispatch. A valid challenge can authorize exactly one RPC, even for simultaneous matching posts. Reject replay, unknown/expired challenge and old-server grants without dispatch. Replaying a signed challenge GET mints a different challenge and cannot reactivate an old RPC. A deliberate retry obtains a fresh challenge but retains the original immutable command request ID/payload. Immutable Send deduplication alone cannot prevent a previously rejected/reserved request being replayed later; both controls are required. [RFC 9421 section7.2.2](https://www.rfc-editor.org/rfc/rfc9421.html#section-7.2.2) explains why signatures need verifier-enforced replay protection; this small protocol does not claim RFC9421 wire-format compliance.

The response body is JSON `{ok:true,value}` or `{ok:false,error:{code,message}}`. Echo the client nonce and challenge headers and send `X-Moonbase-Proof` over:

`["moonbase-chat-v1", "response", clientNonce, challenge, httpStatus, responseBodySha256]`

The client verifies the nonce/challenge/proof/status/body and expected authority before accepting data or an application error. Unauthenticated errors may be generic401 and never include private details. Distinct domains prevent challenge/health/request reflection. Use constant-time proof comparisons, redirect rejection, explicit loopback origins, bounded incremental body reading, fatal UTF-8 decoding and scoped reader cleanup. The reusable key never appears in JSON, URLs, HTTP headers, argv, public snapshots or logs. Existing SSH encrypts the forwarded connection; HMAC authenticates application messages and adds no separate encryption layer. A live relay is not ruled out by these proofs.

Use one bounded per-request deadline (20seconds) across challenge and RPC body reading; an unresolved Stop may return `pending`. Watches poll the same read-only `getChat` operation at a bounded cadence, or adapt local Pi invalidations directly. Do not add an unbounded network event transport. On reconnect resolve the new verified connection generation explicitly for the same host/store, read saved state and pending receipts, and never replay Send. Scope old-generation waits/subscriptions so stale responses cannot change the selected newer authority.

## Required implementation evidence

Real temporary SQLite, counted faux models/tools, exclusive second-process ownership, changed/duplicate/lost Send, two-phase crash gaps, restart without resubmit, storage errors, bounded Unicode/JSON output, subscriber disposal and exact Stop races. Exercise the production local HTTP server/remote adapter with wrong listener/key/identity, tampered/replayed/reflected responses, duplicate/concurrent/expired/old-server challenge use, bounded grant capacity, unknown operations, cancellation/deadlines and disconnected generations. No real provider quota or unspecified SSH host is authorized. These tests, minimum-runtime/assets checks, packaged execution and human acceptance remain pending in this contract-only change.
