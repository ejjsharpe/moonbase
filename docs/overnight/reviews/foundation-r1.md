# Independent foundation review, round 1

Reviewer: GPT-6 Astra, explicit `reasoningEffort: xhigh`, provider `codex`, isolated read-only T3 worktree. Reviewed PR #1 head `bb5c5d0b366f43e5406fc328d5bd5ec7ee154e58`, base `c89e4db49efcb998cdd3834b89d43ac581694314`.

1. **P1: recovered operation evidence lacks checkout identity.** Equal relative paths in distinct checkouts cannot safely be reconciled after restart. Fixed centrally in PR #2 by mandatory `OperationResult.checkout`, with exact-identity/no-guess semantics. Editor/workspace owners are adding observable collision/restart scenarios; these module checks remain pending.
2. **P2: unsubscribe hides failing finalizers.** The adapter suppressed every rejection after abort, including cleanup defects. Fixed by inspecting full Effect exits, suppressing only interruption-only subscription exits and reporting cleanup failures through the public error callback.
3. **P2: command cancellation lacks typed application error.** `runPromise` collapsed interruption into a plain error. Fixed by translating interruption-only exits to `ApplicationError`/`Cancelled`; actual typed service errors and cleanup defects remain observable.

Before the runtime fix, public regressions reproduced all three tested failure paths: plain cancellation error, zero cleanup-error notifications, and an untyped command-cleanup failure. After the fix, six public-client tests pass, as do TypeScript diagnostics and the snapshot/browser-boundary check. No debug instrumentation or throwaway probes remain. Fresh independent review of the changed head is required.

The reviewer verified all 40 source hashes, working-tree flags and follow-history entries against the read-only source, checked attribution/extraction records and selected source tests, and found no additional provenance blocker. Active UI copies matched the snapshot. Source was not modified. Direct StyleX notice omission was separately addressed on the coordination branch, with exact-release matching still a distribution check.

Reviewer checks passed: frozen install, foundation check, uncached Nx typecheck/lint/four original tests and shared UI TypeScript. Packaged/native, provider, real SSH, visual/accessibility, human acceptance and power-loss coverage remain unrun. Copied upstream notice whitespace is retained; authored-file diff checks pass.
