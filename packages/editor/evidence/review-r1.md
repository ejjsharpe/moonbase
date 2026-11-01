# Review R1 corrections

Independent R2 cleared the original eight scenarios and found four remaining blockers. The [R2 correction record](review-r2.md) records their owning fixes and new evidence; this file preserves the R1 history.

Reviewed head: `0556678460b139abb961b4a67f23ce8383e2136e`, original base `68aa035b9c283a65cac6e78ab02865e99882d15b`. All eight findings reproduced at public controller/browser seams. New executable/test source: `a376645c58038698089d6b44b7f04fc83c527141`.

The coordinator contract `6e58c1c4ea6944e8ca25eadc46e35c843f0f9fbe` was merged normally, preserving published history. PR #4 now bases on `chore/checkout-recovery-contract` (#5, after foundation #1 and coordination #2). No root files were authored here. PR stays draft for independent re-review and real workspace fan-in.

1. **P1 move collision:** preflight the complete source-buffer remap. A destination collision changes neither buffer; contiguous receipts permit publishing both drafts while withholding the operation acknowledgement. Own delayed and foreign outcomes retain both drafts across restart and repeated status resolution. Only an explicit Save/Discard/Cancel close of one file resolves the collision; successful resolution preserves the other text and deduplicates navigation references. Mutation count remains one.
2. **P1 checkout teardown:** ignore late position writes once the exact target is no longer open. Position recording errors stay observable and cannot interrupt listener/editor/model cleanup. Actual Chromium closes the checkout, retains the other editor, shows the empty state, and verifies one model removed with no page error.
3. **P2 definitive Save rejection:** InvalidInput clears the captured request after a definitive rejection. Corrected text saves; Quit can offer Discard. Existing lost-response/uncertainty tests still require the original immutable request.
4. **P2 retained unavailable activation:** failed file/comparison reads can activate an existing buffer with a visible unavailable notice. Dirty Trash text stays reachable after switching tabs. A genuinely new failed open cannot replace the current selection.
5. **P2 checkout metadata:** known exact targets/views/recents survive close; only open membership changes. Persisted views use `checkoutId`. Reopen restores order, active file, comparison and positions; checkout close adds no file-close history. The memory service validates known/open/selected IDs and view/draft/recent identity rules instead of accepting a sibling schema.
6. **P2 restored discovery:** load refreshes each restored OPEN root and its expanded directories without waiting for a watch notification. Closed metadata may reconcile facts and acknowledgements without directory/file/Git/watch IO or reopening.
7. **P2 cross-checkout activation:** explicit checkout selection invalidates prior file activation generations. A delayed A response cannot replace newer selection B.
8. **P2 lookup focus:** Base UI's dialog final-focus handler targets this workbench's Monaco textbox after successful explicit opening. Chromium asserts Enter focuses Monaco; tree preview retains tree focus.

## Checks

- Before fixes: seven focused controller regressions failed with overwritten/missing buffers, late-position throw, retained invalid Save payload, inaccessible Trash buffer, missing initial listings and stale activation. Two Chromium journeys failed with body focus and a close-checkout crash/model leak. The added schema/metadata checks reject composite view keys and invalid open membership.
- After fixes: **38/38** public controller tests, no skips; **5/5** actual Chromium journeys, no page errors in the teardown/focus scenarios. Controlled volatile WorkspaceService, same shared application handlers/receipt conventions. No production persistence claim.
- Uncached root Nx typecheck/lint/tests: both projects pass. Lint remains TypeScript diagnostics. Frozen install unchanged; foundation verification covers 40 source hashes; whitespace passes.
- Vite+ build compiles StyleX and five Monaco workers. Browser import check: **1,569 inputs**, no Node/Electron, feature Effect runtime, workspace/Pi/SSH implementation or frozen application source. Existing Monaco large-chunk warning remains.
- Impeccable detector for changed workbench/Monaco sources returns `[]`. No temporary diagnostic logging or helper artifact is shipped.

## Inspected captures and limits

The four-file volatile dataset is defined in `demo/main.tsx`; the constrained journey additionally creates empty `created.txt`. Actual Chromium screenshots were opened and inspected: [two instances, 1600×1000](two-instances.png), [constrained, 760×720](constrained.png), [checkout closed with the other editor retained, 1600×1000](checkout-closed.png). These show controlled module UI, not native or complete-app acceptance.

**PENDING:** independent changed-head review, actual controller/workspace files/Git/SQLite fan-in, native picker/drop/Trash and packaged Electron, complete-app keyboard/focus/VoiceOver, and human acceptance. No provider/SSH, legacy-state import, deployment, PR merge or watcher was used.
