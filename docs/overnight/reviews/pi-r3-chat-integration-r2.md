What this change does: PR #12 provides the independent Pi Durable host and remote service. Its new repair preserves a mutation's uncertain outcome when a forwarding generation disappears after dispatch. PR #15 brings that exact Pi repair into the reviewed SSH integration by a normal merge and adds three separate-host Disconnect regressions.

Verdict: NO BLOCKING FINDINGS at the two exact reviewed heads for source/public runtime and controlled integration. The prior integration P2 is resolved. The two Pi R1 findings and four SSH findings remain resolved in the inspected and exercised paths. This is fresh technical review of the changed heads, not an extension of old approval. Keep both PRs DRAFT, human acceptance PENDING, and the distribution/real-provider/real-SSH/native gates open. Hosted CI is independently blocked before execution by the account billing/spending restriction described below.

Exact identity and scope

PR #12: https://github.com/ejjsharpe/moonbase/pull/12
HEAD: 235eb27a448635a995bb65e67147e99119830b92
BASE: d38833db81c5d97a1aa60f25e0dc27dd670af60f
Branches: feat/pi-runtime -> chore/chat-contract (#10).
Previous Pi R2 checkpoint: cbe9478e61fca354cb23d5f6bfb92ff256214ba4.

PR #15: https://github.com/ejjsharpe/moonbase/pull/15
HEAD: 132d273073889bd0702cf96b1fc2a62d5027598c
BASE: 235eb27a448635a995bb65e67147e99119830b92
Branches: chore/chat-integration -> feat/pi-runtime (#12).
Additional SSH dependency: 1aec1a438ba0d5592b0e6c3f0e1be835cf3c034b (#9), whose base is 09b21f2ee8556c54ef4f8238f0be2ee88fd990c3.
Previous integration R1 checkpoint: 478ab94f1f434f27c4a8115e2e4a7de7ea1d84c1.
Normal follow-up merge: 5d81b0a (full ID and both parents in git-evidence.json), with parents 478ab94 and 235eb27; 132d273 adds only tests/chat changes above it. Original fan-in merge 66da1b87c339eafe3af93a888172b7d9231f627b retains the reviewed Pi/SSH ancestors.

Review worktree: /Users/elliotsharpe/.t3/worktrees/moonbase/t3-c1972722
New local branch: t3/review-pi-r3-chat-r2-132d273
Initial clean parent/ledger commit: 2b3b4c9d4868768e65b5aaecba9b5e9d344300ce.
Verified clean before switching a NEW branch to 132d273; no existing branch rewritten. Tracked tree remains clean and exact HEAD unchanged. The T3 worktree binding remains this same isolated directory; its original branch label is t3/review-pi-chat-integration, while Git records the new local review branch above.
T3 project: mcp:7cbe46d8-154d-422f-969f-cfaff7f0f0dd (Moonbase).
T3 thread: thread:delegated-task:command%3Amcp%3A8185ba6c-62ae-4571-ad0b-9688ad5a1b92%3Adelegate-task%3Afresh-lead-pi235-r3-integration132-r2-astra.
Live catalog confirms codex / gpt-6-astra / reasoningEffort xhigh / serviceTier default. No children were created.
T3 registered repository, Git origin and authenticated GitHub identity agree on private ejjsharpe/moonbase, https://github.com/ejjsharpe/moonbase.git. Linked and finally enumerated #1/#2/#5/#6/#8/#9/#10/#12/#15; all watching=false. No comments, PR changes, commits, pushes, merges, deployment or original-escode access.

Git tree comparisons establish that current integration packages/pi-runtime and packages/application are byte-identical to 235eb27, and packages/ssh is byte-identical to 1aec1a4. New Pi changes from cbe9478 are exactly four packages/pi-runtime files: remote.ts, transport.test.ts, README.md and EVIDENCE.md. Shared application contracts, dependency composition, root registration and SSH source are unchanged by that repair. Integration-authored changes are tests, root dev-dependency/lockfile registration and CI wiring; no hidden feature-internal integration edits were found. Both dependency heads are ancestors; #12's merge-base with its supplied base is exact. git-evidence.json records tree IDs, ancestry and paths.

Read the target AGENTS, README, MODULES, GLOSSARY, complete OVERNIGHT and original common/05/06/09 briefs, CHAT/HOST-PROTOCOL/CONNECTION, module/provenance/evidence docs, tests/chat docs and fixtures, prior reports/responses, changed and connected runtime/handler/service/client/server/validation/SSH/process code, relevant tests, and installed pinned Pi public declarations/implementation. Source reference consultation was limited to the immutable target snapshot provenance; no original source checkout was accessed. Load assumption is the explicitly configured personal v0 host/store, not multiplayer or a general scheduler.

Prior finding dispositions and fresh causal evidence

1. Integration R1 P2, disconnect masks uncertainty: RESOLVED.
   Current packages/pi-runtime/src/remote.ts:15,19-20,34,52-56.
   The flag becomes true at the POST call boundary. Before that point, unavailable endpoints still reject without disclosing a mutation. Afterward, loss/replacement of the exact connection ID/origin/key/host/store produces Uncertain and rejects stale data. A final endpoint check runs after response processing/cleanup. Pure interruption is returned as interruption; the application adapter preserves Cancelled. Failure causes are combined instead of discarding the transport/reader failure.

   Re-ran the original PR15R1 probes.test.mts unchanged byte-for-byte. Its fixture differs only in remote-source selection; source/executable/evidence paths stay inside this review worktree. Actual separate Node host, production Pi/server/HTTP and SQLite, actual TCP forwarding child and public SshLive disconnect are retained. For Create, Send and Stop the forward holds real production reply bytes, Disconnect kills that generation, reconnect proves the committed creation/admission/stopping task, and exactly one corresponding mutation was dispatched. Current: Uncertain in all three. Archived cbe adapter, the exact adapter inherited by 478ab94: all three fail the desired-Uncertain assertion with Unavailable, after confirming the committed effect. No synthetic response, fabricated row or automatic resend supplies these observations.

   Four original integration controls also pass unchanged: cancelled Send wait leaves work live with no implicit Stop; mutation of the caller's object cannot rebind the dispatched Send; stale reads reject and pre-aborted mutation dispatches nothing; unexpected forwarding-child exit preserves one admission and Uncertain. Original full probe total: 7/7 current; 3/3 selected historical failures, deliberately expected.

   Independently re-ran the six supplied module causal cases against archived cbe: Create/Send/Stop x disconnect/replacement all fail with Unavailable. The six exact current originals pass within the full 53-test Pi suite, alongside the challenge-only/pre-dispatch and unknown-reader-cleanup controls. Sources other than the selected historical adapter are unchanged for this comparison.

   Added four independent cross-process boundary probes in supplementary.test.mts. Three inject actual public Disconnect at the third public endpoint lookup, after the genuine signed Create/Send/Stop response has been validated. Current callers reject with Uncertain and recover their exact original conversation/receipt/Stop target; old source reports Unavailable. The fourth combines an actual committed Create, actual Disconnect, a lost response read and a throwing-Proxy reader cancel. Current code retains Uncertain plus BOTH sanitized 'response could not be read' and 'reader release failed' details, releases the reader, and recovers the exact captured Create reply with one saved conversation and zero model calls. Old source reports only connectivity Unavailable and loses that detail. All four are GREEN current / RED old, with persisted/recovered-state checks before the desired-error assertion. The public endpoint wrapper is an explicit controlled fault seam; it is not a claim about probability of a particular OS scheduling race.

2. Pi R1 P1, unauthenticated signed-error oracle: RESOLVED, not regressed.
   Current packages/pi-runtime/src/server.ts:50-64; remote.ts:35-49; protocol.ts:22-34.
   Signing becomes available only after complete raw-body proof verification and synchronous live-grant consumption. Malformed unauthenticated/live-but-unproved/consumed-grant requests cannot receive a valid RPC error signature. Authenticated parser/domain rejection still uses consumed grants and signed specific errors; replay receives unsigned rejection. Health, challenge, request and response domains remain distinct; proof covers the exact nonce/grant/method/path/body or status/body. No reusable-key disclosure, bearer fallback, new signing oracle or authority rebinding was found.

   Copied the original Pi R2 independent.test.mjs with only its current source-relative path adjusted. Its real relay is given only origin and observed public headers, never the key. All four Create/Send x live/consumed attacks prove production persistence/execution and original-ID recovery first. Current: unsigned rejection and Uncertain; historical f6c081d: signed rejection and InvalidInput. Send runs once; Create runs no model. The supplementary busy Conflict replay and 15 actual status/proof/body/domain substitutions also pass: consumed Conflict cannot later admit a request; original immutable retry alone can admit it. Genuine Unauthorized, InvalidInput and Conflict remain specific. The current suite retains grant capacity128/20-second monotonic expiry/restart/concurrent replay/body/deadline checks and exact actor/host/store/input validation.

3. Pi R1 P2, committed Create reported as definite Persistence: RESOLVED, not regressed.
   Current packages/pi-runtime/src/index.ts:52-58,80-97.
   Create retains immutable Pi-owned request/conversation metadata and treats unknown/typed commit acknowledgement, post-commit read and mutation-output failure as Uncertain. Proven local validation/authority and its own immutable-binding rejection stay specific.

   Re-ran four original public Harness fault seams unchanged: unknown read, typed Persistence read, typed lost acknowledgement, invalid reply metadata. Every case captures the actual committed ID, creates a newer decoy, closes/reopens real SQLite, and recovers the original ID/title on exact-input retry. Changed reuse rejects; precisely original+decoy remain; model calls0. Current four pass with Uncertain. Historical f6c081d fails all four desired-error assertions with Persistence/Persistence/Persistence/InvalidInput. No database edits, private store or latest-conversation fallback are used. All 11 prior Pi independent tests pass current, including delayed cooperative Stop: pending, counted effect1 and unrelated Create completing before the Stop timeout. The eight selected R1 historical comparisons fail for their expected original causes.

4. SSH R1/R2 findings: remain RESOLVED at unchanged 1aec1a4 tree.
   Source and all43 current public SSH tests confirm owning release settles early/coalesced waiters; actual system ssh -G rejects enabled NoHostAuthenticationForLocalhost/ProxyCommand bypass flags while disabled controls pass; exit invalidates the endpoint independently of pipe close; owned process groups include lingering helpers; transient EPERM is retried within one2.5-second TERM/KILL/drain deadline, only ESRCH proves absence, and persistent failed cleanup blocks endpoint/reconnect until explicit release. These tests include actual local pipe-only system SSH controls without a remote handshake. This review did not rerun the separate historical SSH R3 reviewer's17 supplemental probes or passive syscall trials, and makes no new real-host/agent/ProxyJump qualification. The integration tests exercise the unchanged public SshLive with real controlled TCP children.

Other retained requirements

Pi owns execution, transcripts, tasks and request documents. Installed1.4 public APIs are ordinary submit(draft,context), public submissionByRequest, subscribeCommits/subscribeClose and exact task/submission abort APIs; inspected declarations/implementation agree with the adapter. Reservation->ordinary submission->public lookup/binding remains two-phase admission. Reconnect/read-only lookup does not resubmit reserved requests. Per-conversation admission coordination does not await model/tool completion; no global queue, extra dispatcher, transcript authority or scheduler was added.

One scoped root is constructed at the standalone host composition entry; feature Pi/remote/SSH exports provide focused Effect capabilities. HTTP uses its injected root-bound ChatClient and shared handlers. Integration client roots compose RemoteChatLive with one SshLive graph; both public clients share one forward. Unrelated connection queries remain responsive while a mutation reply is held. Browser chat contracts contain no privileged implementation. Local editor paths are never inferred from remote cwd.

Current public suite retains exact-task Stop across handover and later inputs, null-task no-fallback plus real queued withdrawal, view disposal without Stop, cooperative pending, cancellation after admission, busy reservations, real SQLite-full/reopen, actual exclusive second-process ownership, SIGKILL/resume/parked tasks and counted native tool effects. Bounds remain32 scanned records/page,4096-byte previews,eight tools,256KiB escaped replies and coalesced views; Pi internal stored transcript/cache is not claimed bounded. Pure cancellation cannot undo admitted work or external tools. None of this grants external exactly-once semantics or physical durability.

Checks and evidence

All paths below are relative to this report directory. COMMANDS.txt contains exact runnable commands.

- install.log: frozen Bun install PASS; lockfile unchanged; three blocked lifecycle scripts were not enabled.
- nx.log: nine uncached typecheck/lint/test tasks PASS. Application33 + Pi53 + SSH43 =129 distinct tests, zero failures/cancellations/skips. Lint and package build are explicitly TypeScript diagnostics.
- integration.log: strict consumer typecheck and7/7 separate-host HTTP/SQLite/controlled-forward tests PASS. Shipped total136.
- build.log, foundation.log, diff.log: Pi build diagnostics PASS; foundation40 frozen source hashes/UI copies/browser contracts PASS; diff check PASS.
- prior-integration-current.log: original7/7; prior-pi-current.log: original11/11; supplementary-current.log: new4/4. Total22 distinct independent current tests. Supplemental four were rerun after relaxing an assertion solely to allow the old adapter's extra final endpoint call; these are the same four cases, not four additional cases.
- prior-integration-old.log:3 expected behavioral failures; prior-pi-old.log:8 expected behavioral failures; supplementary-old.log:4 expected behavioral failures; module-causal-old.log:6 expected behavioral failures. These21 expected historical failures are causal evidence, not failures of current code. Assertions follow actual dispatch/persistence or, for the supplied six module cases, hold-after-production-dispatch synchronization.
- probes.test.mts, fixture.mts, forward.mjs: runnable original integration review evidence, copied into this worktree. independent.test.mjs: runnable original Pi R2 evidence. probe-provenance.json records original/copy hashes and exact unchanged status. prior-chat-r1.txt and prior-pi-r2.txt are byte-identical historical reports. old/ and old-cbe/ contain git-archived historical production source; each src file was compared to git show. No old worktree was modified or used as an execution cwd.
- supplementary.test.mts: four new independent boundary tests. transport-r3.test.mts: current supplied transport test copy with only source paths/old-adapter selection changed, for the six negative comparisons.
- audit.mjs, git-evidence.json, graph-summary.json and *-graph.json: fresh independent esbuild graphs, pins and ancestry audit.

Actual fresh graph results, not inferred from old metadata:
Remote entry packages/pi-runtime/src/remote.ts:255 inputs,498940 output bytes, only node:crypto external.
Actual integration entry tests/chat/integration.test.ts:260 inputs,557116 output bytes, ordinary Node test/process/filesystem/net/crypto imports. The proposed263 count is not reproduced by this command; the complete input map is retained.
Browser packages/application/src/chat-client.ts:1 input,271 bytes,no imports.
The remote and integration graphs exclude Pi Durable/AI/Chord/provider/SQLite implementations, editor/workspace, React/Electron and frozen reference source. Integration counts are for the actual test entry, not a re-export entry, renderer or distributed app. Host fixture code is loaded separately by its Node child, not silently included in the client bundle.

The full Pi suite executes the changed compiled remote under actual Electron45.1.0 RUN_AS_NODE / Node24.22.1 against a separate Node26.13.0 production/faux host. It asserts original admitted receipt recovery and absence of engine/provider/SQLite bundle inputs. No foreground Electron window, Chromium, browser preview, native clipboard or focus operation was opened. The Electron dependency resolved/downloaded its binary; this is runtime-boundary evidence, not packaged desktop acceptance.

Provenance/distribution

dependency-audit.json independently confirms installed Pi Durable/AI/Chord1.4.0, MIT manifest declarations, no LICENSE/NOTICE filenames in those three package trees, and the exact documented OpenAI/Anthropic catalog byte counts/hashes. No manually invented notice bundle or copied third-party application helper was added.

The coordinator notice research is at parent ledger2b3b4c9, not integration132's tracked tree. Its document and passive verifier were read via git show into this ignored evidence directory. Re-ran the verifier against the checksum-pinned existing /tmp archive and THIS worktree's installed dependencies: all323 embedded original sources, all3 README files and all7 named manifest fields per package match release commit4a080252f06caf63a525d7873c5d94d3c23887e0. Source archive SHA256677a2912de35585d17193d7facc5f1b4e106f6b2d22a13d101b237aa324726e8; LICENSE bytes1069/hash0457f5bcec3b3b211605dfb5d1a49042fd638f3686a410fe099c24a25af13c48. source-correspondence.json retains fresh output. This rerun proves correspondence to the pinned local archive; it is not a new upstream tag/network audit or reproducible-build claim. Required copyrights/licenses/assets for the actual shipped host graph and its transitives remain an unresolved distribution gate. The desktop remote graph does not ship this SDK merely because source-host dependencies are installed.

Hosted checks and external blocker

One hosted metadata inspection per target confirmed exact head/base, OPEN and DRAFT. Both show two completed modules checks marked FAILURE. A one-time diagnostic annotation read for one failed job on each PR says: 'The job was not started because recent account payments have failed or your spending limit needs to be increased.' This is a hosted execution blocker, not a local test failure; no hosted current-head pass is claimed. No polling, watch, rerun request, account change or billing action was performed.
PR12 inspected job: https://github.com/ejjsharpe/moonbase/actions/runs/41292528660/job/124806536866
PR15 inspected job: https://github.com/ejjsharpe/moonbase/actions/runs/41294157405/job/124811378858
repository.json, pr12.json, pr15.json and pr12/pr15-annotations.json retain raw evidence. Recovery is for the account owner to resolve the GitHub Actions billing/spending restriction, then run the exact-head checks. This review does not waive that CI gate.

Cleanup and limits

cleanup-summary.json and per-fixture audit-*.json record22 cross-process fixture executions:106 distinct recorded child PIDs and84 owned process-group identities are confirmed absent with ESRCH;64 captured host/forward listener ports rebind. Each independent fixture disposed its roots, released held work, joined the host, restored environment and removed its fresh private config/store directory. In-process Pi probe servers also explicitly close and rebind their ports; their state-* directories are gone. Supplied module/integration suites pass their own host/child/group/port/reader teardown assertions. process-scan.json shows only app-owned tool runtimes and the audit command in this worktree, no test host/forward/native/Electron child. No unrelated process or user data was touched. Only ignored evidence files were written; no tracked source was edited and no review branch commit/push was made.

Not checked: real provider requests/quota/cost/OAuth/network behavior; a real SSH peer/agent/host-key/ProxyJump/remote partition and remote persistence; an actual distributed host/transitive notice bundle; packaged desktop, foreground/native UI/accessibility/human acceptance; optional QuickJS/photon/image/codemode/WASM engines; Node22/other platforms; machine/power-loss durability. Human acceptance stays PENDING. Technical downstream draft work may continue from these exact reviewed commits without a GitHub merge, retaining those gates and the hosted-CI blocker.
