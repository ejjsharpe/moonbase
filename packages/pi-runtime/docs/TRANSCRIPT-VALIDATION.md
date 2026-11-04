# TR-01 transcript read qualification

Implementation base: `main` at `e122d40c41ab247bc7b616cace110c74e629eccd`. Checks ran on macOS arm64, Node `v26.13.0`, Bun `1.4.4`, with the pinned Pi Durable/AI `1.4.0`. No dependency/lockfile changes, real provider calls, real SSH hosts, legacy user stores, dev apps, deployment or PR operations were used.

The installed public SDK declarations and implementation were inspected: `EntryRecord`, inclusive `EntryQuery` bounds, `LiveDoc`/`LiveState`, `ToolTaskInput`, `ToolTaskCheckpoint`, generation recovery and scheduler partial finalization. Tool task input retains its assistant/call attribution after settlement; the terminal record does not retain the executed-arguments checkpoint. The projection therefore exposes executed arguments only where that public evidence exists.

## Commands and results

Commands are from the repository root. Final source/controlled checks passed; logs are under `/tmp/transcripts109-*.log` in the implementation environment. Source and controlled runtime evidence are separate from native/packaged/manual qualification.

| Exact command | Result |
| --- | --- |
| `bun install --frozen-lockfile` | Pass; 570 installed packages, lockfile unchanged |
| `bun run --cwd packages/contracts typecheck` | Pass |
| `bun run --cwd packages/pi-runtime typecheck` | Pass |
| `NX_DAEMON=false bun run typecheck` | Pass, 8 tasks |
| `bun run check:foundation` | Pass; module/export/cycle/browser graph checks and exact baseline saved chat/recovery/Send/Stop bytes |
| `bun run --cwd packages/contracts test` | Pass, 67 tests, including browser schema exports and strict decoded chunk bounds |
| `bun run --cwd packages/application test` | Pass, 300 tests, including shared dispatch, cancellation, lifecycle and portable runtime graphs |
| `bun run --cwd packages/pi-runtime test` | Pass, 107 tests, including local, history, lifecycle, transport, real temporary SQLite, child hosts and the compiled remote adapter's Electron Node-mode check |
| `node --experimental-strip-types --test packages/pi-runtime/test/history.test.ts packages/pi-runtime/test/transcript.test.ts` | Pass, 12 focused projection/consistency tests after final projection cleanup |
| `node --experimental-strip-types --test apps/desktop/test/chat-session.test.ts` | Pass, 12 tests; nested source authority and existing document/cancellation behavior |
| `bun run test:chat-integration` | Pass, 8 tests; real child host and synthetic forwarding processes |
| `bun run lint` | Pass |
| `bun run format:check` | Pass |
| `git diff --check` | Pass |

Pi and cross-process chat integration suites were run serially for final qualification. Earlier targeted runs exposed test-fixture gating issues, which were corrected before the passing full runs; no assertion/deadline was weakened.

## Covered behavior

`test/transcript.test.ts` exercises all manifest/chunk continuations and exact reconstruction of 1,100 durable entries, more than 32 ordered blocks, multi-megabyte escaped Unicode/text/JSON/patch/details and stored binary image bytes. Pages remain within 32 rows and 256 KiB serialized envelopes; chunks remain within 32 KiB decoded bytes. Reset markers do not hide pre-marker entries. Both around-entry continuations traverse the fixed upper snapshot without stranding the anchor or skipping entries.

Negative reads cover host/store/actor/conversation/entry/part/revision/cursor mismatch and tampering. Tests retain thinking redaction without signatures, published failed results/details, reused tool IDs across assistant entries, ambiguous duplicates in one assistant entry, requested versus hook-modified executed arguments, dropped live tail evidence and restart-retained interrupted output/patches.

Held-read tests separate an older coherent live/history capture from ordinary completion and an unattributed scheduler-finalized partial. Actual Harness restart reuses the same task/attempt while committing the preceding partial, but gets a new live incarnation. Live content chunks revalidate before publication; fixed prefixes allow later appends and reject replacement/finalization. Caller cancellation releases the caller promptly, while root disposal waits for actual held SDK Promise settlement. Stop and another conversation remain responsive.

Transport tests reject authenticated source/selection/cursor/anchor substitution, preserve legacy feature-absent replies and retain existing mutation uncertainty. Cross-process integration covers named lost/tampered response bytes, held reads, cancellation, generation replacement/reconnect, both new operations, wrong identities, exact Stop and an unrelated conversation. Reads never introduce another Send.

## Base-version interoperability experiment

A separate controlled experiment extracted the exact base source, without modifying this checkout or accessing user state:

