# Controlled editor snapshot measurements

Snapshot publication copies plain DTO containers in ordinary TypeScript and shares immutable string values. There is no snapshot cache or mutation-site invalidation scheme. Buffers, recovery drafts, pending Save requests, close prompts, operation facts and nested comparison/discovery data remain detached from model state and later publications.

Run from the repository root with the frozen workspace dependencies:

```sh
node packages/application/scripts/measure-editor-snapshots.mjs
```

The harness asserts that application imports resolve inside its own checkout. It uses public application/client APIs and `memoryWorkspace`, disables observations, opens kept buffers, selects the edited file, and awaits application/runtime disposal. Each case runs twice with 25 fixed-length edits and position updates, discarding the first five samples. Iterations yield to separate event-loop tasks so timer cancellation can settle. Assertions check final text/count, notification count, retained snapshots, synchronous publication behavior and confirmed recovery readiness. Restored cases persist dirty drafts, dispose, and reacquire the same recovery identity before measuring. Cases cover 1 × 4 KiB, 1, 10 and 20 × 512 KiB buffers, a 4 KiB active buffer beside 19 × 512 KiB buffers, and 20 × 512 KiB buffers with restored dirty drafts. The harness emits JSON lines with median/max milliseconds; there are no wall-clock CI assertions.

To compare implementations, run the same harness against each in an isolated checkout with the same workload, runtime and dependencies. Machine load, JIT, allocation and GC affect individual timings and maxima. The harness measures synchronous headless publication work, not visible desktop typing latency. Copying metadata still scales with DTO/container count, and UTF-8 byte validation still scales with active text size. Large-string copies during recovery capture/persistence are outside this path.

`test/editor-snapshots.test.ts` exercises the public snapshot/controller interface for consumer mutation isolation, including nested comparison/discovery data, stable retained snapshots and fresh publications after edits, positions, disk/conflict updates, close prompts, restored drafts and uncertain Save/move reconciliation. React/Monaco, native/package execution, filesystem watchers and real SSH/providers are not measured.
