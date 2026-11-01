Independent task05 Pi runtime R1 review — 2026-11-01

What this change does: PR #12 implements a standalone Pi Durable chat host,
bounded saved/live views, exact-task Stop, and an authenticated remote adapter
behind the shared application command handlers.

Verdict: fix findings 1 and 2 before clearing this implementation. Keep DRAFT.
Human acceptance remains PENDING.

PR: https://github.com/ejjsharpe/moonbase/pull/12
HEAD: f6c081dab4ddabbc2c86ee42cdd5637fdba6ef47
BASE: d38833db81c5d97a1aa60f25e0dc27dd670af60f (chore/chat-contract)
Frozen module source: 8bee720445621de20f6a2639808f83d4757377bf
HEAD descends both supplied pins. Changes after the frozen source are only
bun.lock and .github/workflows/check.yml. Node 26.13 host baseline is intentional.
Own isolated worktree: /Users/elliotsharpe/.t3/worktrees/moonbase/t3-a948b3bf
Branch: t3/review-pi-runtime-r1
T3 project: mcp:7cbe46d8-154d-422f-969f-cfaff7f0f0dd (Moonbase)
Origin: https://github.com/ejjsharpe/moonbase.git; private verified with one
GitHub GraphQL inspection. That inspection showed the exact supplied head/base,
open draft PR, and three successful modules CheckRuns. No hosted polling.
T3 linked and confirmed: #1 -> #2 -> #5 -> #6 -> #8 -> #10 -> #12, none watched.

MUST FIX

1. P1 — Unauthenticated requests can obtain a valid signed RPC rejection.
   packages/pi-runtime/src/server.ts:53-61 (especially 53 and 61)
   Connected acceptance: packages/pi-runtime/src/remote.ts:34-36.

   The content-type check and body-limit/read failures happen before proof/grant
   verification. Their catch calls send(..., challenge), which signs the error
   even for an unknown, expired or already-consumed challenge and no Authorization.
   An active relay observing the public nonce/challenge can therefore ask the real
   server for a signed InvalidInput error and substitute it for a genuine reply.
   This changes the authenticated meaning of the reply; it is more than ordinary
   transparent live relaying. It does not bypass authentication to dispatch a command.

   Independent public reproduction: let the production server commit createChat
   or sendChat, consume/discard its genuine successful response, then POST an empty
   text/plain body with only the observed nonce/challenge and NO Authorization.
   The production server returns HTTP 400 with a valid response HMAC. Substitute
   that actual response in the production RemoteChatLive fetch boundary: it rejects
   the original command as InvalidInput. Real SQLite still contains the created
   chat; the Send receipt is admitted and the faux model ran once. No forged HMAC,
   database edits, identity bypass or private implementation calls produce this result.

   Smallest adequate fix: issue signed RPC/application errors only after successful
   request authentication and atomic grant consumption. Fail earlier checks with
   generic unsigned rejection. Test missing-auth malformed bodies against arbitrary
   and consumed grants, including response substitution after an actual mutation.
   If skipped: a caller can receive an authenticated definite rejection for work
   that actually persisted/executed, undermining pending-request recovery safety.

2. P2 — A committed create can be reported as definite Persistence failure.
   packages/pi-runtime/src/index.ts:55, connected post-commit read at :92.

   Host.run classifies unknown createChat failures as Persistence because its
   uncertainty flag covers only sendChat and stopChat. Creation commits its chat
   and request document before reading metadata to build the reply. Failure of
   that later read cannot establish that creation was rejected.

   Independent reproduction: real public create transaction and real temporary
   SQLite; inject a one-shot failure into the public Harness.snapshot reply read
   after startup. createChat returns Persistence, yet a matching retry recovers
   conversation 4 and listChats shows exactly one durable chat (model calls 0).
   This is controlled read-failure injection after genuine production persistence,
   not a claimed naturally occurring disk failure. No fabricated rows are used.

   Smallest adequate fix: preserve Uncertain for creation failures once commit may
   have occurred (conservatively include createChat in mutation uncertainty), and
   retain the immutable creation request for the matching retry. Keep validation
   and proven pre-commit rejection codes specific. Add the post-commit read-failure
   case to the public regression suite.
   If skipped: clients can treat a saved creation as definitely rejected and start
   a different request, leaving a duplicate/orphaned saved chat.

PRIOR OBJECTIONS AND ARCHITECTURE

- Published Pi 1.4 API mismatch: resolved. Installed declarations/implementation
  expose ordinary submit(draft, context), not submit(tx,draft). Moonbase uses real
  request documents, ordinary admission and public submissionByRequest binding.
  Its namespaced request lookup includes Pi's conversation scope; it also checks
  immutable actor/host/store/operation/target/payload at the application boundary.
- Reserved Send/restart: resolved in tested paths. My independent actual child
  test naturally creates a busy reservation, rejects a concurrent process owner,
  SIGKILLs the owner and reopens. Original receipt retained, user entries 1,
  model calls 2, unsafe counted tool effects 1; reserved request remains reserved,
  final state uncertain. Queries/reconnect do not submit it. No DB mutations or
  monkeypatched producer/admission are used for this child evidence.
