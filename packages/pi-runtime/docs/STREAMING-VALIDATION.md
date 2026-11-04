# #123 remote streaming qualification

Checked on 2026-11-04 in `/Users/elliotsharpe/.t3/worktrees/moonbase/t3-ac64d7c9`, branch `feat/chat-stream-123`, with Node `v26.13.0`, Bun `1.4.4`, pinned Pi Durable/AI/Chord `1.4.0` and unchanged dependencies/lockfile. Current #108/#123 were read through `gh`, along with root/module/architecture/lifecycle and #109/#122 contracts.

## Prerequisites

The checkout began at main `1bb0ad0917ffb1bdd08f06cadec416354ac680a4`. Requested prerequisites were applied in order:

| Upstream commit | This checkout |
| --- | --- |
| `d6e297affa9fe035592ea91e2c2e6402c648496d` (#109) | `092d5b29bc271880f824fa4a9e1df53992fbf3c0` |
| `2e588d7e9cd894881b336a6dc7affb97027bbcf5` (retained nested results) | `dbe07b589f8577b92b6d5684a6fdc4773d3a4304` |
| `1280dbba3b8c7d7a2058da8091683f4e2b398013` (nested execution evidence) | `06832764285f173a5ebf323cff11e10db9abda9b` |
| `a146b4abc820439e7f043585d62802662d3cbabc` (#122) | `132e9d6e04a98156c296e0d3d64ed6c588a162c4` |

`e869be8` was not cherry-picked. The sole integration conflict was the transcript import list: both `ToolTaskCheckpoint` and `EntryId` were retained. There was no substantive #122 integration fix. All **25 combined transcript/observation tests passed before #123 coding** at initial prerequisite base `132e9d6e04a98156c296e0d3d64ed6c588a162c4`.

The supplied #122 sustained-progress correction `008984dbf5c3a17bbe5e2fad4f25a7d7daa3bdbb` was cherry-picked separately as `399aafb7eb193479bf53fca50914da55bae8faa7`; its unsafe-invalidation fences and delayed-capture regression tests remain upstream-owned and unchanged.

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

At #123 commit `398852c` on prerequisite `399aafb` (before the forthcoming combined #109/#122 rebase):

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

## Limits

No dev/foreground app, real SSH host, provider quota, legacy state, PR, deployment or merge was used. Controlled Electron Node-mode/process tests are distinct from native foreground or packaged execution. This ticket does not qualify shipped UI, packaged artifacts/notices, real provider/SSH performance, accessibility, physical durability or Intel behavior. SDK materialization/inspection limits remain explicit in [local observation](OBSERVATION.md). #110 owns reconnecting presentation, hydration/navigation and stale live Copy decisions; existing watch signatures remain intact.
