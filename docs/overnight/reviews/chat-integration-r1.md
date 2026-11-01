What this change does: PR #15 combines the reviewed Pi and SSH commits and adds a controlled, separate-process qualification of their shared public clients. The change adds test fixtures, root test dependencies and CI wiring; it does not change feature implementations.

Verdict: fix finding 1 before granting integration technical clearance. One P2 finding; no additional blockers found. Keep the dependent work draft. This is read-only review; no tracked source was changed.

1. P2 — Disconnect after mutation dispatch masks its uncertain outcome
   Location: packages/pi-runtime/src/remote.ts:50 (also generation checks at 18 and 48).
   Related coverage gap: tests/chat/integration.test.ts:98, where the response socket drops but the forwarding generation stays connected.

   Public reproduction, independently run for createChat, sendChat and stopChat:
   - Compose RemoteChatLive via Layer.provideMerge(SshLive), bind both public clients to that root, and connect to the separate production Pi/server fixture.
   - A controlled TCP child forwards the real authenticated request and withholds the actual production server's reply bytes after dispatch. No feature-private helper or substituted application result is used.
   - Call the public disconnect command for that same generation while the mutation is awaiting its reply.
   - The mutation rejects as Unavailable. Reconnect confirms the creation exists, the Send is admitted (one model call), or the exact task is stopping. Exactly one corresponding mutation was dispatched in each case.

   Cause: the transport attempt correctly gets Uncertain on loss, but the unconditional endpoint/generation recheck after Effect.exit fails because SshLive has published disconnecting/disconnected. It returns before failCause(attempt.cause), replacing the unresolved mutation with a connectivity error. A generation invalidation after a verified result has the same masking path. The checks are correct for reads and before mutation dispatch; they must not discard post-dispatch uncertainty.

   Required behavior: CHAT.md distinguishes Uncertain for possibly admitted outcomes from Unavailable connectivity; the Pi README promises Uncertain after an unproved mutation POST. The current result hides that distinction precisely when a consumer disconnects/reconnects during a pending action. No automatic resend or duplicate execution was observed. The risk is that a consumer can present the action as merely unavailable instead of preserving and reconciling its unresolved mutation identity.

   Smallest adequate fix: keep exact-generation rejection, but track whether a mutation POST may have been dispatched and return Uncertain if generation/endpoint validation fails after that point. Keep reads/pre-dispatch failures and explicit caller AbortSignal cancellation semantics intact; do not accept stale response data or reconnect/resend implicitly. Add a public cross-module regression for dispatch -> held/lost reply -> Disconnect -> original receipt recovery. Repair belongs to the Pi owner and should be brought into the fan-in explicitly; no UI workaround or new shared contract is needed.

   Evidence: probes.test.mts, probes.log. Three desired-Uncertain assertions fail with actual Unavailable after independently confirming the committed effect. This source is inherited unchanged from the reviewed Pi base; the cross-module reproduction is a new integration finding, not an allegation that the prior oracle/commit fixes regressed.

