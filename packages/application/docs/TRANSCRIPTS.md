# Headless transcript navigation (#110)

Final propagated prerequisite: `23303e0432a60f7e5863d235086ed7ef5e657b65` (#109/#122/#123 and R2 runtime review corrections). Initial requested prerequisite: `c75d837ee777f13ccf6143c866c1c3421895a081`, fast-forwarded from generated checkout `1bb0ad0917ffb1bdd08f06cadec416354ac680a4`. Only the #110 delta was rebased from that initial prerequisite. Implementation checkout: `/Users/elliotsharpe/.t3/worktrees/moonbase/t3-c084abad`, branch `feat/transcript-navigation-110`. Runtime/protocol semantics remain with Pi; this owner consumes the finalized [read contract](../../contracts/docs/TRANSCRIPTS.md) and supplied watch. The parent independently approved #123 R3 at this exact propagated prerequisite; no further runtime fixes are pending.

## Public consumption

`ChatState.transcript` owns the canonical **oldest-first** `entries` window. `snapshot` remains the latest coherent run/status snapshot; historical reading does not replace it. Consumers must not merge `snapshot.entries` into the canonical window. `older()` and `later()` move through retained rows and the server's opaque continuations; `jumpToEntry(entryId)` uses an authorized around-entry read with both directions; `jumpToLatest()` returns to the latest observed boundary. Only exact durable IDs deduplicate entries. Distinct entries with equal text/task/attempt remain distinct.

`transcript.earlier`, `later`, `atLatest`, `loading` and `error` describe navigation. `capabilities.transcript` is `unknown`, `available` or `legacy`; advertised failed support remains a visible failure. `capabilities.find` is `unavailable`: there is no Find handler or stub here (#114). `observation` distinguishes `inactive`, `local`, `streaming`, `legacy`, `reconnecting` and terminal `failed`. Reconnecting snapshots retain stale content; stale/failed evidence cannot authorize live hydration or complete reads. Local and legacy observations can omit the runtime's optional observation status. No controller polling/reconnect loop exists.

`setTranscriptView({anchor, expanded})` captures a semantic `{entryId, partId?, offset}` anchor (offset is viewport-relative pixels) and expansion IDs. Presentation (#111) owns DOM capture/restoration, following at the bottom and automatic near-top loading. The owner restores an anchor through around-entry navigation. Missing anchors and failed reads remain visible; no mutation/retry/Stop is synthesized.

## Progressive content

`loadTranscriptManifest(source, restart?)` reads **one bounded descriptor page**. `manifest` exposes retained ordered `parts`, `nextCursor`, `omittedParts`, `status` and `error`. Calling again advances; a failed page retries its unchanged cursor. `restart: true` begins from the source again, including after an expired cursor/source change. Omitted descriptors can be reread; they are not a permanent source limit.

`loadTranscriptPart(source, {partId, bytes, revision}, restart?)` reads **one bounded chunk**. Each `content` item exposes its exact source/selection, chunks with byte offsets/encoding, `loadedBytes`, `retainedFrom`, `nextCursor`, status and error. Call again for further chunks. A complete status proves the selected fixed length was read; `retainedFrom > 0` explicitly means earlier chunks were evicted and the retained chunks are not the complete source. Never label concatenated retained chunks as complete Copy. Restart rereads that same explicit selection; callers must explicitly capture a new descriptor to select a changed source/revision.

Statuses are `partial`, `loading`, `complete`, `error`, `source-changed`. Each reply validates schema/serialized bounds, full target/source, selected part/length/revision, request cursor, offset, decoded byte advancement and terminal proof. Errors retain the last valid progress/cursor. Changed live incarnation, prefix evidence, recovery/finalization or reconnect stales old hydration rather than joining it by text or task. The runtime's fixed-prefix read may still authorize an older fixed length after an append; complete iteration excludes that append. An observed selected-part revision change during an active iterator fails explicitly and requires a fresh attempt to prove that fixed prefix; a held old reply cannot authorize success. There is no guessed live-to-committed equivalence.

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

`createMoonbaseApplication` supplies one `TranscriptViewMemory` across panel and named-target controller replacement, keyed by backend plus full public target. Standalone models own scoped memory by default; explicit `backendId`/`transcriptMemory` injection supports another composition. Memory contains only anchors/expansions, clears on application disposal, and is never placed in saved data/storage. A fresh application starts latest even if version-one drafts restore conversation selection. Transcript data caches belong to the selected owner and are released on selection replacement/Hide/close/disposal.

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

Independent watch-close failures remain observable through application disposal while cancelled transcript IO settles; authenticated terminal `Unauthorized` remains visible through the controller's existing error state. The runtime review correction's transport-specific regressions remain unchanged upstream and pass in the combined root suite. Root disposal also observes independent watch-close failure while actual transcript IO remains pending; terminal local-watch failure explicitly stales completed live hydration without requiring a reconnect-status snapshot. An observed selected-part revision change during Copy may require an explicit retry to obtain fresh prefix proof. Native final clipboard writes and presentation acceptance remain #111/later-ticket checks.
