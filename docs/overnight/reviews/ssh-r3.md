What this change does: [PR #9](https://github.com/ejjsharpe/moonbase/pull/9) adds scoped SSH forwarding with authenticated host verification. **No blocking findings remain at this exact head.**

All prior findings are resolved:

1. **R1 early Disconnect:** twelve coalesced Connect waiters settle on early Disconnect/root disposal, with zero children spawned.
2. **R1 authentication bypass:** actual `ssh -G` enabled-bypass cases reject; disabled controls pass.
3. **R1 exit versus inherited pipes:** endpoint invalidation and cleanup pass for stderr, stdout, both-pipe and no-pipe helpers. Unrelated runtimes survive.
4. **R2 macOS `EPERM`:** transient denial recovers; persistent denial fails after one ~2.5-second budget, blocks endpoint/reconnect, and recovers through explicit release. Old-source controls fail as expected.

Fresh evidence:

- **43 SSH + 29 application tests passed**, plus **17 independent probes**.
- Passive OS comparison: one old-head trial failed and another passed; both new-head trials passed despite **six natural `EPERM` results**.
- Typecheck, lint, build diagnostics, foundation checks and the 253-input bundle audit passed. Both exact-head hosted checks passed.
- Cleanup audited 394 recorded PID/group identities: none remain. Ports rebind; tracked files remain clean.
- PRs #1, #2, #5, #6, #8 and #9 are linked without watches.

**HEAD:** `1aec1a438ba0d5592b0e6c3f0e1be835cf3c034b`  
**BASE:** `09b21f2ee8556c54ef4f8238f0be2ee88fd990c3`

[Full report and evidence](/Users/elliotsharpe/.t3/worktrees/moonbase/t3-10bafc84/test-results/review-task06-r3/REPORT.txt) · [Runnable independent probes](/Users/elliotsharpe/.t3/worktrees/moonbase/t3-10bafc84/test-results/review-task06-r3/review.test.ts)

**Verdict: technical clearance for source and controlled transport only.** PR remains draft.

Not checked: real SSH/agent/ProxyJump hosts, remote Pi/provider persistence, packaged/native/manual execution or power loss. Human acceptance remains **PENDING**.
