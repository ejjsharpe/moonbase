What this change does: [PR #9](https://github.com/ejjsharpe/moonbase/pull/9) adds scoped SSH forwarding and authenticated host verification. **One must-fix finding remains.**

1. **[P2] Normal macOS teardown can fail and block reconnect** — [process.ts:74](/Users/elliotsharpe/.t3/worktrees/moonbase/t3-c85d195c/packages/ssh/src/process.ts:74). Immediately after SIGTERM, the owned group can briefly return `EPERM` before disappearing. The code treats this as permanent failure: Disconnect rejects, status remains `disconnecting`, and Connect conflicts until release is retried. Retry this ambiguous observation within the existing deadline, while preserving errors for persistent failures and requiring confirmed cleanup. [Apple’s implementation](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sig.c#L1612-L1621) supports this exit-window behavior.

R1 dispositions:

- **Early Disconnect:** resolved; all 12 coalesced waiters settle with zero children.
- **Host-authentication bypass flags:** resolved; actual `ssh -G` enabled cases reject and disabled controls pass.
- **Exit versus inherited pipes:** original defect resolved; cleanup clearance remains blocked by finding 1.

Fresh evidence: the initial uninstrumented suite failed this teardown case (**69/70 passed**). Separate reruns passed **41 SSH + 29 application tests**, and **19 independent probes** passed. Passive syscall logging reproduced the new failure in 10/10 trials; 100 uninstrumented timing controls passed. This is intermittent, not universal. Typecheck, lint, build diagnostics, foundation and bundle audit passed.

- **HEAD:** `115c30b81b3f5845cb8aced8f03f47543f37d7a9`
- **BASE:** `09b21f2ee8556c54ef4f8238f0be2ee88fd990c3`

[Full report and evidence](/Users/elliotsharpe/.t3/worktrees/moonbase/t3-c85d195c/test-results/review-task06-r2/REPORT.txt) · [Runnable probes](/Users/elliotsharpe/.t3/worktrees/moonbase/t3-c85d195c/test-results/review-task06-r2/review.test.ts)

Tracked files remain clean; review processes/ports are cleaned up. Required PRs are linked without watches. Hosted CI was pending at the single inspection.

**Verdict: fix finding 1 before technical clearance.**  
Not checked: real SSH hosts/agents/ProxyJump, remote Pi/provider persistence, packaged/native or human acceptance; these remain pending.
