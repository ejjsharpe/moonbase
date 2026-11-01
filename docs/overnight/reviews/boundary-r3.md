# Independent application-boundary review, round 3

Reviewer: GPT-6 Astra, explicit `xhigh`, isolated read-only T3 worktree. PR #2 reviewed head `bfbd704e60d41a8c19944046bded9dde9a50a3f1`, base `bb5c5d0b366f43e5406fc328d5bd5ec7ee154e58`.

**P2: combined service and cleanup failures lose typed uncertainty/target.** Pinned Effect can convert both errors to Die reasons when an `ensuring` or scoped finalizer also fails. Inspecting only Fail reasons preserved both messages but returned Unavailable without the exact file target. Fixed by safely recognizing genuine application-error instances in either reason kind, using the class's private brand so arbitrary/throwing proxies are not inspected as application errors. Nonthrowing defect formatting remains in place.

New public command/subscription tests cover both `ensuring` and scoped cleanup combinations, asserting `Uncertain`, exact target and cleanup detail. Twelve committed public-client tests pass after the fix. Fresh current-head review is still required.

Reviewer validation at the old exact head passed frozen install, uncached typecheck/lint/ten tests, twelve additional public-client probes, foundation/browser-boundary and source hashes. Pre-abort, unprintable-defect and pending-acquisition regressions passed. No tracked files were changed by the reviewer.

The user subsequently requested removal of manually copied dependency license bundles. Those copies are removed; normal dependency notices remain in packages and are to be included automatically in actual generated package output. Earlier notice-inventory review is historical evidence, not a requirement to retain manual copies.

No packaged/native/provider/SSH/manual/human acceptance or unfinished sibling behavior was established by this review.
