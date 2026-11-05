# Headless transcript navigation

Runtime/protocol semantics remain with Pi; this owner consumes the [read contract](../../contracts/docs/TRANSCRIPTS.md) and supplied watch.

## Public consumption

`ChatState.transcript` owns the canonical **oldest-first** `entries` window. `snapshot` remains the latest coherent run/status snapshot; historical reading does not replace it. Consumers must not merge `snapshot.entries` into the canonical window. `older()` and `later()` move through retained rows and the server's opaque continuations; `jumpToEntry(entryId)` uses an authorized around-entry read with both directions; `jumpToLatest()` returns to the latest observed boundary. Only exact durable IDs deduplicate entries. Distinct entries with equal text/task/attempt remain distinct.

`transcript.earlier`, `later`, `atLatest`, `loading` and `error` describe navigation. `capabilities.transcript` is `unknown`, `available` or `legacy`; advertised failed support remains a visible failure. `capabilities.find` is `available` only when the host advertises both transcript and Find support. Advertised failures remain visible; older hosts explain the upgrade requirement. `observation` distinguishes `inactive`, `local`, `streaming`, `legacy`, `reconnecting` and terminal `failed`. Reconnecting snapshots retain stale content; stale/failed evidence cannot authorize live hydration or complete reads. Local and legacy observations can omit the runtime's optional observation status. No controller polling/reconnect loop exists.

`setTranscriptView({anchor, expanded})` captures a semantic anchor (offset is viewport-relative pixels) and expansion IDs. `TranscriptViewAnchor` accepts the existing `TranscriptEntryAnchor` `{entryId, partId?, offset}` or an exact `TranscriptLiveAnchor`. All three types are exported from `/chat`. For a live descriptor captured from the current coherent run or manifest:

```ts
controller.setTranscriptView({
  anchor: {
    backendId: controller.backendId,
    source, // exact kind: 'live', including full target/submission/task/attempt/incarnation
    partId: descriptor.partId,
    bytes: descriptor.bytes,
    revision: descriptor.revision,
    offset,
  },
  expanded,
});
```

The readonly `controller.backendId` is the composition's backend identity; capture it with the source, rather than replacing it with the current backend when restoring. Foreign backend/target/source input rejects before changing memory. A synthetic `entryId: 'live'` rejects and never dispatches around-entry navigation. Other opaque durable IDs are validated by the authorized around-entry read, including anchors evicted from the current window. Presentation owns DOM capture/restoration, following at the bottom and automatic near-top loading; no renderer view-memory owner is needed.

Saved anchors and expansions are best-effort view hints. Try the saved row/part and relative offset even when its text changed; if absent, presentation uses a nearby available row in the same exact backend/conversation. Once the reader navigates, their new position wins. Live source and selection fields retain their captured identity for location/expansion keys, but do not grant content authority. View restoration performs no live content read or prefix proof and has no proof-readiness/error state. Durable anchors outside the window use the existing around-entry read; true navigation/loading errors remain in `transcript.error`. `jumpToLatest()` clears a live anchor and its expansions. No mutation, retry or Stop is synthesized.

## Progressive content

`loadTranscriptManifest(source, restart?)` reads **one bounded descriptor page**. `manifest` exposes retained ordered `parts`, `nextCursor`, `omittedParts`, `status` and `error`. Calling again advances; a failed page retries its unchanged cursor. `restart: true` begins from the source again, including after an expired cursor/source change. Omitted descriptors can be reread; they are not a permanent source limit.

`loadTranscriptPart(source, {partId, bytes, revision}, restart?)` reads **one bounded chunk**. Each `content` item exposes its exact source/selection, chunks with byte offsets/encoding, `loadedBytes`, `retainedFrom`, `nextCursor`, status and error. Call again for further chunks. A complete status proves the selected fixed length was read; `retainedFrom > 0` explicitly means earlier chunks were evicted and the retained chunks are not the complete source. Never label concatenated retained chunks as complete Copy. Restart rereads that same explicit selection; callers must explicitly capture a new descriptor to select a changed source/revision.

Statuses are `partial`, `loading`, `complete`, `error`, `source-changed`. Each reply validates schema/serialized bounds, full target/source, selected part/length/revision, request cursor, offset, decoded byte advancement and terminal proof. Errors retain the last valid progress/cursor. Changed live incarnation, prefix evidence, recovery/finalization or reconnect stales old hydration rather than joining it by text or task. The runtime's fixed-prefix read may still authorize an older fixed length after an append; complete iteration excludes that append. When an observed selected-part revision changes during fixed-selection iteration, the controller obtains fresh proof of the original prefix through the existing bounded read. The selection and data cursor stay fixed; a pure append does not restart Copy. A held old reply alone cannot authorize success. There is no guessed live-to-committed equivalence.

Unchanged entry/part DTOs reuse object references even when transport allocates equivalent objects. Live-only progress reuses history and hydrated immutable content without requests. New coherent boundaries update the latest edge; historical windows retain their reading position. Authority and terminal observation failures remain observable.

