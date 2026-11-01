What this change does: [PR #9](https://github.com/ejjsharpe/moonbase/pull/9) adds scoped SSH forwarding and authenticated host-health verification through the shared application service. **Three must-fix findings remain.**

1. **[P1] Early Disconnect leaves Connect pending indefinitely** — [index.ts:119](/Users/elliotsharpe/.t3/worktrees/moonbase/t3-158cbcd0/packages/ssh/src/index.ts:119). Calling Disconnect from the first `connecting` observation completes teardown with zero children, but the original Connect never settles. The attempt can be interrupted before its finalizer installs; nothing then completes `g.ready`. Settle pending waiters from the owning release path, including attempts that never started.

2. **[P1] Host-authentication bypass settings pass preflight** — [index.ts:157](/Users/elliotsharpe/.t3/worktrees/moonbase/t3-158cbcd0/packages/ssh/src/index.ts:157). Actual system `ssh -G` output with `StrictHostKeyChecking=yes` plus `NoHostAuthenticationForLocalhost=yes` is accepted. macOS’s `NoHostAuthenticationForProxyCommand=yes` also passes. These disable host authentication; application health does not replace SSH verification. Reject enabled bypass flags before forwarding. [OpenSSH documentation](https://man.openbsd.org/ssh_config#NoHostAuthenticationForLocalhost)

3. **[P2] SSH exit can leave a stale endpoint and surviving proxy helper** — [process.ts:30](/Users/elliotsharpe/.t3/worktrees/moonbase/t3-158cbcd0/packages/ssh/src/process.ts:30). Exit is recorded only on `close`, which waits for inherited stdio. A helper holding stderr keeps status `connected` and endpoint lookup available after SSH dies; Disconnect then signals the dead PID and fails cleanup. Reproduced with controlled forwarding and actual system SSH using a pipe-only ProxyCommand. Separate exit detection from pipe drainage and scope cleanup to the owned process group. [Node event semantics](https://nodejs.org/api/child_process.html#event-close)

Reviewed exact commits:

- **HEAD:** `d1a28745362c5f9cf5c164f3ef19fc8ac8af983b`
- **BASE:** `09b21f2ee8556c54ef4f8238f0be2ee88fd990c3`

The 25 SSH and 29 application tests pass. Independent probes reproduce all three defects; typecheck, foundation checks and the 253-input dependency audit pass. Prior #6 health and #8 contract dispositions remain intact. No tracked files changed. PRs #1, #2, #5, #6, #8 and #9 are linked, without watches.

[Full report](/Users/elliotsharpe/.t3/worktrees/moonbase/t3-158cbcd0/test-results/review-task06/REPORT.txt) · [Runnable repros](/Users/elliotsharpe/.t3/worktrees/moonbase/t3-158cbcd0/test-results/review-task06/review.test.ts) · [Results](/Users/elliotsharpe/.t3/worktrees/moonbase/t3-158cbcd0/test-results/review-task06/final-independent-tests.log)

**Verdict: fix 1–3 before technical clearance.**

Not checked: real SSH handshake/agent/ProxyJump hosts, remote Pi persistence, packaged/native or human acceptance. One artificial scheduling probe was excluded; acceptance remains PENDING.
