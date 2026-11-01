# Review R6 corrections

Historical response: independent R7 cleared those reported cases but found a newly available working-buffer variant. See the [current R7 response](review-r7.md).

Reviewed head: `677ea50b625e213f074afd4d914bd8e993b15785`. Exact base remains `8557fdd0d7a71f93a6584c77430e6fde57668580` (`chore/recovery-publication-contract`, #7). Implementation/test fix: `f8f36651c63d2ad6cbe262f7af379955e12fb7ef`. Final test source: `fda139e1f4183bc0e3f3418f9a3d63665805cd59`, tightening the restored comparison capture to wait for the rendered inline baseline. The following evidence-only commit adds this record, README links and inspected PNGs. PR #4 remains **DRAFT** for fresh independent R7; stack #1 → #2 → #5 → #7 → #4 is unchanged.

Only `packages/editor` was authored in this round. No root/shared/sibling/dependency/export/runtime boundary changed. The shared #7 publication contract and prior cancellation/receipt/preservation conventions remain intact. No new feature, global time-based cancellation, command queue, authority mapping or browser store was introduced.

## R6 responses

1. **P2 delayed Copy reopens a deliberately closed destination.** A confirmed exact close receipt now invalidates older optional Copy materialization for the captured exact targets in each existing Copy job. This is per job and target; other targets keep their valid materialization. Both durable-draft and source-snapshot materialization check that intent, including after delayed read IO and on a deferred retry. The filesystem Copy result/identity remain unchanged. Current closed/newly reopened state is published before acknowledgement; the operation is not replayed or dropped. Invalidation occurs only in the confirmed close callback, never merely on Cancel, a rejected publication or an unknown response.

   The public regression holds Copy's already-committed preflight response, edits its source, then holds the destination read. It opens/edits the destination and confirms Discard-close before releasing the older read. It verifies live/backend/restarted-controller state stays closed, the copied filesystem file still contains the original on-disk text, pending observer evidence clears only after publication, and mutation count stays one. Countercases cover Cancel, rejected close, explicit reopening/newer edits, and an unrelated close during directory Copy; valid destination drafts continue and remain durable. Actual Chromium performs the background Copy through the public API and uses real Monaco typing/Close/Discard controls. Its destination tab stays removed after delayed completion, with no page errors.

2. **P2 restored dirty survivor lacks its remembered comparison.** Activation readiness now includes the remembered comparison view, independently of buffer presence. Per-instance settled comparison attempts distinguish cold restoration from an already handled success/failure. Guarded Open fetches the current Git original while retaining dirty working text and its original disk baseline. The attempt identity follows successful/current requests only, clears with closed/preview buffers or moved resource keys, and does not infer readiness from original-text truthiness. Failures remain visible without automatic release retry loops; explicit Open/Refresh remains a retry path.

   Both staged and unstaged public cases restore dirty inactive `a.ts`, change its disk contents, close active `b.ts`, then assert the original side, dirty text, original baseline and external conflict. Additional cases cover a valid empty untracked original and a failed comparison that is not repeatedly retried by selection/Cancel release but succeeds on explicit Open. Chromium closes `b.ts` by keyboard and actually types into both restored dirty views, verifies readonly original/editable modified inputs, and waits for the correct inline HEAD/index baseline to render before capturing evidence.

## Validation

- Before fixes: **3/3** new causal public cases and **3/3** actual Chromium cases fail, matching Copy resurrection and the two missing restored comparisons. The public Copy probe reads backend recovery and reconstructs the controller before its final assertions.
- After: **76/76 public editor tests**, **14/14 application tests**, **22/22 actual Chromium journeys**, no skips. Earlier R1–R5 scenarios, exact publication uncertainty, receipt/observer/CAS bounds, cancellation, choices, dirty buffers, shared comparisons, previews/order/reopen, tree/lookup and disposal remain represented.
- `bun install --frozen-lockfile`: 486 installs/619 packages checked, no changes.
- `NX_DAEMON=false bun x nx run-many -t typecheck lint test --skip-nx-cache`: all six tasks pass, cache skipped. Lint is TypeScript diagnostics. Direct public suite reports 76 passing cases.
- `bun run check:foundation`: 40 immutable source hashes/UI/client checks pass.
- `bun run --cwd packages/editor check:renderer`: 1,569 browser inputs, no privileged implementation or feature runtime.
- `bun run --cwd packages/editor build`: StyleX, Monaco font and five workers pass. Existing >500 kB chunk warning remains; startup/performance is not qualified.
- Impeccable static detector on the unchanged workbench/Monaco surfaces returns `[]`; whitespace passes.
- Screenshot QA first caught a model-loaded/render-not-painted timing gap; assertions now wait for the inline original. One prematurely overlapping focused runner hit the occupied dev port and removed in-progress ignored trace artifacts, causing a teardown ENOENT. That operational run is not passing evidence. The final isolated full Chromium run passes **22/22** at `fda139e`, with no overlapping runner.

## Inspected captures and remaining gates

All three final captures were opened for inspection at **1600×1000 CSS px**:

- [copy-closed.png](copy-closed.png): source `a.ts` remains dirty, the real `copy.ts` filesystem entry remains in Files, and its deliberately closed tab/draft stays absent after the delayed public Copy completes. Dataset: two roots/two files each plus the one copied file; `demo/recovery-race.tsx` controlled Copy gates.
- [restored-staged.png](restored-staged.png), [restored-unstaged.png](restored-unstaged.png): the `?dirty=staged` / `?dirty=unstaged` fixture seeds `HEAD A` / `INDEX A` and a dirty inactive working buffer, restarts the controller and closes `b.ts`. The captures show the rendered original baseline and actual typed modified text while retaining `restored dirty A`.

Fresh independent R7, actual controller/production-workspace filesystem/Git/SQLite fan-in, native picker/drop/Trash, packaged Electron/signing, complete-app accessibility/VoiceOver and human acceptance remain **PENDING**. The separate connection boundary was not merged or imported, and composition was not dispatched. Controlled memory/Chromium results establish neither production durability nor native acceptance. No provider quota, SSH, legacy state, deployment, children, PR merge/watch/poll or history rewrite was used.
