# Workspace ownership validation

Issue [#86](https://github.com/ejjsharpe/moonbase/issues/86) starts from integrated `main` at `3f15bcaf21dae36ec6f84c1a6a74c6a55e09e343`, including #84, #90 and subsequent integrated work. The complete command list below passed at implementation revision `ee0fd19dd46e788a7e4b3e293b65d559ad8729fb` on 2026-11-03, on macOS arm64 with Bun `1.4.4`, Node `v26.13.0` and Xcode command-line tools. Review follow-up `9de986d8fbce7bf2450a6ba684ee624cc55d8944` strengthens only tests; workspace typecheck/lint/tests and root typecheck/lint/format/tests were repeated there. Later evidence-only documentation does not change runtime code or tests.

## Baseline and scope

The clean baseline passed workspace build, typecheck and all 124 workspace tests. Caller inventory found `LocalWorkspace` constructed only by `src/index.ts`, with the rebound recovery helpers used only within workspace. Desktop, standalone examples, fixtures and editor/workspace integration continue using unchanged public exports. The implementation changes no public service/configuration/DTO/schema identities, filesystem asset export, dependencies, saved/wire formats or fixed fixtures.

## Source and controlled execution

Native/process suites ran serially with other resource-heavy integration work, using temporary repositories and stores. Logs are in ignored `test-results/workspace-86/` in the implementation worktree.

| Command | Result |
| --- | --- |
| `bun install --frozen-lockfile` | Pass; pinned lockfile unchanged |
| `bun run --cwd packages/workspace build` | Pass; native filesystem helper built |
| `bun run --cwd packages/workspace typecheck` | Pass |
| `bun run --cwd packages/workspace lint` | Pass |
| `bun run --cwd packages/workspace test` | Pass; 126 tests initially, 127 after review follow-up; no failures/skips |
| `bun run --cwd packages/application test` | Pass; 277 tests, no failures/skips |
| `bun run test:editor-integration` | Pass; 26 tests, no failures/skips |
| `bun run check:foundation` | Pass; negative boundary fixtures, unchanged saved/protocol bytes, public browser graphs and emitted headless consumer |
| `NX_DAEMON=false bun run typecheck` | Pass; 8 tasks, 7 cached; workspace executed |
| `bun run lint` | Pass |
| `bun run format:check` | Pass; 248 matched files |
| `NX_DAEMON=false bun run test` | Pass; root script test plus 8 package tasks, 5 cached; workspace executed |

Three added public-service regressions cover failed immutable import reservation retaining the original native references for retry, root disposal retaining a claimed native descriptor and its journal until actual helper exit, and unrelated command completion during watch acquisition followed by concurrent unsubscribe/root disposal. The existing expiry test now asserts import rejection before explicit release, so release cannot mask a broken expiry runner. Existing tests retain native expiry/single use, reservation/preflight cancellation, failed-release retry, discovery limits/ignore behavior, strict rejection, publication failures/conflicts, grouped Save restoration, lost replies and previous-producer recovery. Contracts, compatibility byte fixtures and the previous-producer archive have no diff from the baseline. Boundary policy and test discovery/scheduling/timeouts were not relaxed.

## Qualification limits

The workspace suite executes real controlled native helpers and its existing restricted-PATH asset fixture. That fixture is separate from an actual packaged Electron application. Desktop build/browser/native/package/smoke qualification was not rerun for this private workspace refactor. Real provider/SSH use, OS gestures, VoiceOver, signing/notarization, Intel hardware and physical power-loss durability remain unperformed. Filesystem and SQLite publication still do not form one atomic transaction; existing uncertainty/recovery behavior remains required.
