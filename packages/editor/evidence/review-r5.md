# Review R5 corrections

Historical response: R6 cleared those reported cases but found a delayed Copy materialization and a dirty restored comparison variant. See the [current R6 response](review-r6.md).

Reviewed head: `4c1e319d810ed4673765a008ae4c7101ee8b9f57`. Exact prerequisite/base remains `8557fdd0d7a71f93a6584c77430e6fde57668580` (`chore/recovery-publication-contract`, #7). Executable/test source: `24954aab6e745ee1830de2a50c10a6ffd118967a`, following main fix `f253774ba3de54cc43fb5cc1be67149ead1aba38`. The next evidence-only commit adds this record, README links and the inspected capture. Stack remains #1 → #2 → #5 → #7 → #4; PR #4 stays **DRAFT** for fresh independent R6.

Only `packages/editor` changed in this round. No root/shared contract, dependency, export, memory-service authority, sibling implementation or runtime boundary changed. The controller remains ordinary per-instance TypeScript, using the shared application handlers/client. No new browser store, workflow engine or global command queue was added.

## R5 responses

1. **P1 in-flight observations bypassing preservation.** The existing fact pipeline now checks the preservation generation and pending publication after the recovery-queue wait, recovery load, operation/copy IO, publication and acknowledgement awaits. A queued write checks again at dispatch. Blocked jobs retain immutable receipt/result inputs, coalesce plain refresh requests without losing forced publication, and fetch current recovery after release. Old recovery snapshots are not replayed after a consented close. Completed acknowledgements are recorded as completed effects before deferring the next observation step; they cannot become locally unacknowledged merely because their reply crossed a lock.

   A captured Save can publish its own known receipt while foreign reference remaps wait. New foreign transitions defer and remain in the original observer journal until release; no latest recovery revision is adopted. Public regression confirms a completed Save remains on disk and in its buffer while a moved dirty sibling survives Cancel and later reconciliation, with one Save/one mutation and no pending observer evidence afterward.

   Reload clones its exact target and captures buffer/reference/CAS identity. It validates after the disk read and again before queued destructive dispatch. Its confirmed callback does not overwrite a changed alias. Open and comparison-refresh responses also respect the capture lock. Unknown final Close/Reload still retain their immutable request and captured lock until exact receipt resolution; committed destructive outcomes retain the previous no-veto ordering.

   Both reported races have public regressions. The delayed-observation/old-Reload-read case verifies the moved dirty text live, in backend recovery and after controller restart. The delayed-observation/unknown-final-Close case verifies exact resolution removes the consented text, does not leave a renamed open tab or republish a discarded draft, and survives restart with no pending observer evidence. Mutation counts stay one. The callback audit additionally reproduced and fixed an acknowledgement response crossing a Reload lock, with backend evidence remaining acknowledged and the dirty draft retained.

2. **P2 absent selection during another close.** Every preservation release now activates the actual current checkout's absent active file through the same guarded opening path. It does not depend on that file being the just-closed action's own survivor, or retain an old selection target for retry. Success, Cancel, failure and exact resolution of an unknown final result share that release path. The remembered comparison and current disk source remain intact; generation/current-selection checks still defeat stale activations.

   Four public cases first close alpha in the background, then select alpha while beta's preservation is active. All four release outcomes load alpha's current source in its remembered staged view. Actual Chromium repeats the two close/selection sequences, renders alpha's existing `a.ts`, and types into it.

## Checks

- Before implementation: all **six** initial R5 public regressions failed (two observation races, four release outcomes); the new actual Chromium selection-during-preservation journey failed with the missing textbox. The callback audit's additional admitted-acknowledgement probe also failed before its focused correction.
- **67/67 public editor tests**, **14/14 application tests**, **19/19 actual Chromium journeys**, no skips. Prior R1–R4 loss/conflict, receipt/observer/CAS, captured Save/Discard/Cancel, pending-close, comparison/normal typing, preview/order/reopen, tree/lookup and disposal cases remain represented.
- `bun install --frozen-lockfile`: 486 installs/619 packages checked, no changes.
- Exact source `24954aa`: `NX_DAEMON=false bun x nx run-many -t typecheck lint test --skip-nx-cache` passes all six tasks, cache skipped. Lint is TypeScript diagnostics. Direct public suite also reports 67 passing cases.
- `bun run check:foundation`: 40 immutable source hashes/UI/client checks pass.
- `bun run --cwd packages/editor check:renderer`: 1,569 browser inputs; no privileged module or feature runtime.
- `bun run --cwd packages/editor build`: StyleX, Monaco font and all five workers pass. Existing >500 kB chunk warning remains; performance/startup qualification is unrun.
- Impeccable static detector for the unchanged workbench/Monaco surfaces returns `[]`; whitespace passes. No visual styling changed.

## Inspected UI and remaining gates

[preservation-selection.png](preservation-selection.png) was captured in actual Chromium at **1600×1000 CSS px** and opened for inspection. It shows alpha selected with editable `a.ts` and typed `after deferred selection`, after alpha's close selected beta and beta's close selected alpha while preservation was still pending. Dataset: two volatile roots, two files each; the `?both` mode of `demo/recovery-race.tsx` restores both active `b.ts` files before the journey. Previous controlled captures remain linked from the README.

Fresh independent R6, actual production-workspace/controller filesystem/Git/SQLite fan-in, native picker/drop/Trash, packaged Electron/signing, complete-app accessibility/VoiceOver and human acceptance remain **PENDING**. This branch did not import the separately reviewed workspace implementation or dispatch composition. Controlled memory/Chromium success does not establish production durability, IPC/power-loss exactly-once behavior or native acceptance. No provider quota, SSH, legacy state, deployment, children, PR merge/watch/poll or history rewrite was used.
