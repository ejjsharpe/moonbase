# Personal chat v0 boundary

Shared semantics for browser clients, application handlers and the [Pi local/remote services](../../pi-runtime/README.md). The standalone editor requires none of these capabilities. Changes must preserve the same contract across clients and transports.

`@moonbase/contracts/chat` is browser-safe. `ChatService` provides ten commands and scoped bounded `watch({target})`; `chatCommand`/`chatWatch` are the common handlers. `makeChatClient` uses the existing process runtime. Hosts install Pi; remote clients install the remote service with an injected connection. Browser clients receive no endpoints, keys, provider credentials or database paths.

## Identity and commands

Remote configuration fixes one host/store, personal actor, absolute cwd and model. Local configuration fixes host/store/actor with `mode: "local"`; each Create requires `settings: {cwd, model: {provider, modelId}}`. A local host reply has no global cwd/model. Remote Create rejects settings; its existing request and ownership formats remain unchanged. `ChatSession` binds host/store/actor; `ChatTarget` adds the conversation. Services validate exact configured identities and Pi ownership metadata before access. Authentication and shape validation alone grant no target authority. Remote cwd never grants local editor access; incompatible saved settings reject rather than rebind.

Mutations bind `(actorId, requestId)` within the configured host/store to the full operation, target and payload in Pi documents. Matching retries resolve original intent; changed reuse, including across operations/conversations, is `InvalidInput`. Keep original inputs through uncertainty; new deliberate actions use new IDs.

| Command | Contract |
| --- | --- |
| `getChatHost` | Read public host settings without connecting or changing authority |
| `listChats` | Page saved conversations with bounded opaque cursors |
| `createChat` | Atomically create conversation, metadata and request binding; matching retry returns that conversation |
| `getChat` | Bounded replacement snapshot with newest history/current run |
| `getChatHistory` | Older history, newest first, identified by durable entry IDs |
| `getChatTranscriptContent` | Optional bounded manifest/part reads over exact committed/live sources |
| `getChatHistoryAround` | Optional bounded history with both continuations around a durable entry |
| `sendChat` | Submit immutable text/target intent; matching explicit retry reconciles it |
| `getChatSend` | Query exact intent without submitting; null/reserved does not prove non-admission |
| `stopChat` | Cancel only the captured conversation/submission/task; null task withdraws only that queued submission |

Use Pi `whenBusy: "reject"`. Stop verifies submission ownership/run membership; superseded tasks never follow a successor. A new task requires a fresh explicit Stop action. `pending` means cooperative cancellation remains unresolved, not termination. Cancellation cannot undo tool effects.

## Persistence and observation

Pi Durable 1.4.0 lacks transactional submit. Reserve immutable request metadata in a Pi document, call public `conversation.submit` with a stable namespaced Pi request ID, then bind the submission. After loss/restart, public `tx.submissionByRequest` reconciles admission without resending. If absent, retain the reservation until explicit matching retry. Reads, reconnect, startup and subscriptions never submit reserved requests; Pi may resume already admitted work. Admission receipts establish persistence, not completion.

Pi owns tasks, transcripts and request documents. Acquire exclusive store ownership before serving; no legacy import or second journal/scheduler. Per-conversation admission coordination must not wait for model/tool execution or globally block queries/Stop.

Register commit invalidations before initial reads; coalesce refreshes into bounded replacement snapshots outside synchronous callbacks. Avoid full-transcript watches. Unsubscribe, disconnect and client Quit release observations/connectivity without stopping remote work. Host shutdown separately closes its Harness/resources under Pi restart semantics.

## Bounds and errors

Validate unknown inputs and remote outputs at trust boundaries. Reject unknown operations/fields and invalid identities before admission. Limits:

- Text: nonempty valid Unicode, no NUL, at most 32 KiB UTF-8.
- IDs: nonempty bounded ASCII, at most 256 characters; titles 200 UTF-8 bytes; cursors 1024 bytes.
- History: at most 32 entries/page; text/live/tool previews 4096 UTF-8 bytes, with valid Unicode and truncation markers; at most eight tool activities/snapshot.
- Serialized response including JSON escaping/envelope: 256 KiB. Shortened pages retain a correct cursor without skipping entries. Metadata/errors and pending observations remain bounded; these caps do not bound Pi's stored transcript/cache.

Use `InvalidInput` for malformed/changed identity, `Unauthorized` for authentication/actor authority, `Incompatible` for host/store/protocol mismatch, `Conflict` for busy admission, `Persistence` for definite storage rejection, `Uncertain` for possible admission and `Unavailable` for connectivity. Caller cancellation ends a wait, not admitted work. Sanitize and bound errors without credential/provider/config dumps.

## Stateful loopback protocol

The Pi module owns the server and privileged remote adapter; both use this wire contract. [Health v1](HOST-PROTOCOL.md) has a separate nonce/HMAC domain. Health proofs do not authenticate stateful requests. There is no bearer-key fallback.

Before each RPC, including reads, the client requests a single-use challenge from `GET /v1/chat/challenge`. Generate a fresh 32-byte canonical base64url client nonce. Headers are `X-Moonbase-Nonce` and `Authorization: Moonbase-RPC-HMAC-SHA256 <lowercase hex proof>`, with HMAC-SHA256 keyed by the configured host key over UTF-8 `JSON.stringify` of:

`["moonbase-chat-v1", "challenge-request", clientNonce, "GET", "/v1/chat/challenge"]`