```sh
mkdir -p test-results/transcript-109/legacy
zsh -c 'set -o pipefail; git archive e122d40 packages/contracts/src packages/pi-runtime/src | tar -x -C test-results/transcript-109/legacy'
ln -s "$PWD/packages/pi-runtime/node_modules" test-results/transcript-109/legacy/packages/pi-runtime/node_modules
node --experimental-strip-types test-results/transcript-109/check-legacy.mjs
```

The ignored experiment directory also contains a module-type manifest and `check-legacy.mjs`, which composes only public runtime/server/client/SDK APIs against a newly created temporary SQLite store. `legacy-check.log` records:

- Exact base host + new remote client: all eight legacy operations pass, with no transcript feature advertised.
- New host + exact base input/output codec: all eight legacy operations pass; the old decoder projects away the additive fields.
- The new runtime reopens the temporary base-produced store and reads structured retained content without migration.

This qualifies source/runtime/protocol compatibility using the installed pinned SDK, rather than an old packaged desktop executable.

## Limits and downstream handoff

The exact portable DTO/read/cursor/live-Copy/navigation contract is [TRANSCRIPTS.md](../../contracts/docs/TRANSCRIPTS.md). TR-02 owns controller windows, caches, view memory and stale publication fences; TR-03 owns native Copy/link authority and presentation. Neither Find nor renderer behavior is supplied here.

Cursor MAC keys are transient: restart an immutable read from its source/entry after host restart. Live finalization without explicit tool-part correspondence requires a coherent reload; text/task/attempt equality is never proof. Complete live Copy must revalidate its fixed selection immediately before the native write and reject newer observed source changes. The public SDK materializes a retained record/document in memory; the new limits bound transport and paging, not the SDK's own record allocation. Multi-megabyte records were exercised, without claiming physical performance qualification.

Full root `bun run test`, editor integration, desktop build/browser/native/package suites, old packaged executable compatibility, manual accessibility/performance, physical durability, Intel and real SSH/provider qualification were not run. They remain integrated-epic qualification; the focused desktop check here is a source test, not native IPC execution. SDK omission/redaction and unavailable media remain explicit, and no spill/current-file recovery is attempted.

## Independent review correction: retained nested results (P1)

Review base: rebased implementation `d6e297affa9fe035592ea91e2c2e6402c648496d` atop `main` `1bb0ad0`. The reviewer correctly found that Pi clears nested-slot progress at settlement; the complete result remains in the parent's public `NestedCallDoc` while that owner is live.

The projection now reads that exact document using the validated child task's parent/key. It checks child/parent conversation ownership, task ownership, original call identity, the document's child task ID and the result's task ID before normalizing retained text, ordered media, program JSON, details/patch/diff and diagnostics. Missing results are explicit unavailable activity; retired sources return `Conflict`, and mismatched retained identities fail without content. It uses the existing bounded read/source revalidation and SDK Promise ownership; no new port, store, admission or lifecycle behavior is introduced.

The public regression first failed with an available completed result containing zero bytes. After the fix it passes against temporary real Pi SQLite: the parent stays running after children finish, including a `progress: false` child; public content paging reconstructs the retained output/patch/diff/diagnostics, ordered image/text and empty program JSON. Tampered index/result IDs and a wrong conversation reject, and the captured live source becomes invalid after the parent ends.

Checks for this correction:

- `bun run --cwd packages/pi-runtime typecheck` — pass.
- `bun run --cwd packages/pi-runtime lint` — pass.
- `node --experimental-strip-types --test --test-name-pattern='completed nested results' packages/pi-runtime/test/transcript.test.ts` — pass, 1 test.
- `git diff --check` — pass.

This is source/controlled SDK evidence. Native/build/package/manual and real provider/SSH checks were not run for the correction.

## Independent review correction: nested argument evidence (P2)

Follow-up to the P1 correction `2e588d7e9cd894881b336a6dc7affb97027bbcf5`, still based on reviewed head `d6e297affa9fe035592ea91e2c2e6402c648496d`. Both pending-hook regressions first failed because requested slot arguments were labeled executed.

Nested requests now expose immutable `ToolTaskInput.call.arguments` as `arguments`. An additional `executed-arguments` part requires a running public execute checkpoint. Once the terminal task has discarded its checkpoint, the public retained result's `durationMs` supplies execution evidence and the slot supplies the final executed arguments. Pi documents `durationMs` as absent when execution never occurred; pending/blocked calls therefore make no executed-input claim. Modified inputs retain both requested and executed values. Interrupted or unavailable evidence is not guessed.

The public controlled regressions hold the child's `beforeTool` hook, then either block execution or change its actual arguments. They verify pending, running, settled and blocked states, including the unchanged requested value, the actual value observed inside `execute`, no executed label on a blocked request, retained block diagnostics and invalidation of the preceding source. The combined correction also keeps non-content program JSON fields inert instead of dropping them through text/image shape recognition, and normalizes large nested results in cancellable slices. No DTO, service, transport, mutation or saved-format changes were needed.

