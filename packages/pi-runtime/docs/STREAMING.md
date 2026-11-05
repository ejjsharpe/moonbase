# Authenticated remote chat observation

`serveChat` installs `POST /v1/chat/watch` and augments authenticated network `getChatHost` replies with `chat-stream-v1`. Bare/local Pi host configuration does not advertise a network endpoint. Health remains `chat-v0`; protocol/version, RPC proofs, saved data and Create/Send/Stop bindings are unchanged. Old clients continue ordinary RPC against new hosts. New clients negotiate once per watch against the captured verified SSH-forwarded loopback endpoint; feature absence alone selects the existing 250 ms `getChat` polling path. Failure after advertised support is visible and never selects polling.

## Establishment and authority

The client obtains a fresh challenge through the existing authenticated GET for every connection attempt. The server shares the existing 128-grant, monotonic 20-second cache between RPC and streaming. A grant authorizes exactly one endpoint request: checking and consuming it have no intervening await. Failed proof does not consume a grant; authenticated malformed requests do. Restart clears grants.

The stream request is strict UTF-8 JSON `{target, connectionId}`, at most **4 KiB**. Target includes exact host/store/actor/conversation. Headers retain the existing nonce/challenge/Authorization syntax. The establishment proof is HMAC-SHA256 over UTF-8 JSON:

`["moonbase-chat-stream-v1", "request", clientNonce, challenge, "POST", "/v1/chat/watch", sha256(exactRequestBytes)]`

No bearer fallback or key transmission is added. Signed pre-stream errors retain the existing RPC response envelope/proof with the consumed nonce/challenge and status; unauthenticated failures disclose no chat data. A successful response has content type `application/vnd.moonbase.chat-stream-v1`; its first authenticated frame establishes the session. SSH provides encryption, HMAC authenticates the application messages. These proofs do not rule out a live relay.

The server authorizes through the supplied root-bound `client.watch({target})`, whose listeners attach before initial capture. No `getChat` or history command is called per update. The existing application controller can still make its one explicit initial `getChat` or a user-requested refresh; those are separate bounded reads. The server can echo/sign the client's generation but cannot independently attest SSH's generation. The privileged adapter captures `ConnectionService.endpoint`, subscribes to connection publications, and rechecks connection ID, origin, token and expected host before establishment, each frame, enqueue and dequeue/publication. Buffered replacements are rechecked when a held service consumer resumes, so a closing queue cannot drain old-generation content into a new generation. A replacement/disconnect ends the captured watch; the existing controller owns selecting a newly connected generation. No stream retries cross that authority boundary.

## Framing and replacement

Every frame is four bytes of unsigned big-endian JSON payload length, exact UTF-8 JSON payload, then 32 binary HMAC bytes. The **entire frame**, including length and proof, is at most **256 KiB**. The proof is:

`["moonbase-chat-stream-v1", "frame", clientNonce, challenge, sha256(exactPayloadBytes)]`

The payload itself binds `{target, connectionId, streamId, sequence, kind, ...}`. Stream IDs are fresh 32-byte random base64url identifiers. Sequences start at zero, are contiguous safe integers and count actual writes after coalescing. Nonce/challenge bind the exact establishment; target, generation, session, sequence and content are all inside the authenticated exact payload bytes. RPC/health/request proofs cannot be reflected as frame proofs. Authenticate before strict decoding or snapshot publication. Invalid proof, authority, schema, duplicate/reordered/missing sequence or inconsistent fragments terminates with a safe error and no offending publication.

Kinds are `snapshot`, `heartbeat` and sanitized terminal `error`. A snapshot is the UTF-8 JSON serialization of one existing independently replaceable `ChatSnapshot`, at most **256 KiB**. It is split into canonical base64 fragments of at most **32 KiB decoded bytes**. Each snapshot frame contains `offset`, `total` and `data`; contiguous fragments must agree on total, cannot overlap/skip, and no heartbeat may interrupt them. Sequence zero starts a snapshot (or supplies a signed terminal error). Only a complete, fatal-UTF-8-decoded, `V.output('getChat', ..., {target})`-validated replacement publishes. No text-based joining/deduplication or live/history mutation occurs. Boundary, submission/task/attempt/incarnation, part IDs/revisions and retained evidence pass through unchanged.

Binary chunk boundaries may split UTF-8 because decoding occurs after complete bounded assembly. Fragmented/coalesced network reads are handled by a decoder retaining one partial frame, rejecting oversized length before allocation. It does not retain a list of received updates. A partial EOF is transport loss and resynchronizes; discontinuous authenticated payloads are terminal incompatibility.

## Budgets and liveness

| Resource | Limit |
| --- | --- |
| Server active requests / TCP connections | Existing 128 / 128; streams count inside both |
| Network observations / remote layer observations | 64 each, independently enforced; closing server watches occupy their slot until their close settles |
| Server snapshot retention | One pending replacement plus one being written, each at most 256 KiB serialized; new progress supersedes pending state |
| Writer | At most one bounded frame at a time; `write(false)` waits for drain/close before another frame; Node's finite socket high-water mark bounds its write queue (one frame may cross the mark) |
| Client decoder / assembly | One partial frame at most 256 KiB; one snapshot at most 256 KiB; base64 fragment at most 32 KiB decoded |
| Client publication | Sliding queue of one replacement plus last verified replacement; at most 256 KiB serialized each; retained stale/current objects can share references |
| Capability negotiation | Ordinary authenticated RPC, existing 20-second deadline |
| Stream establishment | **20 seconds total client-side** across challenge, POST and first complete verified snapshot; server also bounds request receipt and then initial observation/write separately to 20 seconds each |
| Heartbeat | Signed, every **10 seconds** when no replacement is being written; no transcript publication |
| Idle | **30 seconds** since last verified frame after the initial complete snapshot; invalid/partial bytes do not reset it |
| Blocked drain | **20 seconds** per blocked write, independently of RPC/idle deadlines |
| Terminal flush | **20 seconds** after the signed terminal frame has drained; await response finish/peer close, then destroy only an unfinished response |
| Reconnection | At most **3** reconnects after the initial attempt, delays **250/500/1000 ms**, fresh challenge/session/snapshot every time |

