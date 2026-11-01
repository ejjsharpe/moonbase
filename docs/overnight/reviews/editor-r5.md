# Independent editor review, round 5

PR #4 head `4c1e319d810ed4673765a008ae4c7101ee8b9f57`, base `8557fdd0d7a71f93a6584c77430e6fde57668580`. Fresh GPT-6 Astra `xhigh`, isolated read-only worktree/PR linked, clean tracked tree. Original R1–R4 scenarios pass, including staged and unstaged Close/Reopen with actual typing. Two connected blockers remain:

1. **P1: in-flight recovery observation bypasses preservation** (`editor.ts:685`). Observation IO begun before preservation can finish during Reload and remap a dirty buffer. Reload overwrites it with the stale read; later publication removes recovery and restart loses text. A related pending-close race accepts an exact receipt but leaves a remapped file open and republishes discarded text. Recheck/defer observation application after awaited IO while preservation holds, and guard Reload's captured reference before destructive publication.
2. **P2: selecting an absent survivor during another close never retries activation** (`editor.ts:177`). Close alpha's active file in the background, then select alpha during beta preservation. Its activation is rejected and never retried; Chromium shows an existing file unavailable. Defer guarded activation until preservation releases, honoring the latest selection.

Passed: 59 editor tests, 14 application tests, 18 supplied Chromium journeys, six uncached root tasks, install/hash/import/build/diff checks. Fresh probes: sixteen of nineteen public cases and four of five browser journeys pass; failures reproduce the findings. Exact-head CI green in one inspection. Record: `/Users/elliotsharpe/.t3/worktrees/moonbase/t3-705d346b/.review-r5/REVIEW.txt`.

Original owner is implementing shared after-await preservation gating and latest-selection retry with regressions; no global application queue or arbitrary revision adoption. PR stays DRAFT pending fresh R6. Production workspace/controller/IPC, native/package/performance/manual/VoiceOver and human acceptance remain PENDING.