## Complete-source iteration and native handoff

The `/chat` export supplies `iterateTranscriptSource({read, source, selection?, signal?, isCurrent?, onProgress?})` and `makeTranscriptReader(chatClient)`. The async generator yields `{source, selection, offset, encoding, data}` chunks. Without a selection it walks every manifest page/available ordered part, independently of controller cache retention. With a selection it reads exactly that fixed part revision/length. Base64 chunks must be decoded individually. Missing/unavailable data, malformed echoes, offset gaps, non-advancing/cyclic cursors, cancellation and source changes **reject iteration**. Progress is `{parts, bytes}`; successful iterator completion is explicit terminal evidence, not clipboard success.

Injected reads work without a model or mounted presentation. Live reads additionally require `isCurrent()` supplied by the authoritative observation owner; checks fence every await, yield, progress callback and completion. It must reject stale, disconnected, retired or replaced observations. The caller supplies actual IO cancellation/cleanup ownership.

`controller.iterateTranscript(source, options?)` supplies those current-selection/lifecycle checks and tracks underlying read settlement in the existing selection scope. Each controller iterator additionally joins only its own admitted raw data/proof promises before completion, return or cancelled rejection. Cancellation fences progress/publication immediately, while the iterator remains pending until ignored-abort IO actually settles; resource-bounded consumers must retain capacity through that settlement. Unrelated iterations, navigation/hydration and Stop are not joined or serialized. The standalone injected `iterateTranscriptSource` keeps caller-owned IO cleanup. Selection, connection generation, Hide, close and disposal abort work and fence late outcomes. Calls do not use mutation admission or suppress another selection's reads. Disposal retains closing transcript owners, including detached scopes, through actual injected Promise settlement; an injected read ignoring abort can therefore delay cleanup but cannot publish late data. Watch-close/finalizer failures retain the existing aggregate observation cleanup semantics.


Native Copy must capture the backend/document capability alongside the source; equal public IDs never authorize another backend. Native Copy owns clipboard authority and must revalidate the captured live selection immediately before the final clipboard write. Iterator success alone does not authorize that write. Tool and image presentation consume ordered descriptors/chunks and explicit redacted/unsupported/unavailable/tail evidence. Find uses `jumpToEntry` and semantic part anchors.

Each publication/completion checkpoint permits at most three fresh proof reads across all reentrant checks. If every proof is superseded, iteration rejects with `Conflict` without restarting the whole Copy. The DTO echoes the fixed selection, not a witness relating that prefix to a newer observed full-part revision, so append preservation is never inferred from increasing byte counts, matching previews or source/incarnation alone. Whole-live-source manifest iteration requires a coherent unchanged manifest; captured fixed-part selections use the proof path.

## Retention and memory

| Retained resource | Bound |
| --- | --- |
| Displayed historical rows | 128 |
| Summary records, including latest/selected entry and hydrated descriptors | 256 and 2 MiB serialized UTF-8, including descriptor/navigation/view envelopes |
| Hydrated content LRU | 8 MiB serialized UTF-8 including source/selection/chunk envelopes, at most 128 selections |
| View memory | 64 exact backend/host/store/actor/conversation keys, 256 KiB serialized total |
| Expansion identifiers | Last 128 distinct IDs per view, each at most 256 UTF-8 bytes |

These are retention bounds, not total JS heap/CPU limits. Visible anchor and active selection identity remain pinned; an oversized active part still loses old chunks at the byte bound. Complete iteration keeps only a manifest page/current chunk and constant-space cursor-cycle evidence, and does not populate the LRU. No fixed total-history/source clipping exists.

`createMoonbaseApplication` supplies one `TranscriptViewMemory` across panel and named-target controller replacement, keyed by backend plus full public target. Standalone models own scoped memory by default; explicit `backendId`/`transcriptMemory` injection supports another composition. Memory contains only anchors/expansions (including exact live source/fixed selection metadata), clears on application disposal, and is never placed in saved data/storage. Current live proof metadata counts toward the selected summary budget; no content is retained in view memory. A fresh application starts latest even if version-one drafts restore conversation selection. Transcript data caches belong to the selected owner and are released on selection replacement/Hide/close/disposal.

## Navigation ownership

Movement persists its semantic view anchor without an intermediate publication. A single direction-aware movement publication enforces retention before notifying presentation, so a later-page read cannot be pruned as an earlier movement. Earlier/later movement joins any admitted navigation first, skips unavailable boundaries and freezes historical mode before publishing loading; around-entry navigation likewise leaves latest mode on admission. Coalesced watch updates therefore retain the captured history window while updating live/status evidence independently. Every awaited navigation boundary rechecks the existing signal/current owner before merging or publishing. Failed observations cannot admit read actions that clear their error.

