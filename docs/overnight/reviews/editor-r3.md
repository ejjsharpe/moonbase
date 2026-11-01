# Independent editor review, round 3

PR #4 head `8e95e18a1823246e2859b5e9ae731c08d90539b8`, base `6e58c1c4ea6944e8ca25eadc46e35c843f0f9fbe`, source/tests `d166c15d39b085ceb700d12e8f0c152e4c8b7d5b`. Fresh GPT-6 Astra `xhigh`, isolated read-only Moonbase worktree/private origin verified. Prior R1's eight and R2's four scenarios pass, including explicit resolution of either retained replacement draft, downstream publication failure preserving admitted identity and actual typing after visual/MRU navigation.

Two **P2** defects remain:

1. **Close publication overwrites newer checkout selection** (`editor.ts:408`). Close a restored active file in A, delay recovery publication, select B, then release it: the old snapshot selects A again, while activation guards leave A's survivor unloaded. Reproduced through public client and browser clicks. Apply captured close changes without overwriting newer selection; preserve CAS and activate only the current survivor.
2. **Keyboard Close/Reopen lose typing focus** (`workbench.tsx:261`). Cmd+W and Cmd+Shift+T select/load the correct file but focus BODY; actual typing changes neither buffer. Extend post-mount focus handoff to these successful keyboard paths, preserving origin context and handling an empty editor.

All 41 editor tests, 14 application tests, nine Chromium journeys, frozen install, root diagnostics, forty hashes, 1,569 renderer inputs, five workers, detector and whitespace checks pass. Four screenshots inspected; exact-head hosted CI green. Independent probes: six public passes/one failure and one browser pass/three failures. No tracked edits. Full record: `/Users/elliotsharpe/.t3/worktrees/moonbase/t3-ca44a45d/.review-r3/REVIEW.txt`.

The original owner is assigned both fixes with public/browser regressions. PR stays DRAFT pending a fresh R4 at the changed head. Actual workspace, native/package/signing, full-app accessibility and human acceptance remain PENDING; volatile adapter evidence establishes no production durability guarantee.
