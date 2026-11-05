# Headless transcript navigation (#110)

Final propagated prerequisite: `23303e0432a60f7e5863d235086ed7ef5e657b65` (#109/#122/#123 and R2 runtime review corrections). Initial requested prerequisite: `c75d837ee777f13ccf6143c866c1c3421895a081`, fast-forwarded from generated checkout `1bb0ad0917ffb1bdd08f06cadec416354ac680a4`. Only the #110 delta was rebased from that initial prerequisite. Implementation checkout: `/Users/elliotsharpe/.t3/worktrees/moonbase/t3-c084abad`, branch `feat/transcript-navigation-110`. Runtime/protocol semantics remain with Pi; this owner consumes the finalized [read contract](../../contracts/docs/TRANSCRIPTS.md) and supplied watch. The parent independently approved #123 R3 at this exact propagated prerequisite; no further runtime fixes are pending.

## Public consumption

`ChatState.transcript` owns the canonical **oldest-first** `entries` window. `snapshot` remains the latest coherent run/status snapshot; historical reading does not replace it. Consumers must not merge `snapshot.entries` into the canonical window. `older()` and `later()` move through retained rows and the server's opaque continuations; `jumpToEntry(entryId)` uses an authorized around-entry read with both directions; `jumpToLatest()` returns to the latest observed boundary. Only exact durable IDs deduplicate entries. Distinct entries with equal text/task/attempt remain distinct.

`transcript.earlier`, `later`, `atLatest`, `loading` and `error` describe navigation. `capabilities.transcript` is `unknown`, `available` or `legacy`; advertised failed support remains a visible failure. `capabilities.find` is `unavailable`: there is no Find handler or stub here (#114). `observation` distinguishes `inactive`, `local`, `streaming`, `legacy`, `reconnecting` and terminal `failed`. Reconnecting snapshots retain stale content; stale/failed evidence cannot authorize live hydration or complete reads. Local and legacy observations can omit the runtime's optional observation status. No controller polling/reconnect loop exists.

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

The readonly `controller.backendId` is the composition's backend identity; capture it with the source, rather than replacing it with the current backend when restoring. Foreign backend/target/source input rejects before changing memory. A synthetic `entryId: 'live'` rejects and never dispatches around-entry navigation. Other opaque durable IDs are validated by the authorized around-entry read, including anchors evicted from the current window. Presentation (#111) owns DOM capture/restoration, following at the bottom and automatic near-top loading; no renderer view-memory owner is needed.

Saved anchors and expansions are best-effort view hints. Try the saved row/part and relative offset even when its text changed; if absent, presentation uses a nearby available row in the same exact backend/conversation. Once the reader navigates, their new position wins. Live source and selection fields retain their captured identity for location/expansion keys, but do not grant content authority. View restoration performs no live content read or prefix proof and has no proof-readiness/error state. Durable anchors outside the window use the existing around-entry read; true navigation/loading errors remain in `transcript.error`. `jumpToLatest()` clears a live anchor and its expansions. No mutation, retry or Stop is synthesized.

## Progressive content

`loadTranscriptManifest(source, restart?)` reads **one bounded descriptor page**. `manifest` exposes retained ordered `parts`, `nextCursor`, `omittedParts`, `status` and `error`. Calling again advances; a failed page retries its unchanged cursor. `restart: true` begins from the source again, including after an expired cursor/source change. Omitted descriptors can be reread; they are not a permanent source limit.

`loadTranscriptPart(source, {partId, bytes, revision}, restart?)` reads **one bounded chunk**. Each `content` item exposes its exact source/selection, chunks with byte offsets/encoding, `loadedBytes`, `retainedFrom`, `nextCursor`, status and error. Call again for further chunks. A complete status proves the selected fixed length was read; `retainedFrom > 0` explicitly means earlier chunks were evicted and the retained chunks are not the complete source. Never label concatenated retained chunks as complete Copy. Restart rereads that same explicit selection; callers must explicitly capture a new descriptor to select a changed source/revision.

Statuses are `partial`, `loading`, `complete`, `error`, `source-changed`. Each reply validates schema/serialized bounds, full target/source, selected part/length/revision, request cursor, offset, decoded byte advancement and terminal proof. Errors retain the last valid progress/cursor. Changed live incarnation, prefix evidence, recovery/finalization or reconnect stales old hydration rather than joining it by text or task. The runtime's fixed-prefix read may still authorize an older fixed length after an append; complete iteration excludes that append. When an observed selected-part revision changes during fixed-selection iteration, the controller obtains fresh proof of the original prefix through the existing bounded read. The selection and data cursor stay fixed; a pure append does not restart Copy. A held old reply alone cannot authorize success. There is no guessed live-to-committed equivalence.

Unchanged entry/part DTOs reuse object references even when transport allocates equivalent objects. Live-only progress reuses history and hydrated immutable content without requests. New coherent boundaries update the latest edge; historical windows retain their reading position. Authority and terminal observation failures remain observable.

## Complete-source iteration and native handoff

The `/chat` export supplies `iterateTranscriptSource({read, source, selection?, signal?, isCurrent?, onProgress?})` and `makeTranscriptReader(chatClient)`. The async generator yields `{source, selection, offset, encoding, data}` chunks. Without a selection it walks every manifest page/available ordered part, independently of controller cache retention. With a selection it reads exactly that fixed part revision/length. Base64 chunks must be decoded individually. Missing/unavailable data, malformed echoes, offset gaps, non-advancing/cyclic cursors, cancellation and source changes **reject iteration**. Progress is `{parts, bytes}`; successful iterator completion is explicit terminal evidence, not clipboard success.

Injected reads work without a model or mounted presentation. Live reads additionally require `isCurrent()` supplied by the authoritative observation owner; checks fence every await, yield, progress callback and completion. It must reject stale, disconnected, retired or replaced observations. The caller supplies actual IO cancellation/cleanup ownership.

`controller.iterateTranscript(source, options?)` supplies those current-selection/lifecycle checks and tracks underlying read settlement in the existing selection scope. Selection, connection generation, Hide, close and disposal abort work and fence late outcomes. Calls do not use mutation admission or suppress another selection's reads. Disposal retains closing transcript owners, including detached scopes, through actual injected Promise settlement; an injected read ignoring abort can therefore delay cleanup but cannot publish late data. Watch-close/finalizer failures retain the existing aggregate observation cleanup semantics.

#111 must capture the backend/document capability alongside the source; equal public IDs never authorize another backend. #111 owns native clipboard authority and must revalidate the captured live selection immediately before the final clipboard write. Iterator success alone does not authorize that write. #112/#113 consume ordered descriptors/chunks and explicit redacted/unsupported/unavailable/tail evidence for tools/images. #114 can use `jumpToEntry` and semantic part anchors once its own runtime Find contract/handler exists.

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

## Verification scope

Public tests cover overlapping multi-page traversal, around navigation, byte/row/descriptor/content/view-ID eviction, oversized parts, fixed live prefixes, cloned DTO reference reuse, corrupt replies, manifest cycles, held read lifecycle races and application-versus-restart memory. Controlled public local Pi and authenticated child/forwarded HTTP tests observe successive text before held completion, no extra history reads, and independent drafting/Stop. Foundation checks include the iterator in the actual browser bundle and preserve baseline saved-byte fixtures.

Source/controlled checks do not qualify foreground/native presentation, clipboard final writes, packaged execution, real providers/SSH, accessibility or physical durability. No new UI rendering, Find, transport retry engine or saved schema is introduced.

## Implementation qualification

Final combined qualification used Node `v26.13.0` and Bun `1.4.4` on the #110 implementation tree above independently approved prerequisite `23303e0432a60f7e5863d235086ed7ef5e657b65`. Required source suites ran serially; no foreground/dev app, real provider, real SSH destination, PR, merge/deployment or legacy-state operation was used.

| Command | Result |
| --- | --- |
| `bun install --frozen-lockfile` | Pass; lockfile unchanged |
| `NX_DAEMON=false bun run typecheck` | Pass, 8 tasks (7 cached) |
| `bun run lint`; `bun run format:check`; `git diff --check` | Pass |
| `bun run check:foundation` | Pass, 281 actual browser inputs; fixed saved bytes unchanged |
| `NX_DAEMON=false bun run test` | Pass, 8 tasks (2 cached); `/tmp/moonbase-110-combined-source-final.log` |
| `bun run test:chat-integration` | Pass, 12/12; controlled local/child/forwarded HTTP; `/tmp/moonbase-110-combined-chat-final.log` |
| `bun run test:editor-integration` | Pass, 26/26; `/tmp/moonbase-110-combined-editor-final.log` |
| `bun x vp build --config apps/desktop/vite.config.ts`; `bun run --cwd apps/desktop check:renderer` | Pass, 8626 inputs and five workers/font; renderer only, no native/package launch |

Independent watch-close failures remain observable through application disposal while cancelled transcript IO settles; authenticated terminal `Unauthorized` remains visible through the controller's existing error state. The runtime review correction's transport-specific regressions remain unchanged upstream and pass in the combined root suite. Root disposal also observes independent watch-close failure while actual transcript IO remains pending; terminal local-watch failure explicitly stales completed live hydration without requiring a reconnect-status snapshot. Fixed-selection Copy revalidates changed live evidence with bounded prefix proofs while retaining the original selection; repeated proof supersession remains an explicit failure. Native final clipboard writes and presentation acceptance remain #111/later-ticket checks.

## Independent review corrections

R1: movement persists its semantic view anchor without an intermediate publication. The single direction-aware movement publication enforces retention before notifying presentation; a later-page read cannot be pruned as an earlier movement. The public 640-entry round trip reproduced 252/640 visible entries on forward traversal before the fix and now reaches all 640 in both directions, with ordered windows, cache bounds and truthful final flags. Focused evidence: `/tmp/moonbase-110-r1-{red,green}.log`.

R2: consecutive coherent latest pages must overlap in the active window before merging. Otherwise the active latest window is replaced and navigation restarts from the new snapshot's continuation; cached identity alone does not prove an unbroken interval. Historical reading retains its anchor/window and bridges to a newer boundary through authorized around-entry reads. Public tests reproduce 96/128 reachable entries before the fix and cover disjoint updates with opaque durable IDs, complete two-way traversal, around anchors, 640-entry eviction and unchanged cloned DTO references. The existing legacy replacement fixture likewise expects only its replacement page, without retaining an unproved older preview. Focused evidence: `/tmp/moonbase-110-r2-{red,green}.log`.


R3: fixed-selection controller iteration obtains a fresh offset-zero read of the original `{partId, bytes, revision}` after observed evidence changes. The runtime validates that entire fixed prefix even though the proof reply contains one bounded chunk. Proofs validate source/target/selection/cursor, offset, encoding and the existing chunk/terminal bounds. They do not advance or restart the data cursor, enter the hydration LRU or count toward Copy progress. Progress callbacks, yielded chunks and final completion stay fenced; a progress callback's own source change is checked before publication continues. The public API and injected-read iterator signatures are unchanged.

Public tests reproduce the held-second-chunk append failure before the fix; afterward the exact 70,000-byte prefix completes through successive appends and final-progress reentrancy. Held proof tests preserve rejection for replaced prefixes (including beyond the preview), rollover, reconnecting and unproved finalization. Corrupt proof source/selection/cursor/offset/encoding rejects. A held transport proof covers only evidence observed before its request; it cannot validate a newer observation merely because it arrived later. Focused evidence: `/tmp/moonbase-110-r3-{red,green}.log`; aggregate public regressions: `/tmp/moonbase-110-r1-r3-focused.log`.

Each publication/completion checkpoint permits at most three fresh proof reads across all reentrant checks. If every proof is superseded, iteration rejects with `Conflict` without restarting the whole Copy. The current DTO echoes the fixed selection, not a witness relating that prefix to a newer observed full-part revision. Guaranteeing completion under indefinitely superseded proofs while rejecting held replacement evidence would require an authenticated runtime witness that the captured prefix is retained across that newer observed revision. This fix does not infer append preservation from increasing byte counts, matching previews or source/incarnation alone. Whole-live-source manifest iteration still requires a coherent unchanged manifest; #111's captured fixed-part selections use the new proof path. Native final-write authority stays with #111.

### Review-correction qualification

The three corrections are separate commits above reviewed implementation `37a6da0163a78d95abe7faa09cb6fed6cc1333dd`, retaining approved runtime base `23303e0432a60f7e5863d235086ed7ef5e657b65`. Checks used Node `v26.13.0` / Bun `1.4.4`. No runtime/contract/UI/saved-state/dependency changes, delegation, PR, foreground/dev app, real quota or real SSH host were used. The earlier held-prefix fixture now changes its controlled backend together with the observed replacement, so a fresh proof reads the state the fixture claims.

| Command | Result / evidence |
| --- | --- |
| `node --experimental-strip-types --test --test-concurrency=1 packages/application/test/transcript.test.ts packages/application/test/application.test.ts packages/application/test/chat-controller.test.ts` | 152/152; `/tmp/moonbase-110-r1-r3-focused-final.log` |
| `NX_DAEMON=false bun run typecheck` | 8 tasks passed, 7 cached; `/tmp/moonbase-110-review-r1-typecheck.log` |
| `bun run lint`; `bun run format:check`; `git diff --check` | Pass; `/tmp/moonbase-110-review-r1-{lint,format}.log` |
| `bun run check:foundation` | Pass, 281 browser inputs and unchanged baseline bytes; `/tmp/moonbase-110-review-r1-foundation.log` |
| `NX_DAEMON=false bun run test` | 8 tasks passed, 2 cached; `/tmp/moonbase-110-review-r1-source.log` |
| `bun run test:chat-integration` | 12/12; `/tmp/moonbase-110-review-r1-chat-integration.log` |
| `bun run test:editor-integration` | 26/26; `/tmp/moonbase-110-review-r1-editor-integration.log` |

Resource-heavy source/process and integration suites ran serially. Native foreground, packaged/manual presentation and final clipboard writes were not exercised; the public #111 handoff remains unchanged. #111 can retain its captured fixed selection while controller iteration verifies later appends; success still means completed validated iteration followed by native final-write authorization, never a progress callback or hydrated preview.

### Round 2 navigation ownership correction

The new held-history race reproduced on `bec0275c666fefd934fa4cec784a4636be3dff3b`: after a disjoint latest snapshot, a read captured under upper entry `e63` merged into the replacement latest window and produced canonical positions `0..48, 96..127, 49..63`. A second public probe showed that publishing a new snapshot from a loading subscriber could redirect the older read before dispatch. Red evidence: `/tmp/moonbase-110-round2-red.log`.

Earlier/later movement now joins any admitted navigation first, skips unavailable boundaries, and freezes historical mode before publishing loading. Around-entry navigation likewise leaves latest mode on admission. Coalesced watch updates therefore retain the captured history window while updating live/status evidence independently. Every awaited navigation boundary rechecks the existing signal/current owner before merging or publishing; superseded jobs retain their existing cleanup, error and finally fences. Failed observations cannot admit read actions that clear their error. No new queue, generation framework, public signature or runtime/Copy change is introduced.

Eight public regressions cover the held bounded page followed by disjoint latest data and complete ordered traversal; synchronous loading-subscriber reentrancy; around/latest supersession with late success and late error while newer loading/error remains visible; held restoration preserving entry/part/relative offset and immutable upper bound; and no-op/failed-observation boundaries. The primary race does not call a presentation view setter. Green evidence: `/tmp/moonbase-110-round2-green.log`.

Qualification for this correction used Node `v26.13.0` and Bun `1.4.4` in the same isolated checkout, above `bec0275` and approved runtime base `23303e0`. The existing Copy proof limit and its public interface are unchanged. Resource-heavy source/process and controlled integration suites ran serially; no app/PR/delegation, real quota/SSH, runtime/contract/UI/saved-state/dependency change, or #111 checkout change was used.

| Command | Result / evidence |
| --- | --- |
| `node --experimental-strip-types --test --test-concurrency=1 packages/application/test/transcript.test.ts packages/application/test/application.test.ts packages/application/test/chat-controller.test.ts` | 160/160; `/tmp/moonbase-110-round2-focused.log` |
| `NX_DAEMON=false bun run typecheck` | 8 tasks passed, 7 cached; `/tmp/moonbase-110-round2-typecheck.log` |
| `bun run lint`; `bun run format:check`; `git diff --check` | Pass; `/tmp/moonbase-110-round2-{lint,format}.log` |
| `bun run check:foundation` | Pass, 281 browser inputs and unchanged saved-byte fixtures; `/tmp/moonbase-110-round2-foundation.log` |
| `NX_DAEMON=false bun run test` | 8 tasks passed, 2 cached; `/tmp/moonbase-110-round2-source.log` |
| `bun run test:chat-integration` | 12/12; `/tmp/moonbase-110-round2-chat-integration.log` |

Evidence remains source/controlled only. Native foreground, packaged/manual presentation and final clipboard writes were not exercised for this correction.

## Simplified view restoration on current main

Transferred only `23303e0..51a3c54` onto `af7e7922a8eb8954f4d285245aa9a6ea85f93c28`; squashed foundation fixes were not replayed. The original navigation and renderer heads remain preserved. View-only prefix-proof jobs and their tests were replaced by public best-effort memory tests; all complete-source iterator proof tests remain. Backend/conversation validation, bounded memory, panel/target lifetime and restart behavior remain covered. Renderer fallback and user-navigation behavior belong to #111.
