# Composition R1 repair — PENDING independent review and HUMAN ACCEPTANCE

PR20 base remains PR19 `d79d1e9b8347f7f5f19cdbe9aad0233a0c47be8d`.
Additional prerequisite: focused DRAFT [PR21](https://github.com/ejjsharpe/moonbase/pull/21),
`fc547673c519871136388f6e5cc0e4fdc1d9bd6a`, based on standalone14
`4dd148ade5f279e2b3820df0325313ee08ce4f8d`. Published clean before composition adoption.
Normal merge `0efb222e424f5a46bdc52fa8aa7181ba8ba3a41b` has preserved8a and exactfc547
parents. All original14/16/4/8a checkpoints remain intact. Editor tree is byte-equal PR21.

Product checkpoint: `e65a0551db7e9c9e75efd1bc07773c4dd590217b`.
Final native qualification/test checkpoint: `f66deaa246f956f6318f3da7a44f1536ee72b230`.
Later commits only record docs/evidence; production bytes equal product checkpoint.
No root manifests/lock/CI/shared UI/application/workspace/chat/Pi/SSH implementation
changes. Same isolated/private Moonbase binding, original Sol xhigh/default, no children,
review launches, PR polling/watches/merges, deployment, real provider/SSH or original escode.

## R1 findings and response

Full authoritative report: coordinator `docs/overnight/reviews/composition-r1.md`;
immutable report/probes remain at `/Users/elliotsharpe/.t3/worktrees/moonbase/t3-95174512/apps/desktop/test-results/review-task08-r1`.

**P1 fresh-edit document Reload loss:** the smallest module-owned public
`EditorSnapshot.recoveryReady` tracks capture generation and accepted exact publication.
It synchronously vetoes queued debounce/in-flight ordinary publication, unresolved Save/
operation/publication, preservation and later edits. Only the existing exact receipt
confirms its captured generation; failed publication invalidates earlier consent.
No equality/loaded-latest ownership guess, new journal/runtime/shared command, dirty
blanket veto or asynchronous flush while permitting unload. Confirmed dirty drafts reload.
See [standalone response](../reload-preservation/response.md) for focused implementation,
9 public readiness regressions and old/new native evidence. Explicit Quit still takes
Save/Discard/Cancel; successful earlier Save/Discard facts remain when later chat vetoes.

The normal merge retains reviewed chat beforeunload preservation and unload cleanup,
adds editor readiness to that predicate, and retains both native resource boundaries.
Committed unload releases exact old observers/waits; veto disposes none. Renderer loss
retains the same process root/native approvals and never Stops or shuts down the host.
Editor-only cleanup remains independent in PR21 with no chat/Pi/SSH dependency.

**P2 present-empty configuration:** only `undefined` chooses unconfigured local editing.
Every present string passes the existing private validator. Empty now exits1 with its
absolute-private-config error, as do missing/malformed/insecure/symlink paths. Absent
config starts usable local editor; valid private config starts disconnected with no
Connect/Send/model/tool effects. No credential or endpoint reaches renderer.

## Causal and current proof

The SAME timed native driver runs against copied reviewer4dd37ad and8a96d74 builds and
current standalone/composition source/package. Native insertText -> two frames -> public
recovery read -> native Reload, with NBSP normalization only and no debounce wait for the
fresh-edit negative. Four retained NEW old cases reach the intended tail-loss assertion.
One earlier NEW4dd package rerun failed its235.7ms precondition BEFORE the causal assertion;
its separate isolated17.9ms rerun reproduces loss. Current standalone and composition
source/package veto the fresh edit, retain the tail, later commit durable-dirty Reload,
restore the tail and Save deliberately. No old product approval clears this interval.

Empty old8a source/package failed the desired startup-exit assertion and required bounded
owned-group termination because startup remained alive. Independent R1 separately records
actual UI unconfigured fallback. New source/package matrix passes empty +4 other invalid
values, absent and valid private controls. Test fixture's initial getChatHost is measured
before launch, not misclassified as automatic application connection.

| Phase | Final result |
| --- | --- |
| Standalone frozen +12 uncached Nx diagnostics/tests |226 PASS (editor115/application14/workspace91/desktop6)|
| Standalone real editor integration |15 PASS; total241 Node/integration|
| Public readiness addition |9 PASS within editor115|
| Preserved module Chromium |35 PASS|
| Standalone Electron / packaged existing journey |25 PASS /1 PASS|
| Standalone targeted source / package |4 PASS /4 PASS|
| Composed frozen +21 uncached Nx diagnostics/tests |380 PASS (application33/editor115/workspace91/Pi53/SSH43/chat38/desktop7)|
| Composed real editor / controlled chat integration |15 PASS /7 PASS; total402 Node/integration|
| Both application builds + unsigned desktop package |PASS; pinned Electron45.1/Node24.22.1, restricted PATH|
| Composed source / package full navigation/lifecycle |12 PASS /11 PASS|
| Composed unconfigured targeted editor source / package |4 PASS /4 PASS|
| Config matrix source / package |3 PASS /3 PASS (5 invalid strings inside each matrix)|
| Independent real public adapter probe |PASS; late old observer/finally vs reused ID, cancellation, concurrent Save/Send, exact Stop|
| Foundation / actual renderer / package graph-notice checks |40 PASS /1588 inputs,5 workers+font /PASS|

These phases overlap scenarios; do not add native assertions into402. Full composed
cases preserve dirty editing during live tools, two chat drafts, keyboard/pointer focus,
no-resend reconnect/restart, exact Stop, close/Hide/Quit independence, conflict/uncertain
publication and final latest-chat veto. Added fresh-editor veto retains both views and
all recorded observers while a real remote tool continues. Read-only waits do not veto.

Native source/package14 captures are indexed in screenshots.json (12 composed normal,
dirty/restored/keyboard/native200%1180×820 and700×650, plus2 fresh-tail captures). Native
capturePage follows two frames; sidecars retain bounds/zoom/DPR/PNG sizes/digests. Narrow
200% is cramped and uses wheel/Tab; actual Stop/Send reachability assertions pass. Current
packaged constrained and fresh-tail captures were inspected; no manual accessibility claim.

## Failures and evidence corrections retained

- Initial composed full source11/12 and package10/11 failed the long journey's assumption
  that native Reload committed. Chat remained selected; no lost text was demonstrated.
  **Initial veto cause remains UNEXPLAINED.** Logs and original traces remain intact,
  mapped in raw-traces.json. The positive driver now records will-prevent-unload versus
  did-finish-load and makes bounded explicit native Reload attempts, never forcing unload.
  Both final runs record `["veto","reload"]`, then restore text and continue no-resend
  lifecycle. Later success does not explain the earlier vetoes. Persistent veto would
  remain a product blocker; it did not persist in these final controls. No product retry.
- Initial config source/package2/3 failed an empty-command baseline expectation: fixture
  startup had already issued getChatHost. Corrected prelaunch baseline +public disconnected
  snapshot yields3/3. This is distinct from P2's actual empty-config validator repair.
- A corrected-driver rerun was mistakenly launched from repository root, so relative
  harness resolution failed before the product path. First test timed out,11 did not run;
  SIGINT targeted verified runner28967. Exact fixture SGYcmq remained after interruption;
  runner28967/worker28983/host28985/group28967 were checked ESRCH, its known port60907
  rebound, then only that exact owned directory removed. wrong-cwd-cleanup.json preserves
  this separate phase; it is not counted as product RED or normal automatic teardown.
- Independent public probe initially ran outside app workspace links and could not import
  @moonbase/chat-probe BEFORE setup. Generated test then ran within apps/desktop using
  normal links, no alias/lock workaround; assertions unchanged. Provenance/log retained.
- Earlier local dynamic-import/Electron evaluate argument/type-wrapper observations are
  in tool history, but their first local raw files were DELETED as below. Do not claim
  those files survived. Independent reviewer raw records remain their own evidence.

**Evidence loss:** initial local archive copies96d74/37ad and local targeted logs/traces
under apps/desktop/test-results were cleared by preserved Playwright's default outputDir
before commit. They did NOT survive and were not recovered. Committed8a evidence and
reviewer immutable artifacts were untouched. NEW read-only reviewer fresh-build copies,
with matching known hashes, and NEW reruns live under
`.overnight-artifacts/reload-r1/dist`, outside every runner cleanup root. Replacement copies
are not the original physical owner archive. Evidence-correction.json in PR21 inventories
loss/survivors/new paths. All later outputs are explicit unique directories; logs/archive/
provenance files are siblings, not inside runner outputs. No binaries or ignore config
change in final diff. Do not repeat the old cc06 equivalence mistake.

## Artifacts and retained limits

Current composed asar:
`f0f7380cad57d5abd733ff28f02117d3c58e970453af78080dc0391c36cd55eb`.
Standalone follow-up asar:
`2d80155594f4912c2604983e0eb16c942b479140cd81723ee113019503740df2`.
Old reviewer-copy8a96d74 /4dd37ad provenance is explicitly separate. Source-artifact.json
maps every selected product/test input, exact base/merge/commits and archive. Package audit
checks actual bytes/main271/renderer1588 inputs, executable external helper/qualified rg,
5 workers/font and generated actual dependency/release notices. No fixture/host/Pi SDK/
provider implementation/test metadata in production main/preload/renderer/archive;
renderer excludes Node/FS/SQLite/Effect root/workspace/SSH/remote implementations.

The complete prior22 editor/13 workspace/Save-publication/import/filename/menu/Pi/SSH/chat
findings remain their own retained reports and current regressions, not newly rerun every
historical causal matrix. Original rapid lookup dismissal, Undo/Redo timing/Reopen settling,
and historical Create-disabled observations remain UNEXPLAINED/UNATTRIBUTED. Initial
synthetic Trash cleanup remains UNPROVEN/no safe path or inode/no sweep. Original cc06
binary remains lost/no digest; reconstructed4f59 remains NEW. Old owner all3-observer
observation and independent R1 chat-observers-DID-cancel difference are both retained.
All prior failed harness, native/cropped capture and trust-boundary limits remain in
previous validation/report files, unchanged.

## Cleanup and next gate

cleanup-final.json gives separate retained phase counts/identities; every recorded PID
and group ESRCH.100 distinct captured ports (including4176 and separate interrupted60907)
bind/listen/close. Final current source12:57 Electron/helper IDs,12 hosts,26 forwards/groups,
25 ports. Final package11:49 Electron/helper IDs,11 hosts,25 forwards/groups,23 ports.
Current unconfigured editor4+4:20 PIDs each; config3+3:13 IDs plus1 host and5 invalid-launch
groups each. Initial failed phases and public probe have separate records, not a fabricated
combined census. All identified new fixture directories are absent. Original unidentified
Trash residue is outside this claim. Deleted initial local phase records and preserved
editor25/package1 do not gain an invented exhaustive PID count; existing teardown plus
final scoped inventory is the evidence for those. No owned foreground/listener remains;
preexisting Nx daemon is left untouched. Negative/fault paths with configured bridges
publicly Disconnect before intentional exit; pre-render wrong-cwd had no bridge/connection.

No hosted inspection/rerun/poll; prior billing/spending block remains external, no new
hosted pass claimed. Real SSH/provider/quota/host distribution/optional assets, signing/
notarization/Intel, OS gestures/Finder Put Back, VoiceOver/manual human acceptance,
performance/full-volume/instruction-level crash/powerloss remain UNRUN/PENDING.
Both PRs remain DRAFT. Coordinator must arrange NEW exact-head independent review.