Final combined correction checks (Node `v26.13.0`, Bun `1.4.4`):

| Exact command | Result |
| --- | --- |
| `bun run --cwd packages/pi-runtime typecheck` | Pass |
| `NX_DAEMON=false bun run typecheck` | Pass, 8 tasks |
| `bun run check:foundation` | Pass, browser/module boundaries and unchanged saved bytes |
| `node --experimental-strip-types --test packages/contracts/test/chat-schema.test.ts packages/pi-runtime/test/history.test.ts packages/pi-runtime/test/transcript.test.ts apps/desktop/test/chat-session.test.ts` | Pass, 55 tests including all three new nested regressions |
| `node --experimental-strip-types --test packages/pi-runtime/test/transport.test.ts` | Pass, 40 tests |
| `bun run test:chat-integration` | Pass, 8 controlled cross-process tests |
| `bun run lint` | Pass |
| `bun run format:check` | Pass |
| `git diff --check` | Pass |

Logs are in the implementation checkout's ignored `test-results/transcript-109/review-fixes/`. The parent separately reported desktop build and renderer checks passing on rebased head `d6e297a`; those checks were not rerun for these corrections. No app was launched, PR opened, review delegated, real provider/SSH used, legacy data accessed or deployment performed. Full root/Pi suites, native/package/manual and physical performance checks were not repeated for the corrections. SDK-owned nested documents still retire with their parent; reads cannot recover data Pi no longer retains.

## Round 2 correction: nested retirement during snapshot projection

Reviewed base: `1280dbba3b8c7d7a2058da8091683f4e2b398013`. The fresh review correctly reproduced a normal parent completion retiring `NestedCallDoc` after the live capture but before its separate read, allowing `Conflict` to terminate `Host.watch` without a publication.

The projection now distinguishes confirmed owner retirement with a private `NestedSourceRetired` application error. A missing document alone is insufficient: a fresh SDK read must confirm the matching parent is completing/terminal. Only snapshot reads handle that signal, with at most three full capture/projection attempts. Each attempt obtains a new committed history boundary and live/control state. Ordinary `Conflict`, a missing active document, malformed/cross-authority data, storage errors and unknown failures are not retried. Exhaustion remains a visible `Conflict`. Explicit manifest/content selections are never silently retargeted or recaptured.

The new held-read regression failed before the fix with zero snapshots and an observation `Conflict`. It now verifies that a real temporary Pi SQLite parent finishes while both observation projection and an explicit content read are held: observation publishes the fresh final idle history and remains active for a subsequent Send, while the explicit content selection fails source-changed. Additional public probes verify one attempt for six non-retirement failures, three attempts for persistent confirmed retirement, no read-triggered Send, and no late delivery or early Harness closure when observation close/root disposal occurs during an unsettled SDK read.

The existing `Host.run` ownership, SDK Promise settlement, admission and observation cleanup paths were inspected and left unchanged. No commands/resources changes, scheduler, protocol/DTO changes or new lifecycle capability were added. No #122 progress-starvation fix is included here.

For #122 integration: the existing private `projectSnapshot` call shape remains unchanged. Its new `projectSnapshotOnce` includes the entire capture and projection; capture/inspection hooks added by #122 must therefore run per attempt, using the successful attempt's source/control/history evidence. If an outer unsafe-control fence predates an internal recapture, a coalesced refresh can discard/re-read that frame; ordinary progress supersession must not be promoted to unsafe invalidation or a blanket retry condition. Do not reuse one frozen capture for every retry. This checkout does not qualify the combined #122 revision.

Round 2 correction checks:

| Exact command | Result |
| --- | --- |
| `bun run --cwd packages/pi-runtime typecheck` | Pass |
| `NX_DAEMON=false bun run typecheck` | Pass, 8 tasks |
| `bun run check:foundation` | Pass, source/browser boundaries and unchanged saved bytes |
| `node --experimental-strip-types --test packages/contracts/test/chat-schema.test.ts packages/pi-runtime/test/history.test.ts packages/pi-runtime/test/transcript.test.ts apps/desktop/test/chat-session.test.ts` | Pass, 58 tests including three new retirement/error/cleanup regressions |
| `node --experimental-strip-types --test packages/pi-runtime/test/lifecycle.test.ts` | Pass, 18 tests |
| `bun run lint` | Pass |
| `bun run format:check` | Pass |
| `git diff --check` | Pass |

Logs are in the implementation checkout's ignored `test-results/transcript-109/retirement-fix/`. These are source and controlled temporary-SDK checks. Transport/cross-process suites, full root/Pi suites, desktop build/renderer/native/package, manual/real provider/SSH and combined #122 checks were not repeated for this narrowly scoped correction; prior results above remain historical evidence. No app, PR, deployment, merge, real provider/SSH, legacy data access or delegated review was used.
