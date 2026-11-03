# Controlled editor snapshot measurements

Snapshot publication copies plain DTO containers in ordinary TypeScript and shares immutable string values. There is no snapshot cache or mutation-site invalidation scheme. Buffers, recovery drafts, pending Save requests, close prompts, operation facts and nested comparison/discovery data remain detached from model state and later publications. Public interfaces and publication identity behavior are unchanged. Recovery capture, validation, IO and debounce scheduling are unchanged.

Run from the repository root with Node 26.13.0 and the frozen workspace dependencies:

```sh
node packages/application/scripts/measure-editor-snapshots.mjs
```

The harness asserts that application imports resolve inside its own checkout. It uses public application/client APIs and `memoryWorkspace`, disables observations, opens kept buffers, selects the edited file, and awaits application/runtime disposal. Each case runs twice with 25 fixed-length edits and position updates, discarding the first five samples. Iterations yield to separate event-loop tasks so timer cancellation can settle. Assertions check final text/count, notification count, retained snapshots, synchronous publication behavior and confirmed recovery readiness. Restored cases persist dirty drafts, dispose, and reacquire the same recovery identity before measuring. The harness emits JSON lines with median/max milliseconds; there are no wall-clock CI assertions.

Measured on 2026-11-03, macOS arm64, Node v26.13.0. Before is pinned main `94850e015ed8f2b760ea5258eb27b64ccbdd6b04`; after is this change. Values are the range of the two sweep medians, in milliseconds:

| Open buffers | Edit before | Edit after | Position before | Position after |
| --- | --- | --- | --- | --- |
| 1 × 512 KiB | 0.277–0.291 | 0.149–0.161 | 0.156–0.170 | 0.010–0.020 |
| 10 × 512 KiB | 3.114–4.111 | 0.164–0.182 | 2.782–4.231 | 0.030–0.051 |
| 20 × 512 KiB | 7.678–8.270 | 0.159–0.162 | 7.316–7.663 | 0.050–0.052 |
| 1 × 4 KiB | 0.028–0.033 | 0.017–0.028 | 0.020–0.021 | 0.010–0.016 |
| 4 KiB active + 19 × 512 KiB | 6.191–8.694 | 0.057–0.060 | 6.237–9.849 | 0.049–0.051 |
| 20 × 512 KiB with restored dirty drafts | 14.404–19.721 | 0.173–0.235 | 13.880–18.205 | 0.058–0.090 |

To reproduce a baseline, run the same harness with the editor implementation from the pinned main revision in an isolated checkout, then run it with this change. Keep workload/runtime and dependencies fixed. Machine load, JIT, allocation and GC affect individual timings and maxima. These measurements establish reduced synchronous headless publication work, not visible desktop typing latency. Copying metadata still scales with DTO/container count, and UTF-8 byte validation still scales with active text size. Large-string copies during recovery capture/persistence remain outside this optimization.

`test/editor-snapshots.test.ts` exercises the public snapshot/controller interface for consumer mutation isolation, stable retained snapshots and fresh publications after edits, positions, disk/conflict updates, close prompts, restored drafts and uncertain Save/move reconciliation. Its nested comparison/discovery mutation regression fails on the baseline and passes after this change. Existing filename-map, recovery-readiness, receipt and disposal suites retain their checks. React/Monaco, native/package execution, filesystem watchers and real SSH/providers were not measured here.
