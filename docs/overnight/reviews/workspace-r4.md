# Independent workspace review, round 4

PR #3 head `6495a2576f30f33035158e47143d29dcace75bf3`, base `6e58c1c4ea6944e8ca25eadc46e35c843f0f9fbe`. Fresh GPT-6 Astra `xhigh`, read-only isolated Moonbase worktree/private origin verified. Prior R1/R2 and current-format R3 repairs pass. Two compatibility defects remain:

1. **P1: old journal ordering can overwrite a newer publication** (`index.ts:504`). A genuine client publication during the previous public implementation's Save preflight precedes the recorded admission revision. Receipt-chain inference permits restoration and overwrites newer text across restarts. Preserve the snapshot and pending intent whenever missing ordering cannot be proved.
2. **P2: missing publication metadata permits early acknowledgement** (`store.ts:52`). An internal Save revision is inferred to be an explicit publication, allowing foreign Move evidence to disappear without `persistRecovery`. Missing metadata and internal initialization must use a conservative fence advanced only by explicit client publication.

Both reproductions use stores generated through the previous public WorkspaceLive, without database edits; current-format controls pass. All 76 workspace/native and 14 application tests pass. Independent probes: eleven passed, two failed. Diagnostics, forty hashes, native/rg hashes and whitespace checks pass. No tracked edits.

Artifacts: `/Users/elliotsharpe/.t3/worktrees/moonbase/t3-79537d36/dist/r4-review/{report.txt,public-probes.test.ts,public-probes.log}`. The original owner is assigned conservative missing-metadata handling, removing optimistic inference rather than expanding compatibility features. PR stays DRAFT pending fresh R5. Hosted CI was not qualified by this reviewer; lead separately verified it. Actual controller/package/manual/native/accessibility/provider/SSH/power-loss gates remain PENDING.