These are serialized retention/transport bounds, not total JS heap or SDK materialization/CPU guarantees. Serialization, base64 and underlying fetch/socket buffers add bounded transient copies. [Local observation](OBSERVATION.md)'s SDK document/inspection allocation limits remain. RPC and Stop do not wait for observation/provider completion. Sixty-four streams leave half the connection/request window available for other commands. A slow writer either drains with a current replacement or disconnects within its drain budget.

Transport loss, partial EOF and idle/establishment expiry retry inside the captured generation. The attempt counter is never reset by a successful first snapshot; a snapshot/disconnect loop stops after four total attempts. Authentication, authority and malformed-data errors are terminal. Each attempt has its own 20-second establishment deadline, so initial negotiation plus all failed establishments is bounded by 101.75 seconds (20 + 4×20 + 1.75), excluding scheduler delay. Established streams may remain healthy indefinitely; each transport outage still has the finite attempt count for that watch. A fresh explicit watch gets a new budget.

After any in-generation observation failure, a previously verified snapshot publishes with additive `observationStatus: 'reconnecting'` before retry or terminal error delivery, including retry exhaustion. Its content is retained stale evidence, not proof that the live source remains current. The terminal `onError` distinguishes exhausted/permanent failure from an active reconnect; no additional snapshot status is needed. Generation validation fences the stale update as well as ordinary replacements. Fresh validated replacement publishes `connected`. Before any snapshot, retry attempts publish no fabricated content; exhaustion invokes the existing terminal `onError`. The application controller owns status presentation and invalidation of live hydration/Copy decisions. Local/legacy snapshots can omit the field; watch/client/service signatures remain unchanged.

## Cleanup and root ownership

Remote scope close interrupts its connection listener, request/reader loop and retry wait; it aborts fetch, cancels/releases the reader and clears establishment/idle timers. Cancellation of an already errored reader can reject with the same transport failure; that is not a second release failure. Independent release failures are retained by the parent watch scope before either child fiber is forked. Child scopes join their actual finalizers first; retained defects then fail the owning observation, including explicit close or an already-failed generation queue. Ordinary transport failures travel through the queue once; independent defects travel through finalization once, so a generation failure combines with a reader release failure rather than hiding it. Publication is fenced by the scope and captured generation.

On a source error the writer drains the authenticated terminal frame, ends the response and waits for finish/peer close within its separate 20-second flush budget. A finished response is left intact so its signed error bytes are delivered; an unfinished response is destroyed at the deadline. This prevents an authority/source rejection becoming transport loss and a hidden reconnect. On peer/server close the writer immediately fences callbacks, cancels heartbeat/establishment/drain/flush waits, destroys unfinished transport and awaits its supplied observation close. Server shutdown retains and joins watch closes, including failures. Local observation close releases listeners without waiting on an uninterruptible SDK read; that Promise remains in the Pi root work scope through actual settlement before Harness/storage release. Stream close, view switch, document reload and reconnect never Stop work or replay a mutation. Desktop's existing exact document authority and browser-safe bridge validate/transport the same snapshot shape.

## Tests

`test/stream.test.ts` and `test/transport.test.ts` use the production server and public remote client. They cover:

- Network-only capability advertisement, zero recurring `getChat`, replacement publication, generation/close fences, 64-observer admission on both client and raw server paths, and ordinary RPC availability at stream capacity.
- Tampered, wrong-domain, reflected or replayed proofs; repeated, reordered or missing sequences; and wrong target/generation all publish no offending snapshot.
- Multi-frame snapshot reconstruction with headers, bodies and proofs split into small reads or coalesced, and oversized prefixes rejected before allocation.
- Burst coalescing, a stalled `write(false)` writer released within its drain deadline, and the finite four-attempt reconnect budget with stale `reconnecting` status before retry or terminal error.
- Dequeue-time generation checks for held service consumers, retained child reader-release failures, signed terminal `Unauthorized` delivery on the first attempt, and the terminal flush deadline.
- Closing a held network reader releases the server watch while a held SDK capture stays root-owned until actual settlement.

Establishment, idle and blocked-drain tests scale the existing timeout constants down. Heartbeat and terminal-flush tests advance controlled clocks using the unmodified production values. Tests must not depend on short wall-clock windows; these are deadline-logic checks, not wall-clock measurements.

`tests/chat/stream-host.mjs` and `tool-host.mjs` run a real temporary Pi process behind controlled forwarding: text/thinking and tool progress appear before held completion, the final entry replaces the live run with a new committed boundary, unrelated conversations cause no publication and exact Stop responds independently. The compiled remote adapter's Electron 45.1.0 / Node 24.22.1 process test establishes and closes an authenticated stream, and its bundle contains only Pi runtime `remote.ts`, `protocol.ts` and `validation.ts`. None of these checks cover packaged or native UI, real SSH hosts or providers.
