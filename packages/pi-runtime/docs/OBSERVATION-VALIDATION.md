# #122 observation qualification

Checked on 2026-11-04, macOS arm64, Node `v26.13.0`, Bun `1.4.4`, with unchanged Pi Durable/AI/Chord `1.4.0` dependencies and lockfile.

## Checkout and dependency

- Checkout: `/Users/elliotsharpe/.t3/worktrees/moonbase/t3-ea938d59`.
- Clean starting commit: main `1bb0ad0917ffb1bdd08f06cadec416354ac680a4`.
- Generated branch `t3/chat-observation-122` renamed to `feat/chat-observation-122`.
- Requested #109 prerequisite `d6e297affa9fe035592ea91e2c2e6402c648496d` cherry-picked as **`e869be8be12cdc1b79b9cacc4942d3af72039a56`**. This is the #122 diff base. No unrelated dirty work was present or removed.
- Current #108 and #122 bodies were read using `gh issue view`; root/module/architecture/lifecycle guidance and the #109 transcript handoff were read before implementation.

The parent owns the separately reviewed #109 nested-call retention/requested-argument corrections. They were not reimplemented here. The observation filter includes public NestedCallDoc changes so the forthcoming exact capture can participate without a new watch interface. Their correction SHA must be propagated separately when available; this qualification does not claim to fix those known prerequisite defects.

## Checks

The following table records the initial `a146b4abc820439e7f043585d62802662d3cbabc` implementation; the subsequent review correction is recorded below. Commands ran from the repository root. Package/resource-heavy suites ran serially, using each package's existing internal concurrency. Logs in this environment use `/tmp/observation122-*.log`.

| Command | Result |
| --- | --- |
| `bun install --frozen-lockfile` | Pass, 570 packages; lockfile unchanged |
| `bun run --cwd packages/pi-runtime typecheck` | Pass |
| `node --experimental-strip-types --test --test-timeout=30000 packages/pi-runtime/test/observation.test.ts` | Pass, 15 tests; final strengthened assertions included |
| `node --experimental-strip-types --test packages/pi-runtime/test/history.test.ts packages/pi-runtime/test/lifecycle.test.ts packages/pi-runtime/test/transcript.test.ts` | Pass, 30 existing focused tests |
| `NX_DAEMON=false bun run check:foundation` | Pass; public graph/export/cycle checks, browser consumers and exact baseline saved chat/recovery/Send/Stop bytes |
| `NX_DAEMON=false bun run typecheck` | Pass, 8 tasks |
| `bun run lint` | Pass |
| `NX_DAEMON=false bun run test` | Pass, repository script test and all 8 package tasks, **zero cache hits** |
| `bun run test:chat-integration` | Pass, 8 controlled child-host/forwarding tests |
| `bun run format:check` | Pass |
| `git diff --check` | Pass |

All production changes were present in the full root run. Afterwards, two observation assertions were strengthened (a 64-commit unrelated B burst and exact retained content for the final slow-consumer revision); all 15 focused tests were rerun. Source checks were repeated for the final files. No deadlines or assertions were weakened.

## Controlled evidence

`test/observation.test.ts` uses newly created real temporary Pi SQLite stores and public runtime/client/SDK interfaces. It instruments public `snapshot`, `commit`/`scanEntries`/`entry`, `inspect` and subscription boundaries, without reading scheduler internals.

