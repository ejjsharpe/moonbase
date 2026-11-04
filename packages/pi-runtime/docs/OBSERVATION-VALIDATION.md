# #122 observation qualification

Checked on 2026-11-04, macOS arm64, Node `v26.13.0`, Bun `1.4.4`, with unchanged Pi Durable/AI/Chord `1.4.0` dependencies and lockfile.

## Checkout and dependency

- Checkout: `/Users/elliotsharpe/.t3/worktrees/moonbase/t3-ea938d59`.
- Clean starting commit: main `1bb0ad0917ffb1bdd08f06cadec416354ac680a4`.
- Generated branch `t3/chat-observation-122` renamed to `feat/chat-observation-122`.
- Requested #109 prerequisite `d6e297affa9fe035592ea91e2c2e6402c648496d` was initially cherry-picked as `e869be8be12cdc1b79b9cacc4942d3af72039a56`. After the parent's final handoff, only the two #122 commits were rebased with `git rebase --onto 467acb877591b00b1a257ceb8aea258c12dfb9f5 e869be8be12cdc1b79b9cacc4942d3af72039a56 feat/chat-observation-122`; the duplicate prerequisite was dropped. The **current #122 diff base is `467acb877591b00b1a257ceb8aea258c12dfb9f5`**. No unrelated dirty work was present or removed; the #109 checkout was not changed.
- Original #122 implementation `a146b4abc820439e7f043585d62802662d3cbabc` rebased to `0e30fa7f520f846a98a569a5e3d73cd107e78c69`; starvation correction `008984dbf5c3a17bbe5e2fad4f25a7d7daa3bdbb` rebased to `07cc585820f0ce1bb86a958d86a198d4bf855e94`. Use either correction identity for propagation, not both.
- Current #108 and #122 bodies were read using `gh issue view`; root/module/architecture/lifecycle guidance and the #109 transcript handoff were read before implementation.

The integrated dependency includes the separately owned #109 retained nested-call results (`2e588d7e9cd894881b336a6dc7affb97027bbcf5`), argument evidence (`1280dbba3b8c7d7a2058da8091683f4e2b398013`) and bounded retirement recapture (`467acb877591b00b1a257ceb8aea258c12dfb9f5`). They were not reimplemented here. Rebase conflict resolution only preserved both required transcript type imports; capture, status inspection and history projection remained wholly inside `projectSnapshotOnce`, so each retry uses fresh capture/control evidence and the appropriate bounded cache state.

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

No foreground/dev application, standalone desktop build, packaged/native UI acceptance, real provider quota, real SSH host, legacy-state import/deletion, deployment or PR operation was used. The root suite's controlled Electron Node-mode checks do not qualify native interaction. Manual accessibility, physical performance/durability and Intel behavior remain untested. Independent approval of the final combined head remains a separate parent-owned review.

## Independent review correction: steady progress

Independent #122 review requested changes to `a146b4a`: fencing every relevant commit could discard every in-flight projection when progress commits outpaced projection. The new public embedded-provider regression reproduced **zero** intermediate text publications on that head with 175 ms latency after capture settlement, 25 updates at 110 ms intervals, and immediate completion after the last update. It emits independently of observation acknowledgments. `/tmp/observation122-steady-red.log` records the failure; `/tmp/observation122-steady-green.log` records the corrected test passing.

The correction retains the one-slot queue and fences only unsafe invalidations. A whitelist of public LiveDoc progress paths permits publication of an older coherent progress capture while a replacement stays queued; source/control/authority/history changes, unknown operations and document lifecycle changes retain the fence. Six additional held-capture regressions cover exact attempt changes, tool membership, retained history, metadata retirement, valid foreign Store authority and same-commit LiveDoc replacement. They verify that no stale capture publishes across those invalidations. Existing completion, scheduler status, Stop, subscription and held SDK-settlement cases remain in the suite.

`node --experimental-strip-types --test --test-timeout=20000 packages/pi-runtime/test/observation.test.ts` passed all **22** tests after the standalone correction, and Pi typechecking passed. The final combined qualification is recorded below.

## Combined retirement integration

After rebasing onto `467acb8`, a new regression confirmed the nontrivial integration edge: three confirmed retirement attempts could fail after an unsafe revision had already superseded the observation and queued replacement. The watch ended with `NestedSourceRetired`. `/tmp/observation122-integration-red.log` records this failure and the companion ordinary-error case passing.

The #122 integration correction suppresses only that private failure when the outer unsafe revision changed, consuming the existing one-slot refresh. No new retry engine is introduced, #109's three-attempt limit is unchanged, and ordinary `Conflict`, validation/storage/authority failures and explicit selections retain their error behavior. Public capture instrumentation verifies all attempts execute: the failed original boundary is followed by three fresh captures of the winning boundary (two bounded retries and the queued replacement). Only the final coherent source/history view publishes. An ordinary nested read `Conflict` after an unsafe invalidation still fails once without retry or publication.

The combined focused command passed **60 tests** with zero skips/failures:

```sh
node --experimental-strip-types --test --test-timeout=30000 packages/pi-runtime/test/observation.test.ts packages/pi-runtime/test/history.test.ts packages/pi-runtime/test/lifecycle.test.ts packages/pi-runtime/test/transcript.test.ts
```

This includes the original retained nested output/patch/diagnostic and requested/executed argument tests; real held retirement with explicit content conflict and continued follow-up observation; malformed/missing/ordinary error propagation and the three-attempt cap; observation/root disposal through held nested SDK settlement; all 22 observation cases, coherent capture/recovery, exact Stop and unrelated conversations. `/tmp/observation122-combined-focused.log` records the complete run.

Final combined source/controlled results, with every production/test integration change present:

| Exact command | Result |
| --- | --- |
| `bun run --cwd packages/pi-runtime typecheck` | Pass |
| Focused four-file command above | Pass, **60** tests, zero skipped/failed |
| `NX_DAEMON=false bun run check:foundation` | Pass, fresh graph/browser/baseline saved-byte checks |
| `NX_DAEMON=false bun run typecheck` | Pass, 8 tasks; unchanged 7 tasks cached, Pi executed |
| `bun run lint` | Pass |
| `bun run format:check` | Pass |
| `NX_DAEMON=false NX_SKIP_NX_CACHE=true bun run test` | Pass, script test and all **8 package tasks**, cache disabled; package suites serialized |
| `bun run test:chat-integration` | Pass, **8** tests; ran after the full root suite |
| `git diff --check` | Pass |
| `git diff --exit-code 467acb877591b00b1a257ceb8aea258c12dfb9f5 -- bun.lock` | Pass, dependency lockfile unchanged |

Logs use `/tmp/observation122-combined-{focused,foundation,typecheck,lint,format,test,chat-integration}.log`. `git range-diff` confirms the starvation correction is unchanged by rebase; the baseline's only patch-context changes are the new `projectSnapshotOnce` function and preserved #109 transcript imports. The separate #122 integration commit adds the narrow watch fence/error handling plus two public regressions and these owning docs; it requires corrected #109 `467acb8`. A #123 checkout that already has baseline #122 should propagate the starvation correction once (`008984d` or rebased `07cc585`) and the separate integration correction, without reapplying the baseline.

These are source and controlled runtime/transport results. They do not claim independent review approval, native/packaged/manual acceptance, real provider/SSH qualification, physical durability or hard SDK memory/latency bounds.
