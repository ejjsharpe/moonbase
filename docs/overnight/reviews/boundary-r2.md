# Independent application-boundary review, round 2

Reviewer: GPT-6 Astra, explicit `xhigh`, isolated read-only T3 worktree. PR #2 reviewed head `a77b241d1f81fcea8434b0e2236d889dd1fb875e`, base `bb5c5d0b366f43e5406fc328d5bd5ec7ee154e58`. Later lookup/notice commits were excluded from that exact review.

1. **P2: pending watch acquisition can hide cleanup defects.** The pinned Effect `Stream.callback` constructor loses a finalizer failure when interruption races asynchronous acquisition, before the runtime adapter receives the exit. Fixed by acquiring resources in the enclosing `Stream.unwrap` scope; this convention is documented in `MODULES.md` and sent to both feature owners. Public regressions exercise pending acquisition, unsubscribe and concurrent runtime disposal.
2. **P2: formatting arbitrary defects can throw.** `String(Object.create(null))` bypassed typed error delivery. Fixed with nonthrowing formatting; typed failures are taken from Effect Fail reasons, without testing arbitrary defects as application-error objects. Public tests cover both command and watch delivery of an unprintable defect.
3. **P2, inherited: pre-aborted commands still dispatch.** The pinned runner can evaluate synchronous effects before checking its signal. Fixed by rejecting the already-aborted signal before dispatch. Public test asserts typed `Cancelled`, zero saves and zero runtime resource acquisitions. In-flight cancellation remains cooperative, not rollback.

The four new regression cases failed before these fixes (two acquisition/disposal cases, arbitrary defects and pre-aborted dispatch) and pass afterward. Ten public-client tests, application typecheck and source/browser-boundary checks now pass. Fresh exact-head independent review remains required.

Prior identity gap is fixed in the contract; actual restart/collision behavior remains module evidence. Reviewer additionally checked ordinary mixed causes, startup/observer failures, in-flight disposal, post-disposal errors and notice hashes. All six previous committed tests and both exact-head GitHub runs passed; they did not catch the new race cases. No tracked code or source checkout was modified by the reviewer.

Packaged/native/manual/provider/SSH, later module behavior, human acceptance and exact-release StyleX matching were not established by this review.
