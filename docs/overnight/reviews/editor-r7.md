What this change does: fixes delayed Copy resurrection and restores dirty comparison views. Both original R6 defects pass fresh causal checks, but **one P2 blocker remains** in [PR #4](https://github.com/ejjsharpe/moonbase/pull/4).

- **HEAD:** `914455852dcf0e700397adb3facb9daa0d7e0514`
- **BASE:** `8557fdd0d7a71f93a6584c77430e6fde57668580`

**P2 — Recreated working files remain read-only in comparisons** ([editor.ts:189](/Users/elliotsharpe/.t3/worktrees/moonbase/t3-2e5f465d/packages/editor/src/editor.ts:189)).

Open a staged/unstaged comparison whose working file is missing, switch checkouts, recreate the file, Refresh, then return. The settled-attempt cache skips activation despite the missing working buffer. Chromium renders the recreated text, but Save remains disabled and typing reports “Cannot edit in read-only editor.” Explicit Open recovers editing.

The same public probe **passes against R6 and fails at this head**. Fix readiness so a newly available working document triggers guarded buffer activation, preserving failure settling, empty originals and dirty baselines.

Prior R1–R5 regressions remain green in the supplied suites. Independent R6 probes verify confirmed Discard across backend recovery/restart, Cancel/rejection, unknown receipts, newer reopening, directory siblings, exact hosts and later operation facts.

Fresh results: **76 editor tests, 14 application tests, 22 supplied Chromium journeys**, six uncached root tasks, 40 hashes, renderer isolation and build pass. Independent probes: **15/16 public cases pass**; four browser journeys pass and two reproduce this single defect. Both hosted checks passed in one inspection.

[Full review, reproductions and artifacts](/Users/elliotsharpe/.t3/worktrees/moonbase/t3-2e5f465d/.review-r7/REVIEW.txt). Tracked tree unchanged; review server stopped; PR linked.

**Verdict: fix the P2 before technical clearance; keep DRAFT.**

Not checked: production workspace/IPC, Electron/native/package/signing, physical durability, performance, manual/VoiceOver and human acceptance—all remain PENDING.
