# #123 remote streaming qualification

Checked on 2026-11-04 in `/Users/elliotsharpe/.t3/worktrees/moonbase/t3-ac64d7c9`, branch `feat/chat-stream-123`, with Node `v26.13.0`, Bun `1.4.4`, pinned Pi Durable/AI/Chord `1.4.0` and unchanged dependencies/lockfile. Current #108/#123 were read through `gh`, along with root/module/architecture/lifecycle and #109/#122 contracts.

## Initial prerequisites before final rebase

The checkout began at main `1bb0ad0917ffb1bdd08f06cadec416354ac680a4`. Requested prerequisites were applied in order:

| Upstream commit | This checkout |
| --- | --- |
| `d6e297affa9fe035592ea91e2c2e6402c648496d` (#109) | `092d5b29bc271880f824fa4a9e1df53992fbf3c0` |
| `2e588d7e9cd894881b336a6dc7affb97027bbcf5` (retained nested results) | `dbe07b589f8577b92b6d5684a6fdc4773d3a4304` |
| `1280dbba3b8c7d7a2058da8091683f4e2b398013` (nested execution evidence) | `06832764285f173a5ebf323cff11e10db9abda9b` |
| `a146b4abc820439e7f043585d62802662d3cbabc` (#122) | `132e9d6e04a98156c296e0d3d64ed6c588a162c4` |

`e869be8` was not cherry-picked. The sole integration conflict was the transcript import list: both `ToolTaskCheckpoint` and `EntryId` were retained. There was no substantive #122 integration fix. All **25 combined transcript/observation tests passed before #123 coding** at initial prerequisite base `132e9d6e04a98156c296e0d3d64ed6c588a162c4`.

The supplied #122 sustained-progress correction `008984dbf5c3a17bbe5e2fad4f25a7d7daa3bdbb` was cherry-picked separately as `399aafb7eb193479bf53fca50914da55bae8faa7`; its unsafe-invalidation fences and delayed-capture regression tests remain upstream-owned and unchanged.

## Final combined prerequisite base

The parent supplied **`ff26094b077fd03295518d31bdfccad1a2f8a000`** as the final combined #122 head, containing approved #109 **`467acb877591b00b1a257ceb8aea258c12dfb9f5`** and the #122 capture/inspection, progress and retirement-fence corrections. This is the **final #123 diff base**. The initial cherry-picked prerequisite history above was replaced, not replayed.

Only the #123 commit was rebased:

```sh
git rebase --onto ff26094b077fd03295518d31bdfccad1a2f8a000 399aafb7eb193479bf53fca50914da55bae8faa7 feat/chat-stream-123
```

The rebased implementation is **`2912bd6a12cb24836633681e6cf0cf2448e3ab56`**. The sole conflict appended ownership documentation; both the upstream retirement paragraph and #123 network-observation section were retained. No behavior integration correction or separate upstream fix was needed. No #109/#122 checkout was modified. The final qualification commit changes only this evidence file.

Delta-preservation evidence:

- `git range-diff 399aafb7..04c92ef ff26094b..2912bd6` shows only ownership-document context changed by the retained upstream paragraph.
- All **14 non-Markdown file patches** are byte-identical between the original and rebased #123 ranges. Their shared SHA-256 is **`fee43754c65a012012337ade15268a386a8f7348580e38ce6936e1cc953835a2`**.
- A diff against `ff26094b` is empty for upstream `commands.ts`, `history.ts`, `transcript.ts`, `observation.test.ts`, `transcript.test.ts`, `OBSERVATION.md` and `OBSERVATION-VALIDATION.md`. Per-attempt capture/retry hooks, unsafe-control fences, selective private-retirement suppression and ordinary-error propagation are preserved exactly.

## Source and controlled evidence

The [protocol](STREAMING.md) documents actual proofs, capacity/byte bounds, separate liveness clocks, finite retry count, authority and ownership. Commands/log results below identify the tested tree; controlled resource-heavy runs use the repository's prescribed serial package/process scheduling.

- Contract tests strictly reject foreign fields, malformed/bounded identifiers, unsafe sequences, noncanonical/oversized base64 and excessive snapshot sizes. The optional status survives snapshot projection. Foundation checks retain saved Create/Send/Stop/recovery bytes and browser/private graph boundaries.
- Production server + public remote client tests prove network-only capability advertisement, zero recurring `getChat`, replacement publication, generation/close fences, 64-observer admission on both client and raw server paths, ordinary RPC availability at stream capacity and subsequent slot reuse.
- Tamper, wrong HMAC domain/reflection, old establishment replay, exact repeated frame, wrong target/generation, missing/reordered sequence publish no offending snapshot. Challenges cannot be reflected into RPC or reused after stream establishment. Existing transport tests retain real challenge expiry, shared grant capacity and unchanged mutation uncertainty/proofs.
- Escaped 32-row snapshots span multiple content frames and reconstruct exactly. Incremental decoder tests split headers/body/proofs into seven-byte reads and coalesce complete frames; the remote adapter also authenticates deliberately fragmented/coalesced snapshot/heartbeat bytes. Whole-frame size includes the four-byte length and 32-byte proof; oversized prefixes reject before allocation. Each fragment is at most 32 KiB decoded.
- A 1,000-replacement burst coalesces to current state with fewer than ten publications. A controlled `write(false)` writer stalls and releases within its drain deadline while ordinary RPC remains available. Independent client/server capacity guards reject excess subscriptions.
- Liveness tests selectively scale the existing 20/30-second timeout constants to 40 ms, keeping production constants unchanged; signed heartbeats are scaled from 10 seconds to 10 ms. They prove establishment/initial snapshot expiry, separate established idle expiry, verified-heartbeat liveness and blocked-drain release. These are controlled deadline-logic checks, not real elapsed 20/30-second qualification of the new stream. The unchanged RPC suite separately waits through actual 20-second grant expiry.
- Snapshot/disconnect loops stop after four total attempts despite a successful snapshot on every attempt. Reconnecting status retains stale evidence; successful resynchronization supplies a fresh boundary. There is no polling downgrade or mutation replay. Independent reader-release failures terminate observably instead of being discarded by a retry.
- Closing a held network reader promptly releases the server watch and fences later updates. A real temporary Pi capture deliberately held after its SDK transaction remains root-owned after network/listener close; unrelated Create stays usable, root disposal waits, then succeeds only after actual SDK settlement.
- `tests/chat/stream-host.mjs` uses a real temporary Pi process and controlled forwarding. First thinking/text pauses behind an explicit next-chunk gate; five revisions appear before held completion is released, then exactly one final entry replaces the live run with a new committed boundary; unchanged history scans/entry hydration/status inspections stay constant, B causes no A publication/read, capable observation issues zero `getChat`, and exact Stop responds independently. `tool-host.mjs` separately publishes tool progress before held execution ends. Watch counters return to zero.
- Desktop browser bridge tests preserve reconnecting status and exact document release fences; existing application/desktop cancellation, target switching, scopes and saved-data tests remain required. No new controller reconnect engine or renderer endpoint authority is introduced.
- The compiled remote adapter's actual esbuild graph still contains only `remote.ts`, `protocol.ts`, `validation.ts` from Pi runtime, without SDK/provider/SQLite. Its existing Electron 45.1.0 / Node 24.22.1 process test now establishes and closes an authenticated stream against the separate Node 26 host before ordinary mutation/receipt checks.

## Checks before final prerequisite rebase

At the original #123 implementation tree (`04c92ef`, production code unchanged from `398852c`) on prerequisite `399aafb`, before the combined #109/#122 rebase:

| Command | Result |
| --- | --- |
| `bun install --frozen-lockfile` | Pass, 570 packages; lockfile unchanged |
| Initial combined transcript/observation tests, serial | Pass, 25 before coding |
| Combined transcript/observation tests after `008984d`, serial | Pass, 32 |
| `node --experimental-strip-types --test --test-timeout=15000 packages/pi-runtime/test/stream.test.ts` | Pass, 25 |
| `NX_DAEMON=false bun run check:foundation` | Pass; baseline bytes, ownership/exports and 278-input browser consumer |
| `NX_DAEMON=false NX_SKIP_NX_CACHE=true bun run typecheck` | Pass, 8 tasks, cache skipped |
| `bun run lint`, `bun run format:check`, `git diff --check` | Pass |
| `NX_DAEMON=false NX_SKIP_NX_CACHE=true bun run test --output-style=static` | Pass, repository script + all 8 package tasks, 777 tests total; cache skipped |
| `bun run test:chat-integration` | Pass, 10; run serially after root/resource-heavy work |

The full root run includes the controlled Electron Node24 stream/graph check, 157 Pi tests and 55 desktop tests. Logs are `/tmp/stream123-*.log`. The completion-boundary assertion was then strengthened in the controlled integration suite and is verified separately from root package tests.

## Fresh review corrections on the combined base

The review of original `04c92ef` identified two remote-observation defects. Both corrections are separate commits above rebased implementation `2912bd6`; they do not change the approved #109/#122 source or tests.

- **P1**, **`491600b2ddba5a11d9951e5c2788d3fdc62c409e`**: failed queues drain pending values, so enqueue-time authority checks were insufficient for a held public `ChatService.watch` consumer. The returned service stream now rechecks its captured generation at dequeue/publication. A controlled public service test waits until a second authenticated replacement is buffered, replaces the connection, then releases the first consumer. Before the fix it received two snapshots, including old-generation content after replacement; after the fix it receives only the initial snapshot and `Unavailable`, and server watch resources release. The test synchronizes through public transport readers and the supplied connection port, without application selection epochs or private queue access.
- **P2**, **`d9aeb23dda6d062ad3608f24e478930dfa32acfb`**: stale marking previously followed the terminal/exhaustion branch. The adapter now marks retained verified content `reconnecting` after an in-generation failure and before retry or terminal error delivery. A failed generation check fences this update; combined failures retain the original cause. The four-attempt EOF regression failed with final `connected` before the fix and passes with final stale `reconnecting`, unchanged target/boundary, one terminal error and complete listener release. A repeated-frame terminal failure similarly retains only the verified content as stale while reporting `Incompatible`; independent reader cleanup failures remain observable. Existing status types and watch signatures are unchanged. #110 combines stale snapshot status with terminal `onError` to distinguish exhausted/permanent failure from active retry.

The corrected implementation tested below is **`d9aeb23dda6d062ad3608f24e478930dfa32acfb`**, based on **`ff26094b077fd03295518d31bdfccad1a2f8a000`**. The subsequent qualification commit changes only this evidence file. The earlier patch-equality proof applies to the initial rebase at `2912bd6`; the two reviewed corrections are explicit subsequent deltas.

## Final qualification after corrections

The following checks ran on corrected code head `d9aeb23dda6d062ad3608f24e478930dfa32acfb` over final prerequisite base `ff26094b077fd03295518d31bdfccad1a2f8a000`. Resource-heavy runs were serial: focused Pi suites, then the full root suite, then cross-process chat integration. No assertion, deadline or runtime setting was weakened.

| Command | Result |
| --- | --- |
| `node --experimental-strip-types --test --test-concurrency=1 --test-timeout=30000 packages/pi-runtime/test/{history,lifecycle,observation,transcript,stream}.test.ts` | Pass, **86**, including all 60 upstream focused cases and 26 stream cases |
| `NX_DAEMON=false bun run check:foundation` | Pass; unchanged baseline bytes, ownership/exports and 278-input browser consumer |
| `NX_DAEMON=false NX_SKIP_NX_CACHE=true bun run typecheck` | Pass, all **8** tasks, cache skipped |
| `bun run lint`, `bun run format:check`, `git diff --check` | Pass |
| `NX_DAEMON=false NX_SKIP_NX_CACHE=true bun run test --output-style=static` | Pass, repository script + all **8** package tasks, **783** tests total; cache skipped |
| `bun run test:chat-integration` | Pass, **10** controlled process/forwarding tests |

The final root run includes **163 Pi tests**, the compiled Electron Node24 remote stream/graph check, embedded-local Electron qualification, 68 contract tests, 300 application tests and 55 desktop tests. The process suite still sees first thinking/text before the explicit next-chunk gate opens and before completion, exact final boundary replacement, zero recurring capable-host `getChat`, unchanged progress-only history/status reads, no A publication/read from B, independent exact Stop and complete watch cleanup. Public watch signatures, DTO identities and legacy polling/mutation/health behavior remain unchanged.

Logs: `/tmp/stream123-corrected-{focused,foundation,typecheck,root,integration}.log`; reviewer-regression red/green evidence: `/tmp/stream123-p1-{red,green}.log` and `/tmp/stream123-p2-{red,green}.log`.

One earlier full run at the rebased implementation failed only the existing embedded-local Electron fixture with its generic `Embedded local qualification failed` message. The original unchanged fixture then passed **six isolated runs**, and the final uncached root run passed it as well. The failure was not reproduced in isolation and no unrelated production/test workaround was added; its cause remains unqualified. The remote Electron stream/graph test passed in both full runs. Earlier failure log: `/tmp/stream123-rebase-root.log`.

## Limits

No dev/foreground app, real SSH host, provider quota, legacy state, PR, deployment or merge was used. Controlled Electron Node-mode/process tests are distinct from native foreground or packaged execution. This ticket does not qualify shipped UI, packaged artifacts/notices, real provider/SSH performance, accessibility, physical durability or Intel behavior. SDK materialization/inspection limits remain explicit in [local observation](OBSERVATION.md). #110 owns reconnecting presentation, hydration/navigation and stale live Copy decisions; existing watch signatures remain intact.
