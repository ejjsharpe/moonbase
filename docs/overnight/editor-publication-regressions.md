# Pending recovery-publication retirement repair

Base: integration `2f9f516f29df5299091cf7546b04c8077645e188`, exact editor `449496961c29c90c7a2e3c44d0618f08ef504947`. These coordinator-owned expectations reproduce the paired review's connected P1 using public controllers/shared client/WorkspaceLive, real Git/native saves/live watchers and fresh SQLite.

An already-started B Save is held before admission. A Save commits, then a real second SQLite connection holds `BEGIN IMMEDIATE` around its recovery publication, forcing a before-commit failure. B subsequently commits and advances the same client's recovery. Resolving the original publication yields exact-retry CAS conflict; old code retains it forever, blocking newer draft publication and Quit.

**Before repair: 13 integration PASS, 1 FAIL, zero skips.** The original eleven cases pass. Both committed-publication controls also pass: ordinary reply loss and a `Persistence` error injected only after a real commit, each with unavailable status and later B Save. Error code or null status alone therefore cannot justify retiring a publication. The failing real-lock case reports `Uncertain: Resolve the pending recovery publication first` on flush. Raw log: `/tmp/moonbase-editor-publication-red.log`.

Expected repaired behavior: only an authoritative exact-input rejection may retire the old metadata request; keep all successful Save receipts, immutable IDs, current texts/baselines and original committed publication receipts. Reconcile contiguous known transitions and publish a fresh capture; never mutate the rejected old request. Tests check new drafts/restart/Cancel/Quit, unchanged saved-file inodes, two Save dispatches and the old publication binding. No unknown destructive callback may be treated as successful.

Command: `MOONBASE_TEST_RIPGREP="$PWD/dist/tools/ripgrep/rg" bun run test:editor-integration`. This is a test-only red branch, not a cleared production/editor base. The original owner repairs PR #4; both #4/#11 remain DRAFT, task04's unfinished app checkpoint remains separately preserved, and future exact-head re-review is required.
