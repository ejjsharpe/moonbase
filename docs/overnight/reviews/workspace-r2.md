# Independent workspace review, round 2

PR #3 head `f93bd04bd78da69e57732c0f71eec027d200fef4`, base `6e58c1c4ea6944e8ca25eadc46e35c843f0f9fbe`. GPT-6 Astra `xhigh`, isolated read-only Moonbase worktree, private origin verified.

Prior seven R1 repairs passed their regressions, but two **P1** defects remain:

1. **Grouped interrupted Saves use inconsistent restoration revisions.** With older persisted drafts and newer admitted interrupted saves for A and B, restoring A advances revision 1→2 and makes B fail its admission-revision check. B is incorrectly marked restored. Repeated restart exposes new A but old B. Reconcile eligible saves against one consistent pre-recovery revision and publish together; retain truly competing later publications and never mark skipped restoration complete.
2. **Local replacement may Trash a selected source's ancestor.** Move/copy `folder/child.txt` over explicit replacement `folder` reaches Trash before transfer, even with a dirty child draft. Native-import ancestry protection did not cover local sources. Reject containing replacement destinations before admission/Trash, retaining case-only rename support.

Three extra public assertions reproduced the defects; a refusing/counting Trash wrapper prevented destructive test calls. Frozen install, diagnostics, all 55 workspace/native and 14 application tests, source/whitespace checks passed. Native helper hash and shared runtime adoption remain correct; no prohibited imports or root runtime appeared. Reviewer reused unchanged provenance and made no tracked edits.

Owner R2 repair assigned. PR stays DRAFT. Hosted completion, real editor/controller integration, packaged/signing, physical power-loss and human/native/accessibility gates were not established by this review.
