What this change does: restores editable working buffers when missing comparison files reappear. **No blocking findings in [PR #4](https://github.com/ejjsharpe/moonbase/pull/4) at this exact head.**

- **HEAD:** `c31bb4164d2ff18031e2b391a83198bb5e40d027`
- **BASE:** `8557fdd0d7a71f93a6584c77430e6fde57668580`
- Private origin, Moonbase project/worktree binding and clean tracked state verified.

R7 is causally cleared: all four fresh public probes and four Chromium journeys fail against the prior controller and pass here. Both staged/unstaged views recover through background return and active Refresh. Actual typing, enabled Save, successful Save and readonly originals pass.

Fresh checks: **82 editor tests, 14 application tests, 24 supplied Chromium journeys, 19 independent public probes and four independent Chromium journeys pass.** Uncached root diagnostics, frozen install, 40 source hashes, renderer isolation, build and whitespace pass. Both hosted checks succeeded in one inspection.

All **22 prior findings** pass their exact-head regressions:

- **R1:** move collisions, checkout teardown, rejected Save, unavailable dirty tabs, restoration metadata/history, initial discovery, stale selection and lookup focus.
- **R2:** persisted collision drafts, rejected mutations, survivor activation and navigation typing.
- **R3:** selection during publication and Close/Reopen typing.
- **R4:** recovery retention/exact receipts, background survivors and comparison focus.
- **R5:** observation/Reload/pending-close races and activation after preservation.
- **R6:** delayed Copy closure and restored dirty comparisons.
- **R7:** recreated working-file readiness.

[Full review, individual dispositions and reproductions](/Users/elliotsharpe/.t3/worktrees/moonbase/t3-dd5f09c6/.review-r8/REVIEW.txt). Inspected captures include [staged return](/Users/elliotsharpe/.t3/worktrees/moonbase/t3-dd5f09c6/.review-r8/current-screens/staged-background.png) and [unstaged Refresh](/Users/elliotsharpe/.t3/worktrees/moonbase/t3-dd5f09c6/.review-r8/current-screens/unstaged-active.png).

**Verdict: technically clear for subsequent workspace fan-in.** PR remains DRAFT; no composition started. Servers stopped, preview cleared, all five stack PRs linked. No tracked edits, children, merges or polling.

Not checked: production workspace/IPC, Electron/native/package/signing, physical durability, performance, full-app accessibility/VoiceOver or human acceptance—all remain PENDING.