Consecutive coherent latest pages must overlap in the active window before merging. Otherwise the active latest window is replaced and navigation restarts from the new snapshot's continuation; cached identity alone does not prove an unbroken interval. Historical reading retains its anchor/window and bridges to a newer boundary through authorized around-entry reads. Cursors are bound to their returned durable edge IDs and reused only at the corresponding retained edge; otherwise navigation rebases through an authorized edge read, preserving already proved older-boundary evidence. Under summary pressure, rereadable manifest descriptors are evicted first, then offscreen rows before active rows.

Startup owns one restore intent that yields to explicit navigation or view capture. A newer validated `setTranscriptView` cancels an admitted startup restoration, fences its page merge and suppresses its stale success/error publication; earlier/later navigation can also supersede it. The first snapshot establishes both history boundaries when it supplies initial fallback rows, including while a durable anchor is waiting. Only explicit Find reveal resets startup-restoration ownership.

Independent watch-close failures remain observable through application disposal while cancelled transcript IO settles. Terminal local-watch failure stales completed live hydration without requiring a reconnect-status snapshot.

## Selected conversation Find

The selected TranscriptOwner owns `find: TranscriptFindState` and the controller exposes `openFind()`, `findTranscript(query)`, `nextFindMatch()`, `previousFindMatch()`, `cancelFindReveal()` and `closeFind()`. Opening does no IO; a nonempty literal query starts bounded pages through the existing supplied client. Query changes, close, selection/target/backend/connection replacement, Hide and disposal abort the old generation immediately. Reconnecting observation cancels and visibly requires Refresh. Pending injected SDK/transport Promises remain owned through actual settlement; stale results, errors and terminal publication cannot reach the replacement query/owner.

Find validates serialized limits, full target/source, query/cursor echoes, fixed upper/start cursor, original UTF16 range/snippet boundaries, literal match evidence, advancing progress and cursor cycles. Empty intermediate pages stay `searching`; only a terminal valid page produces `complete`/no matches. Appends set `refreshAvailable` without changing the captured cutoff. Advertised handler failures stay errors, without legacy fallback or polling.

`matches` retains at most `transcriptLimits.findMatches` (256) and `retainedFrom` gives its global ordinal; `count` counts validated matches seen so far. The active match remains separately pinned with `activeIndex`. Next/previous use retained results or replay from the original authenticated `startCursor`, never a new cutoff. No unbounded seen-cursor/result/page index is retained. Query/results are absent from saved drafts and application view memory.

`find.active` is `{source, partId, start, end, snippet}` with original UTF16, end exclusive. `view.anchor.offset` continues to mean viewport pixels. A selection uses the existing authorized around-entry reader and semantic entry/part anchor; presentation pages the manifest, unfolds the owning disclosure and hydrates through the exact match. `find.revealing` authorizes automatic reveal/hydration. `cancelFindReveal()` aborts that work when the reader deliberately navigates, retaining query/results/active identity. It also aborts captured evicted-result replay before checking visible reveal state, so an earlier reader cancellation cannot leave a later replay able to retarget or fail over newer manual navigation. It does not cancel the independent bounded query scan. Query-close/replacement cancels both scan and reveal. Hydration belonging to the active reveal inherits that abort signal and retains its actual read cleanup.

Retained UTF-8 chunks additionally carry original `textOffset`, and content carries `loadedText`, both UTF16 independent of `offset`/`loadedBytes` (bytes). They advance before cache eviction. A match beyond the 8 MiB serialized cache can therefore be highlighted in a bounded original-source window even after earlier chunks are released; navigating back restarts the same exact part selection if needed. Content Copy and fixed-prefix proofs retain their existing independent rules.

A synchronous snapshot subscriber can close Find or start a replacement query during the initial searching publication. The superseded call checks its captured query generation and AbortSignal before handling an inactive-owner error and returns without publishing into the successor; a current generation on an inactive owner still gets the visible reconnect/reopen error. Find's query/reveal cancellation does not join or cancel independent content iterations or newer manual history jobs.

## Testing

Public tests cover overlapping multi-page traversal, around navigation, byte/row/descriptor/content/view-ID eviction, oversized parts, fixed live prefixes and proof supersession, cloned DTO reference reuse, corrupt replies, manifest cycles, held read lifecycle and navigation races, startup restoration and application-versus-restart memory (`test/transcript.test.ts`, `test/application.test.ts`, `test/chat-controller.test.ts`). `test/find.test.ts`, `test/find-reentrant.test.ts` and `test/find-replay-navigation.test.ts` cover the local/remote-controller Find facade, 1,100 rows, bounded retention/fixed replay, missing entries, empty progress, late results/errors, reentrant publication, replay versus manual navigation, Hide/disposal, upgrade/failure/validation, independent UTF-16 bases and matched-hydration settlement. Controlled public local Pi and authenticated child/forwarded HTTP tests observe successive text before held completion, no extra history reads, and independent drafting/Stop. Foundation checks include the iterator in the actual browser bundle and preserve baseline saved-byte fixtures. Resource-heavy suites run serially.

Source/controlled checks do not cover foreground/native presentation, clipboard final writes, packaged execution, real providers/SSH, accessibility or physical durability.