Exact identity and scope
- PR: https://github.com/ejjsharpe/moonbase/pull/15
- HEAD: 478ab94f1f434f27c4a8115e2e4a7de7ea1d84c1
- BASE: cbe9478e61fca354cb23d5f6bfb92ff256214ba4 (feat/pi-runtime / #12)
- Additional SSH dependency: 1aec1a438ba0d5592b0e6c3f0e1be835cf3c034b (#9)
- Normal merge: 66da1b87c339eafe3af93a888172b7d9231f627b, parents exactly the preceding Pi and SSH SHAs.
- Both bases are ancestors. Application and Pi trees are identical to cbe9478; SSH tree is identical to 1aec1a4. Authored changes above the merge are the root manifest/lock/CI and tests/chat files only.
- Worktree: /Users/elliotsharpe/.t3/worktrees/moonbase/t3-3fc033bf, branch t3/review-pi-ssh-fanin. Exact local HEAD and clean status checked before and after work.
- T3 thread is a subagent of 63122af4-017b-4b66-bcae-a905f2b1659d and is bound to project mcp:7cbe46d8-154d-422f-969f-cfaff7f0f0dd, Moonbase. Project repository identity, git origin and authenticated GitHub repository agree on private ejjsharpe/moonbase.
- PRs 1/2/5/6/8/9/10/12/15 linked; final list confirms all nine and no watches. No PR comments, merges, pushes, deployments or child agents.

Review coverage
Read AGENTS, README, MODULES, full OVERNIGHT, GLOSSARY, CHAT, HOST-PROTOCOL, CONNECTION, tests/chat README, all changed root/test/fixture/SSH files, and the connected application client/handlers/services, Pi remote/protocol/validation/server/runtime/host/public example and relevant public regressions. Consulted only the target's immutable source-snapshot provenance; no original escode access or reuse.

Architecture and evidence assessment
- One client ManagedRuntime owns RemoteChatLive + SshLive; both public clients use shared application handlers. The first integration case counts one forwarding child, and neither service constructs a feature root runtime.
- Separate Node 26 host owns one PiRuntimeLive and serveChat listener, using the same public ChatClient dispatch. Pi remains the store/execution/transcript authority. There is no extra scheduler, execution store or global queue. Command-name arrays are bounded by these tests, not production state.
- Fixtures use real HMAC health, challenge grants and signed RPCs, real loopback TCP children and real temporary SQLite. The faux provider is a public SDK API; the host receives platform-only environment and no provider credentials. Private synthetic config stays in a mode-0600 file under a fresh canonical temporary directory, not argv/logs/public values.
- The committed loss fixture drops actual reply bytes. Its original test honestly establishes Uncertain while the connection generation stays usable, read-only lookup/reconnect/store reopen, one Send and one user input, and host work surviving client disposal. It does not cover the finding above.
- Static graph audit of the ACTUAL tests/chat/integration.test.ts entry independently reproduces 260 inputs / 552,475 bytes. Includes application/runtime-client, RemoteChatLive and SshLive; excludes editor/workspace, Pi engine/server/host/SQLite/provider SDK implementations, React/Electron and reference source. This is a Node client-harness graph, not a renderer or packaged application claim.
- Root lock changes retain the existing dependency pins. retry hoisting changes preserve both versions and their consumers. Four dev dependencies make the actual root fixture imports resolvable; no new product dependency or ambient provider selection was introduced.

Checks and artifacts (all under test-results/review-pr15)
Environment: macOS, Node v26.13.0, Bun 1.4.4; installed pinned TypeScript/Effect/Pi versions.
1. bun install --frozen-lockfile -> PASS, install.log. Three lifecycle scripts remained blocked; no authorization change was made.
2. bun run check:foundation -> PASS, foundation.log: 40 hashes and browser contracts.
3. NX_DAEMON=false NX_SKIP_NX_CACHE=true bunx nx run-many -t typecheck lint test -p @moonbase/application @moonbase/pi-runtime @moonbase/ssh --skip-nx-cache -> 9/9 PASS, nx.log. Nx suppressed task stdout.
4. Re-ran just the three module test targets with NX_TUI=false --output-style=static --skip-nx-cache to retain detailed counts, module-test-detail.log/.txt: application 33 + Pi 45 + SSH 43 = 121 PASS, zero failures/skips. These are the same tests, not 242 distinct cases. Lint/build terminology remains TypeScript diagnostics.
5. bun run test:chat-integration -> PASS strict consumer typecheck and 4/4 controlled integration tests, integration.log. Total shipped distinct cases: 125.
6. Seven independent probes: 3 failures demonstrating the one P2, 4 passing controls. First six via node --experimental-strip-types --test --test-concurrency=1 test-results/review-pr15/probes.test.mts (probes.log). Last isolated via --test-name-pattern='unexpected forwarding' (child-exit.log).
   PASS: cancelled Send wait leaves host work live with queryable original receipt/no implicit Stop; mutating a dispatched caller object does not rebind original Send and changed explicit retry rejects; stale read rejects and pre-aborted mutation dispatches nothing; unexpected forwarding child exit in that trial returned Uncertain and retained its one admission. The latter distinction is preserved: the deterministic failure here is public Disconnect after dispatch, not a claim that every process-exit timing returns the wrong code.
7. node test-results/review-pr15/graph.mjs -> PASS, client-graph.json and client-graph-summary.json.
8. git diff --check plus exact-tree/ancestry/clean checks -> PASS, git-evidence.json.
9. One authenticated gh pr view 15 inspection at the supplied exact head/base: draft/open, both modules checks SUCCESS. No watch/poll. Check URLs:
   https://github.com/ejjsharpe/moonbase/actions/runs/41288942263/job/124795954902
   https://github.com/ejjsharpe/moonbase/actions/runs/41288798849/job/124795524415

The *-discovery.log files were a no-match enumeration attempt and are NOT test evidence; Node only reported file loads. nx-task-history.json was empty. Detailed uncached test output above is the count authority.

Cleanup
The seven independent fixtures disposed all roots and hosts, checked PIDs and negative process-group IDs with ESRCH, rebound all captured host/forward ports, restored environment and removed their temporary credentials/stores. A separate final cleanup.mjs audit confirms 31 PIDs absent, 24 owned SSH process groups absent and 19 ports rebound (cleanup-summary.json; per-fixture audit JSON retained without secrets). The 125 shipped tests passed their own teardown assertions, including SSH helpers and host child reaping. No review-owned child remains in the worktree process scan. Only ignored review artifacts were written; tracked files remain clean.

Qualifications
Source/runtime and controlled integration are the qualified scope. Existing Pi R1 oracle/post-commit regressions and SSH early-release/policy/exit-vs-close/EPERM regressions pass at the combined head; no separate rerun of the historical independent review programs is claimed. The test suite includes source CLI and Electron RUN_AS_NODE runtime-boundary execution, not foreground GUI or packaged desktop acceptance.

Not checked: real providers/quota, a real SSH/agent/ProxyJump host, remote host distribution/notices, packaged/native UI, optional engines or power loss. Human acceptance remains PENDING; Pi PR #12's declared distribution/manual draft gates remain distinct from this actionable integration defect.