- A controlled provider supplies text plus thinking through the embedded `LocalPiRuntimeLive` layer, pauses before completion, then supplies four additional progress revisions. The public watch sees the first text/thinking while completion is held. Those four live-only updates add **zero retained-history scans, entry hydrations or whole-session inspections**. Exact live source and committed boundary stay stable.
- While A remains held, B completes provider work and appends **64** further committed records. A adds **zero metadata/snapshot reads, history scans/hydrations, status inspections or publications**.
- A real controlled tool publishes output while execution is held, then three more progress updates. The watch sees each; unchanged history is not scanned and the whole-session inspection count does not increase. Completion refreshes retained entries.
- Initial listeners exist before a deliberately held capture. Completion during that hold supersedes the initial capture; only the coherent final replacement publishes. Same-attempt Harness reopen retains its committed interrupted partial, exact task/attempt and a different live incarnation. A scheduler-finalized partial without `byTaskId` is retained without leaking its private fault or mixing it with the preceding live view.
- Restart-limit cases use actual public inspection and Harness reopen, with public persisted task counters seeded in the temporary store: limit **1** at count **1** parks; limit **8** at count **5** runs. The test explicitly invokes Pi retry only for the parked case. These simulate crash counters; they are not process-crash or physical-durability qualification.
- Public custom task fixtures cover `missing_task`, migration failure **without a commit**, registry replacement/unblocking and terminal settlement. No provider call or inferred Retry/Stop is introduced; migration diagnostics stay private. The remaining supported blocked enum (`task_too_old`) follows the same inspected-reason projection, without a separate fixture.
- A held Effect stream consumer sees one initial snapshot while **220** updates commit. On release, exactly one further capture supplies the latest replacement. An exact public content read verifies revision 219, rather than merely matching the clipped preview. The response remains below 256 KiB. Another conversation can be created and exact Stop returns its bounded result independently.
- Eight real held tools grow escaped output against 50 seeded retained records. The outgoing page shrinks inside the serialized bound with **zero additional history scans**; continuing its older cursor visits every exact stored entry once. A reset marker refreshes the selected window while preserving earlier entries.
- Metadata authority changes, LiveDoc retirement, SDK session close and injected real-storage failure terminate safely, release subscriptions and publish no foreign/late data. Retirement does not recreate LiveDoc. The existing lifecycle suite retains the 64-observer limit and failing-unsubscribe evidence.
- Closing a deliberately held SDK observation releases listeners and fences client delivery. Root disposal remains pending until that SDK Promise is actually released; storage is not closed early. Existing lifecycle/Stop tests retain admission, late abort/waiter failure and local activity inspection behavior.

The full root and chat-integration runs retain legacy remote polling, authenticated RPC identity/error checks, lost mutation receipts, unchanged saved-data fixtures, cancellation, local activity inspection and restart/recovery. No remote stream capability is advertised.

## Limits and next owner

The [selected API, byte/subscription budgets and #123 handoff](OBSERVATION.md) distinguish independently replaceable snapshots from event delivery, watch-close finalizers from root SDK settlement, and transport bounds from SDK document/inspection allocations. #123 must consume supplied `client.watch` without per-update reads and enforce its actual authenticated framed-byte budget; it owns network advertisement, proof/framing, reconnect and status.

No foreground/dev application, standalone desktop build, packaged/native UI acceptance, real provider quota, real SSH host, legacy-state import/deletion, deployment or PR operation was used. The root suite's controlled Electron Node-mode checks do not qualify native interaction. Manual accessibility, physical performance/durability and Intel behavior remain untested. The separately owned #109 corrections still require propagation and affected-check reruns.

## Independent review correction: steady progress

Independent #122 review requested changes to `a146b4a`: fencing every relevant commit could discard every in-flight projection when progress commits outpaced projection. The new public embedded-provider regression reproduced **zero** intermediate text publications on that head with 175 ms latency after capture settlement, 25 updates at 110 ms intervals, and immediate completion after the last update. It emits independently of observation acknowledgments. `/tmp/observation122-steady-red.log` records the failure; `/tmp/observation122-steady-green.log` records the corrected test passing.

The correction retains the one-slot queue and fences only unsafe invalidations. A whitelist of public LiveDoc progress paths permits publication of an older coherent progress capture while a replacement stays queued; source/control/authority/history changes, unknown operations and document lifecycle changes retain the fence. Six additional held-capture regressions cover exact attempt changes, tool membership, retained history, metadata retirement, valid foreign Store authority and same-commit LiveDoc replacement. They verify that no stale capture publishes across those invalidations. Existing completion, scheduler status, Stop, subscription and held SDK-settlement cases remain in the suite.

`node --experimental-strip-types --test --test-timeout=20000 packages/pi-runtime/test/observation.test.ts` passes all **22** tests after the correction, and Pi typechecking passes. Combined final-tree qualification is pending the separately owned #109 retirement fix and rebase; this local correction does not duplicate its bounded recapture retry or claim its regressions passed yet.