The server validates that proof, then creates an independent random 32-byte canonical base64url challenge and returns JSON `{challenge,health}`. `health` has the same public identity fields as checked health v1. The response echoes `X-Moonbase-Nonce` and supplies `X-Moonbase-Proof` over:

`["moonbase-chat-v1", "challenge-response", clientNonce, httpStatus, responseBodySha256]`

SHA-256 hashes the exact raw UTF-8 body bytes. The client verifies this proof and expected health before sending any chat input. Cap challenge replies at 8 KiB. The server keeps at most 128 outstanding challenges in its existing HTTP server scope, each bound to its client nonce and a monotonic 20-second expiry. Expire old grants before accepting new ones; reject capacity exhaustion without evicting a grant into an accepted state. Closing/restarting the server drops outstanding grants, making old challenges invalid. This bounded authentication cache is not a durable command/execution store.

`POST /v1/chat` carries UTF-8 JSON `{operation,input}` for the commands above, capped at 196 KiB raw request bytes on both client and server: six times the 32 KiB text bound for worst-case JSON escaping, plus 4 KiB for identifiers and envelope fields. The public `maximumChatRequestBytes` constant also bounds serialized desktop IPC input. Decoded text retains its 32 KiB UTF-8 limit. Headers carry `X-Moonbase-Nonce`, `X-Moonbase-Challenge` and the RPC Authorization scheme above. Its proof covers:

`["moonbase-chat-v1", "request", clientNonce, challenge, "POST", "/v1/chat", bodySha256]`

Before parsing/dispatch, verify the proof and that the challenge is live and bound to this client nonce. Consume it atomically before any asynchronous dispatch. A valid challenge can authorize exactly one RPC, even for simultaneous matching posts. Reject replay, unknown/expired challenge and old-server grants without dispatch. Replaying a signed challenge GET mints a different challenge and cannot reactivate an old RPC. A deliberate retry obtains a fresh challenge but retains the original immutable command request ID/payload. Immutable request deduplication and challenge replay protection are both required: a rejected/reserved request must not become replayable later.

The response body is JSON `{ok:true,value}` or `{ok:false,error:{code,message}}`. Echo the client nonce and challenge headers and send `X-Moonbase-Proof` over:

`["moonbase-chat-v1", "response", clientNonce, challenge, httpStatus, responseBodySha256]`

The client verifies nonce/challenge/proof/status/body and expected authority before accepting data or application errors. After a mutation POST, an unproved or malformed reply remains `Uncertain`; a claimed rejection is authoritative only when authenticated. Unauthenticated errors may be generic 401 and never include private details. Distinct domains prevent challenge/health/request reflection. Use constant-time proof comparisons, redirect rejection, explicit loopback origins, bounded incremental body reading, fatal UTF-8 decoding and scoped reader cleanup. The reusable key never appears in JSON, URLs, HTTP headers, argv, public snapshots or logs. Existing SSH encrypts the forwarded connection; HMAC authenticates application messages and adds no separate encryption layer. A live relay is not ruled out by these proofs.

Use one bounded per-request deadline (20 seconds) across challenge and RPC body reading; an unresolved Stop may return `pending`. Local watches adapt scoped Pi invalidations. Remote hosts advertising `chat-stream-v1` use the [bounded authenticated stream](../../pi-runtime/docs/STREAMING.md); only capability-absent hosts retain 250 ms read-only `getChat` polling. Advertised stream failures remain visible and never select polling. On reconnect resolve the new verified connection generation explicitly for the same host/store, read saved state and pending receipts, and never replay Send. Scope old-generation waits/subscriptions so stale responses cannot change the selected newer authority.

## Verification

Real temporary SQLite, counted faux models/tools, exclusive second-process ownership, changed/duplicate/lost Send, two-phase crash gaps, restart without resubmit, storage errors, bounded Unicode/JSON output, subscriber disposal and exact Stop races. Exercise the production local HTTP server/remote adapter with wrong listener/key/identity, tampered/replayed/reflected responses, duplicate/concurrent/expired/old-server challenge use, bounded grant capacity, unknown operations, cancellation/deadlines and disconnected generations. Use controlled providers and temporary stores. See [integration checks](../../../tests/chat/README.md); real provider/SSH access, runtime/assets qualification, packaged execution and human acceptance require separate evidence.

## Provider setup

`providers`/`providers-schema` define portable catalog/status, start-login, prompt-answer, cancel, open-active-URL and sign-out commands. `ProviderSetupService` binds handlers to a privileged owning document ID supplied by the head. Answers carry exact flow/prompt identities; no renderer-selected owner or URL grants authority. Replies contain no credential values or authorization URLs. SDK authentication, model validation and credential persistence belong to Pi runtime.

The additive `transcript-v1` feature, ordered descriptors, source/prefix evidence, byte units, cursors and consistency rules are specified in [structured transcript reads](TRANSCRIPTS.md). No global protocol/version or saved-mutation format changes.

`ChatSnapshot.observationStatus` optionally reports `connected` or `reconnecting` for capable remote observation. Reconnecting retains the last verified replacement as stale evidence, including before terminal failure; it does not establish that its live source still exists. The existing terminal error callback distinguishes exhausted/permanent failure from an active retry. Absence preserves local/legacy semantics. The [application transcript owner](../../application/docs/TRANSCRIPTS.md) owns presentation and read/Copy fencing using that status and the existing exact source identities.
