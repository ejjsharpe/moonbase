What this change does: [PR #10](https://github.com/ejjsharpe/moonbase/pull/10) adds browser-safe chat contracts and shared Effect dispatch, plus requirements for durable admission and authenticated RPC.

**No blocking findings at the reviewed head. Contract cleared for downstream implementation.**

- **HEAD:** `d38833db81c5d97a1aa60f25e0dc27dd670af60f`
- **BASE:** `09b21f2ee8556c54ef4f8238f0be2ee88fd990c3` — `chore/connection-contract`, PR #8.
- Verified private `ejjsharpe/moonbase`, the supplied Moonbase project binding, assigned worktree, exact ancestry, and unchanged tracked files. PRs #1, #2, #5, #6, #8 and #10 are linked to this thread.

The coordinator’s replay objection is addressed **in the specification**: server-issued grants expire, are consumed atomically before dispatch, and cannot survive restart or authorize a second RPC. Signed request bodies, response bodies/status, separate proof domains, and authentication before input disclosure cover the identified failure scenario. This follows the verifier-enforced replay protection principle described in [RFC 9421 §7.2.2](https://www.rfc-editor.org/rfc/rfc9421.html#section-7.2.2).

I inspected the installed published Pi Durable 1.4.0 APIs and admission implementation. The contract correctly accounts for ordinary two-phase submission, weaker Pi deduplication, read-only admission lookup, queued withdrawal, and changing task IDs. Captured Stop targets never authorize adopting a successor or later input.

Validation passed:

- Frozen dependency installation; uncached Nx typecheck, lint and tests.
- Foundation checks: 40 frozen source hashes, UI copies and four isolated browser contracts; `git diff --check`.
- Five fresh, typechecked [public-interface probes](/Users/elliotsharpe/.t3/worktrees/moonbase/t3-355adc48/.review-pr10/probe.test.ts): nullable receipts, queued Stop forwarding, combined capability/runtime sharing, nonblocking Stop, cancellation, acquisition/disposal races and retained uncertainty.
- Both hosted CI jobs were successful at the exact head.

The probe file is untracked; production source was not edited.

Not checked: production Pi/SQLite admission, HTTP authentication, Stop races, remote/provider execution, packaging or manual acceptance. Those remain pending implementation gates; fixture success does not qualify them.
