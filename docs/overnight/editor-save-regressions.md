# Pending production Save-receipt repair

Base: `a7a0d8861346e869a7fb8013ed2522cf2f578642`; inherited editor source `c31bb4164d2ff18031e2b391a83198bb5e40d027`. The coordinator added two public production-adapter regression cases to the existing fixture after independent integration R1 found a P1. This branch contains test expectations, not an implementation fix.

Both cases fail before repair with typed `Conflict: Recovery changed in another window` while flushing newer edits. One loses the committed A reply then completes B and retries A; the other commits A but delivers B's response first. Both use live workspace watchers, real SQLite/files/Git/native saves and immutable IDs. The original nine cases still pass: **9 PASS, 2 FAIL**, zero skips. Command: `MOONBASE_TEST_RIPGREP="$PWD/dist/tools/ripgrep/rg" bun run test:editor-integration`; raw red log `/tmp/moonbase-editor-save-red.log`.

Expected repaired behavior: retain all exact Save receipt transitions until reconcilable, persist both newer dirty texts/baselines, preserve Cancel and later Quit, and restore over a fresh runtime. File inodes and original request-ID sets must remain unchanged during receipt recovery, detecting another native replacement or a substituted request. No latest-revision adoption is allowed.

The original editor owner is repairing `feat/editor-module` in PR #4. The unfinished Electron branch is safely pushed separately; its Save/recovery acceptance is blocked. After independent module re-review, the lead will normal-merge the reviewed fix and these tests into PR #11, rerun them and obtain fresh exact-head fan-in review. No GitHub merge, legacy state, provider or unspecified host was used.