- Stop/handover: resolved in inspected/tested paths. My actual tool run changes
  task 14 to 20 while retaining the submission. Old Stop returns terminal and
  successor finishes; closing the view leaves execution live. Existing suite also
  exercises real Pi followUp queued withdrawal, null-task non-fallback and later
  input isolation. No claim of external exactly-once effects.
- Full transcript observation: resolved at the application projection boundary.
  Source uses scoped commit invalidations plus a sliding refresh token, not
  Conversation.watch. Actual pure control-character output produced 35 assistant
  plus 35 user entries across four pages, peak serialized snapshot 247,540 bytes,
  without duplicate/skipped IDs. Pi internal cache/storage is explicitly unbounded
  by this delivery guarantee. Existing suite covers eight-of-ten tool previews.
- Normal RPC replay grant handling: 128-grant, monotonic 20-second expiry,
  single atomic consumption and restart invalidation are implemented and their
  real HTTP tests pass. The pre-auth signed-error path in finding 1 remains open.
- Health reusable-secret objection: health uses nonce HMAC, no bearer fallback.
  Remote verifies signed challenge and exact health before disclosing input.
  Normal RPC dispatch requires its own proof/grant. Generation checks reject stale
  success/error responses; old requests do not implicitly Connect or resend.
- One root: production ManagedRuntime construction is in standalone host.ts.
  Named domain methods provide ChatService; serveChat receives the shared
  root-bound client, and RemoteChatLive uses ConnectionService. No parallel
  application dispatcher, transcript/execution store or execution scheduler found.
  Per-conversation admission coordination does not wait for model completion.
- Resource cleanup: supplied cancellation/reader/observer tests pass. Independent
  arbitrary throwing-proxy host finalizer remains observable/sanitized, and the
  actual SQLite store can reopen afterward.

VALIDATION AND ARTIFACTS

All paths below are relative to this worktree's .review-pr12/ directory.

- install.log: bun install --frozen-lockfile passed, no tracked changes.
- nx.log: all six uncached Nx typecheck/lint/test tasks passed.
- test-counts.log: repeated only the test tasks with static logging to retain
  auditable counts: application 33, Pi module 37; zero failures/cancellations/skips.
  This reruns actual CLI/exclusive/crash/deadline tests and compiled remote under
  actual Electron 45.1.0 / Node 24.22.1 against an outside Node 26.13 host.
- foundation.log: verified 40 frozen source hashes, UI copies, browser contracts.
- independent-final.log: 7 fresh public probes; all 7 assertions completed.
  TWO explicitly confirm the defects above; this is not seven correctness passes.
- probes.test.ts: production HTTP response-substitution reproduction; actual
  escaped paging; real tool handover/view disposal; malformed cursor boundary;
  real create/post-commit read-failure reproduction; unknown failing host release.
- child.test.ts, child.mjs: independent actual processes/SQLite/authenticated HTTP,
  naturally reserved busy input, exclusive ownership, crash, and no-resend check.
- typecheck.log: all independent TypeScript probes typecheck without diagnostics.
- graph-result.json, graph.log, remote-metafile.json, renderer-metafile.json:
  independent bundle audit. Remote 255 inputs, 491,070 bytes, only node:crypto
  external; no Pi/Chord/provider/SQLite/editor/workspace implementation. Renderer
  chat-client bundle has one input and no imports. Installed direct pins are 1.4.0;
  both provider-catalog sizes/hashes match PROVENANCE.md.
- hosted.json: sole GitHub inspection, exact PR refs/private state/three successful
  hosted modules jobs. No subsequent CI/PR watch or polling.
- probes.log and child.log retain intermediate runs; independent-final.log is final.

Read complete OVERNIGHT, AGENTS, README, MODULES, glossary, CHAT, connected handler,
service/runtime/health boundaries, module implementation/tests/docs/provenance and
research, source-snapshot provenance description, and installed public Pi source.
No original escode access. No implementation edits, commits, pushes, delegation,
PR comments/watches/merges, deployments, provider quota or real SSH connections.

HONEST LIMITS AND CLEANUP

The installed direct Pi/AI/Chord manifests say MIT, but recursive filename audit
found no LICENSE/NOTICE file in these installed packages. This is not an audited
distribution notice bundle. Final packaging must resolve actual required notices;
the statement that normal dependency notices remain installed is not sufficient
evidence for that future gate. No notices were removed or manufactured here.

Source CLI and compiled remote execution are controlled local evidence. Real
provider/auth-refresh/network APIs and cost, explicit SSH host/host keys/ProxyJump,
remote persistence/partitions, distributed host/app packaging/signing, native UI,
accessibility/human acceptance, other platforms/minimum Node and power loss remain
UNRUN. Node 26.13 host guard is intentional; Electron Node24 remote qualification
is separate. SSH source review at 1aec does not qualify a real remote workflow.

All own child PIDs and process groups joined/gone; actual child listener ports
60791 and 60862 successfully rebound after cleanup. Fixture runtimes/listeners
closed, fresh temporary stores removed, and no preview opened. Tracked files
remain identical to exact HEAD; only untracked .review-pr12 artifacts remain.

Verdict: fix 1 and 2 first. No implementation acceptance or human acceptance.
