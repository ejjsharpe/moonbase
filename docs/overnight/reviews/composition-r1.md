# Task08 PR20 R1 and PR19 test-seam delta — independent review

What this change does: PR20 composes the local editor and optional remote chat in one desktop process root, with mounted views and shared public handlers. PR19's successor exposes the existing controlled test fixture for composition tests.

**PR20 at `8a1636902b129f2fd6e04d26cfa75dd2e90ee415`: NOT CLEARED.** One P1 data-loss finding and one P2 configuration finding are confirmed below. Keep DRAFT and HUMAN ACCEPTANCE PENDING. No source fix was made.

**PR19's exact DFF→D79 test-only seam at CURRENT `d79d1e9b8347f7f5f19cdbe9aad0233a0c47be8d`: NO BLOCKING FINDINGS in that delta.** This explicitly qualifies the successor export, rather than extending the old DFF verdict without inspection. It is not blanket approval of inherited desktop behavior: the newly discovered P1 also exists in standalone4dd, and D79's desktop source is byte-equal to4dd.

**Foreground slot explicitly released after verified cleanup. No further native/browser phase is running or scheduled.** The coordinator still owns repair assignment, any new independent review, final audit and overall handoff. This report does not complete the overall goal.

## New findings

### P1 — deliberate Reload loses an edit visible before the recovery debounce

Location: [apps/desktop/src/renderer/main.tsx:32–38](../../src/renderer/main.tsx), specifically the beforeunload predicate at34 and disposal at38. Connected public controller: `packages/editor/src/editor.ts:212–216` schedules recovery after150ms; `flush():300–305` publishes the captured state; `dispose():838–843` cancels the pending timer and requests.

A dirty buffer can contain a newer edit while `preserving`, `publication`, `saving` and `pendingSave` are all false. The unload predicate allows Reload in that state. The document commits its unload, the scheduled publication never occurs, and the next document restores the older recovery text. This is an ordinary explicit native Reload, not force-kill, simulated power loss, a corrupted store or a fabricated private-controller result.

Exact reproduction in [fresh-timed.spec.ts](fresh-timed.spec.ts), through actual source Electron and the unsigned packaged app:

1. Use a fresh temporary Git checkout, explicit fresh user-data and real Workspace/SQLite. Native picker approval opens `a.ts`; type `local dirty draft` through Monaco.
2. Await public IPC `loadRecovery` showing exactly that text. Focus Monaco and move to End.
3. Use actual `webContents.insertText(" fresh visible tail")`, then await two animation frames. Record the DOM input timestamp and visible Monaco text. Query real recovery through the public IPC client without replacing timers.
4. Invoke actual `webContents.reload()`. Observe `did-finish-load`, not `will-prevent-unload`.
5. The old document visibly contained `local dirty draft fresh visible tail`; the new document and real persisted recovery contain only `local dirty draft`. The desired retention assertion fails. Teardown publicly Disconnects before intentional fault exit and removes only the fixture.

| Exact product | Input→two-frame/public-read observation | Outcome | Retained text after Reload |
| --- | ---: | --- | --- |
| Current8a source |21.5ms|Committed Reload|`local dirty draft`|
| Current8a package |19.3ms|Committed Reload|`local dirty draft`|
| Standalone4dd source |24.1ms|Committed Reload|`local dirty draft`|
| Standalone4dd package |17.0ms|Committed Reload|`local dirty draft`|

All four observations are below the unchanged150ms debounce. The JSON records include public recovery before and after, timestamps, visible text, exact targets and outcome. They do not expose the controller's private timer; timer state is established by source inspection plus the measured public/visible behavior. Monaco renders spaces as NBSP in DOM text; assertions normalize only that presentation detail.

Evidence: `current-fresh-timed-{source,package}/composition/fresh-reload.json`, `standalone-fresh-{source,package}/composition/fresh-reload.json`, their logs/traces and native captures. [Current packaged post-Reload capture](current-fresh-timed-package/composition/package-fresh-reload.png) shows the older draft. `supplementary-source-corrected` and `supplementary-package` contain two earlier independent current reproductions. No failed current assertion is reclassified as green.

The same timed driver runs unchanged against all four products. Current asar is `96d74c67389db0c3d41083d6b39b01f79844b60ddfeada48619625c1351e74e3`; fresh standalone4dd asar is `37ad94c692afbde6b2b9a6afabfda6272425e98470e5557419e1b83818ba2f8d`, exactly matching the earlier standalone R2 artifact. Source/package maps are in [source-artifact.json](source-artifact.json). **This defect predates composition; it is not introduced by the new unload/dispose path.** Standalone4dd already permitted unloading before the debounce. D79 and4dd have identical desktop source tree `b640861355e5961f55ad75d0aca88b34d44b8cc4`. Prior standalone approval did not exercise this interval and cannot clear it.

Independent [fresh-public.mjs](fresh-public.mjs) also uses public `createEditor`, real WorkspaceLive/Git/SQLite and one root. After a fresh edit, all fields tested by the current unload predicate are false. Replaying the shell's allowed-unload/dispose sequence restores the older text. Explicit public `flush()` before disposal retains the fresh text; both observations are asserted in `fresh-public.json`. This demonstrates the existing preservation operation, not permission to dispose an arbitrary controller without its documented successful preservation gate. It does not prove a bare flush alone handles edits racing an asynchronous flush.

**Smallest adequate fix:** make document unload depend on confirmed preservation of the latest editor snapshot, including the debounce interval. Veto unload while that preservation is pending, failed or uncertain; retain the live document and exact immutable publication until resolved. If Reload is retried after public preservation, any subsequent edit must invalidate that consent. A conservative veto for an unconfirmed dirty snapshot is acceptable; adding a delay, starting an asynchronous flush while still allowing unload, or clearing dirty state is not. Preserve successful-reload cleanup, same-document veto, chat preservation and the existing exact-receipt semantics. Add this fresh-edit source/package regression plus a changed-during-preservation case. Shared public contract changes, if needed, belong to the coordinator/module owner.

### P2 — a present empty configuration silently takes the absent branch

Location: [apps/desktop/src/main.ts:34](../../src/main.ts). `process.env.MOONBASE_CHAT_CONFIG ? readConfiguration(...) : null` treats an empty value as absence.

Launch the actual source or package with fresh user-data and `MOONBASE_CHAT_CONFIG=""`. Startup succeeds, `window.moonbase.chatConfigured()` returns `{ok:true,value:false}`, and Chat displays the ordinary “not configured” explanation. The required fallback is for configuration **absence**; a present invalid value should follow the configuration-error path. A shell variable expanding to empty therefore silently disables the explicitly requested capability and hides the setup error.

[config.spec.ts](config.spec.ts), `config-{source,package}/empty-config.json`, logs and traces establish both actual executions. Separate cases verify missing file, malformed JSON, insecure mode and symlink input exit1 before main reaches renderer creation. Those four errors in each product retain stderr evidence and do not silently fall back.

**Smallest adequate fix:** distinguish `undefined` from a present string, pass every present value through the existing configuration validator, and test empty configuration alongside other invalid inputs. No renderer credential exposure, automatic connection or destructive effect was observed from this defect.

## Exact authority, refs and scope

- [PR20](https://github.com/ejjsharpe/moonbase/pull/20): OPEN/DRAFT, `feat/workbench-composition` → `chore/workbench-integration`; HEAD `8a1636902b129f2fd6e04d26cfa75dd2e90ee415`, BASE `d79d1e9b8347f7f5f19cdbe9aad0233a0c47be8d`.
- [PR19](https://github.com/ejjsharpe/moonbase/pull/19): OPEN/DRAFT; HEAD `d79d1e9b8347f7f5f19cdbe9aad0233a0c47be8d`, BASE `4dd148ade5f279e2b3820df0325313ee08ce4f8d`. Previously reviewed checkpoint `dff2ece7503aef4159994e8e169dd29180842a4d` remains distinct.
- Registered project `mcp:7cbe46d8-154d-422f-969f-cfaff7f0f0dd`, Moonbase root `/Users/elliotsharpe/Projects/moonbase`, isolated bound worktree `/Users/elliotsharpe/.t3/worktrees/moonbase/t3-95174512`. Git/GitHub agree on private `ejjsharpe/moonbase` and origin `https://github.com/ejjsharpe/moonbase.git`.
- Initial clean parent ledger `bb39a0381e64d6399e6cd015e0563cbc20462197`; created NEW local branch `t3/review-task08-r1-8a16369` at exact8a. T3's existing branch label remains `t3/task08-pr20-test-seam-review`; this is not a claim that the UI label changed. No original, parent or old-owner checkout was switched, rewritten or executed.
- T3 catalog confirmed codex/gpt-6-astra, xhigh/default. One reviewer, no children. No tracked source changes, commits, pushes, PR comments/edits, watchers/polls, merges, deploys, provider quota, unspecified SSH, host-key bypass, clipboard access or original escode access. Only ignored evidence/dependencies/builds and fresh owned fixtures were written.

`git-evidence.json`, `git-audit.py`, `repository.json`, `t3-binding.json`, exact `pr*.json` and `link-summary.json` retain the records. All19 requested PRs are linked and watching=false: [1](https://github.com/ejjsharpe/moonbase/pull/1), [2](https://github.com/ejjsharpe/moonbase/pull/2), [5](https://github.com/ejjsharpe/moonbase/pull/5), [7](https://github.com/ejjsharpe/moonbase/pull/7), [3](https://github.com/ejjsharpe/moonbase/pull/3), [4](https://github.com/ejjsharpe/moonbase/pull/4), [11](https://github.com/ejjsharpe/moonbase/pull/11), [13](https://github.com/ejjsharpe/moonbase/pull/13), [16](https://github.com/ejjsharpe/moonbase/pull/16), [14](https://github.com/ejjsharpe/moonbase/pull/14), [6](https://github.com/ejjsharpe/moonbase/pull/6), [8](https://github.com/ejjsharpe/moonbase/pull/8), [9](https://github.com/ejjsharpe/moonbase/pull/9), [10](https://github.com/ejjsharpe/moonbase/pull/10), [12](https://github.com/ejjsharpe/moonbase/pull/12), [15](https://github.com/ejjsharpe/moonbase/pull/15), [18](https://github.com/ejjsharpe/moonbase/pull/18), [19](https://github.com/ejjsharpe/moonbase/pull/19), [20](https://github.com/ejjsharpe/moonbase/pull/20). Unrelated17 is excluded.

Verified ancestry includes D79/DFF, editor4dd/473, workspace38c, chatdbd, Pi235 and SSH1aec; exact supplied bases are ancestors/merge bases. PR20 changes only `apps/desktop/**` from D79.8a differs from `903ece141847d64544681d2a73f61b9f404b026e` ONLY in desktop README. Product source equals `b4f514d682927a2d65a08af0d08bfe7adb7534e3`; tests equal qualification `7147a1352c7d699a8f60eb62815775b963eb764d`; build/package scripts equal b4f. The later package-audit script is a separate evidence input. All source/manifests/evidence/artifacts apart from the README are byte-equal903. The corrected chat command names real build/start scripts and the dependency paragraph now identifies PR20/#19. Both app builds ran; the standalone chat GUI suite and the literal build/start CLI pair were not rerun as another foreground app. The build/start scripts and their entry paths resolve correctly; source/native composition tests exercise the exported adapters.

## PR19 successor and architecture/trust review

DFF→D79 changes ONLY `MODULES.md`, `apps/chat-probe/package.json` and `docs/overnight/workbench-integration.md`. The new `@moonbase/chat-probe/test-fixture` export resolves directly to existing `./test/fixture.ts`; fixture source/test tree remains byte-equal reviewed chatdbd. No copied provider or protocol implementation, lock/dependency version change or production wrapper is introduced. The fixture imports real public application/remote/SSH APIs, launches the existing production HTTP/Pi/SQLite test host with official faux provider, and uses the existing controlled forwarding child. Pi dependencies remain dev dependencies in the proof. Installed fixture/SDK presence is distinct from bundled client inputs.

Read target AGENTS/README/MODULES/DESIGN/GLOSSARY, complete common/08/09 briefs, all supplied full desktopR2/chatR2/PR19R1/owner records and full PiR3 integrationR2; application recovery/chat/connection/host contracts; connected main/preloads/session/wire/renderer/root composition; public editor/chat controllers, handlers/runtime client/services; workspace/Pi/SSH resource boundaries and relevant tests; build/package/notice inputs and frozen source provenance. Frozen close-preservation and activation behavior was consulted as reference, not old application code execution. Review assumes the requested personal workbench and explicit controlled host/store, not multiplayer or unbounded scale.

One selected ManagedRuntime composes WorkspaceLive alone when configuration is absent, or WorkspaceLive + RemoteChatLive with one shared SshLive for a valid present configuration. The empty-string exception is P2 above. Shared editor/chat/connection clients and WorkspaceNative use that same root. No startup Connect/Send, feature root runtime, nested standalone runtime, scheduler, extra transcript store or global operation queue was found. Long public Send/read waits do not own unrelated Save/status/Stop.

Both Base UI panels stay mounted. Keyboard uses manual Arrow then Enter activation; pointer restoration is separately retained. Models, undo and independent chat drafts survive view switches/Hide. Native picker/keyboard/IPC paths enter public handlers. Local host/checkout/project/root/branch identities remain separate from remote host/store/cwd even for equal strings. Remote output is plaintext/descriptive; no synchronization, guessed local mapping or remote open authority is added.

Owned webContents, main frame and exact document URL are authenticated before ProofSession. Config private key/token/endpoint remain privileged; only public context crosses the bridge. DTO/operation allowlists, caller/target validation, bounded requests, typed errors and public cancellation/preabort remain. The actual composition IPC test rejects foreign-window calls, foreign host, extra/prototype operations before host dispatch. Preserved editor IPC cases cover nested local authority and native token scope. Same-origin srcdoc parent-bridge access under privileged evaluation remains the prior limit; CSP and ordinary app data paths are separate controls. This is not arbitrary renderer-compromise immunity.

Document release preserves editor approval registry/root; renderer loss clears stale Quit correlation and releases old view resources without Stop/Disconnect/root disposal. The imported chat native-session implementation is unchanged from dbd. Desktop EditorSession/preloads are the actual new adapter behavior, not merely PR19's export. Current6 public session cases plus independent `public-real.mjs` verify real watch release, late old watch suppression after ID reuse, and an old completion's finally not deleting a new slot. Public failures remain typed; actual runtime observation interruption reports non-cancellation causes through the existing error callback. No new swallowed unknown cleanup path was found in this review; physical/unknown OS failures are not broadly certified.

## Fresh checks and interactions

All qualification below ran in this review worktree at exact8a, except the explicitly identified historical archives. Logs and runnable probes are beside this report.

| Check | Result |
| --- | --- |
| Frozen install / lock unchanged / qualified rg |PASS; blocked lifecycle scripts not enabled|
| Foundation provenance/UI/browser contracts |40 PASS|
|21 uncached Nx typecheck/lint/test targets|370 PASS: application33/editor106/workspace91/Pi53/SSH43/chat38/desktop6|
|Real editor/workspace integration|15/15 PASS|
|Separate-host production HTTP/SQLite/controlled forwarding integration|7/7 PASS|
|Both app/dependency builds|6 uncached tasks PASS|
|Current composition/lifecycle source|11/11 PASS|
|Current composition/lifecycle unsigned package|10/10 PASS|
|Preserved editor Electron suite|25/25 PASS|
|Preserved packaged resources/editor journey|1/1 PASS|
|Editor Chromium journeys|35/35 PASS|
|Independent combined-root real public probe|PASS|
|Latest-chat Quit veto after confirmed Save/Discard|Source/package PASS; repeated source setup also PASS|
|Fresh-edit Reload|Current source/package RED, independently confirmed with timed driver; standalone4dd source/package same RED|
|Invalid configuration matrix|Four startup rejections in each source/package PASS; present-empty desired assertion RED in both|
|Historical cc06 final keyboard/lifecycle drivers|Two intended failures each in fresh source/package; clean teardown|
|Actual graph, package byte and notice audit|PASS|

370+15+7=392 shipped Node/integration tests. Native/browser/independent executions are separate phases, not added into392. Lint is repository TypeScript diagnostics. Public real tests exercise files/Git/SQLite/native effects and production protocol; faux provider and controlled TCP forwarding do not prove real provider networking or an SSH handshake.

Fresh source/package interactions cover dirty editor during a held actual remote tool; two chat drafts; pointer and actual keyboard navigation/typing; lost admitted Send reply and explicit reconnect/restart/query without resend; exact captured Stop; file/chat-view close, Hide and client Quit without Stop; Save/Cancel/conflict/Discard and immutable unknown publication retention. The source-only delivery fence holds an actual committed Save result while chat/status/Stop remain usable. A held admitted Send in both builds leaves local Save/read/status/Stop usable. Queued-null withdrawal and stale-null-versus-running-task distinctions ran through the actual Pi public module regressions; no claim that the native suite manufactured a queued task is made.

Independent supplementary Quit tests Save `a.ts`, Discard dirty `b.ts`, replace chat storage after Save but before the final gate, then observe latest-chat preservation veto. Confirmed Save/Discard facts stay committed, newer chat/live window remain available and external replacement bytes stay unchanged. Successful facts are not rolled back by the later veto. Initial chat storage veto occurs before any destructive editor choice in the supplied native cases.

`public-real.mjs` uses real combined services and exported config/session/fixture. It proves no implicit connection, document release with retained native authority, stale callback/ID reuse guards, pre-aborted read rejection, real admitted Send cancellation as a wait result with admitted receipt retained, concurrent real Save/status, and exact complete captured Stop input with one Send/one Stop. Delivery holds concern real public results, not invented controller outcomes or DB edits.

The current lifecycle source/package cases cancel the exact old editor observer, both chat observers and known held read-only wait on committed Reload. Same-document veto cancels none and retains observers. Forced renderer loss releases native watches, preserves already durable drafts/connection, and accepts deliberate Save after recovery without replay. The crashed Playwright Page is not used as recovery authority; production Electron execution/native keys exercise the recovered document. These successful cases do not cover the fresh unpersisted-edit interval now reported as P1.

## Owner product reds: independent dispositions and binary limits

**Keyboard focus: causally cleared for the stated defect.** The SAME final composition driver bytes, SHA256 `c7cea1c946a4fad94977e7c0df712c980452ed037de1d662fa65c84b87e29b5b`, run against current and fresh archived cc06 source/package. Old fails after Arrow+Enter and two frames: active element is Monaco TEXTAREA rather than the Editor tab. Current passes the complete tab-order/lookup/typing/draft journey; separate pointer return passes. The fix at renderer76 restricts focus restoration to `MouseEvent.detail > 0`, preserving Base UI manual roving focus. Earlier8 source greens did not cover this route. The initial Arrow-only and subsequent fixed-Tab-count driver mistakes are harness corrections, not product fixes.

Original actual red source is `cc06d753e76dc02470628a611a3a481f771953b9`. Its original asar was overwritten before digest capture; trace lacks loaded bytes. It remains **UNAVAILABLE**. The recorded `240b0ce39bd81e19a8c3637d5125b272a3dbb3a08ed017d6aaaddc0b0edb7dee` renderer-source hash does not recover the lost original binary. This review independently rebuilt an own archived cc06 checkout, froze its dependencies and verified source bytes. New reconstructed asar `4f59a6c209607daf72a253315bbf04fda2dcf95ed9bf4b91007c8a604b159993` matches the owner's reconstruction; renderer chunk `2a42c79892ac09bc1099858ffb099cb4e5b765299381abc179014d233a8e9ec9`. It is a NEW artifact, never claimed equivalent to the unavailable original package.

**Committed-unload resource leak: causally cleared for tested resources, with an observation difference.** Identical current lifecycle driver fails old source/package and passes current. In this review's old runs, both chat observer IDs DID cancel, while the editor observer and known held read-only wait DID NOT. `historical-{source,package}/lifecycle/*-reload-before-check.json` records exact IDs. This differs from the owner's observation of all three old observers uncancelled; I do not replace my observations with that assertion. Current cancels all four exact resources and preserves connection/durable drafts. Veto and renderer-loss cases pass. Neither this clearance nor the public session6 tests clears fresh-edit P1.

All old-source/package causal failures end at intended focus/cancellation assertions, with successful fixture teardown. No timeout masking, recovered orphan group or historical teardown failure occurred in these fresh comparisons.

## Prior dispositions retained, without borrowing historical causality

Full earlier records remain [desktop R2](../../../../docs/overnight/reviews/desktop-r2.md), [chat R2](../../../../docs/overnight/reviews/chat-proof-r2.md), [Pi R3/integration R2](../../../../docs/overnight/reviews/pi-r3-chat-integration-r2.md), [PR19 R1](prior/workbench-integration-r1.md), and [owner composition evidence](../../evidence/composition/validation.md). Exact unchanged modules and fresh public/integration/browser/native regressions support non-regression. Old producers/packages were NOT rerun for every earlier finding; only cc06 keyboard/lifecycle and4dd fresh Reload comparisons are newly causal here.

All22 original editor dispositions remain individually retained:

- R1.1 collision retains both drafts/evidence; R1.2 late-checkout position/teardown; R1.3 definite Save rejection versus immutable uncertain retry; R1.4 missing dirty tab retention/open failure; R1.5 closed-checkout metadata/history; R1.6 initial discovery and closed no-IO; R1.7 stale activation versus newer checkout; R1.8 lookup-to-Monaco focus.
- R2.1 persisted replacement drafts; R2.2 rejected mutation remains usable; R2.3 current-source survivor restoration; R2.4 visual/MRU navigation typing focus.
- R3.1 newer selection survives publication; R3.2 Close/Reopen typing, cancellation and failures.
- R4.1 fallible close preflight retains drafts and exact final receipt governs consent; R4.2 background survivor; R4.3 editable working comparisons/read-only originals.
- R5.1 observation versus Reload/Close preservation, no resurrection/duplicate acknowledgement; R5.2 absent-buffer activation after preservation.
- R6.1 delayed Copy cannot resurrect a confirmed-close target; R6.2 restored dirty comparison original/baseline/failure retention.
- R7.1 recreated working-buffer readiness for staged/unstaged views.

New P1 concerns native document Reload before recovery debounce, not a reopening of the already tested controller Reload/Close disposition above. Filename own-property/prototype metadata and bounded menu fixes remain covered by current actual source/package and browser tests. Native import/Create empty-destination/source defects remain cleared; replacement veto/single-use tokens pass. Original lost/reordered Save P1, rejected-publication P1 and transient-alert P2 remain covered by current module/integration/browser/native tests.

Workspace13 dispositions remain at unchanged38c source, with current91 regressions:

1. Actual-spelling/case alias Save refusal, with deliberate case-only rename retained.
2. Native import self/descendant rejection before replacement Trash.
3. Immutable full-input actor/request binding and one effect on concurrent conflicting reuse.
4. Durable original lost-response revision receipts under concurrent recovery.
5. Copy recovery capacity preserves all drafts/pending evidence rather than committing an unloadable snapshot.
6. Admitted Save text/baseline restoration without hiding it under an older draft, while later publications win.
7. Atomic native-token ownership and admitted multi-item expiry lifetime.
8. Complete grouped interrupted-Save restoration/capacity retention across loads/restarts.
9. Local MOVE/COPY ancestor replacement rejection before admission/Trash.
10. Overflow-group retry cannot advance only one member.
11. Explicit client-publication causality is separate from internal Save/Move revisions, including command-start preflight fences.
12. Earlier journals without a command-start fence cannot infer order from a complete internal receipt chain; retain unknown-order evidence.
13. Missing per-client publication metadata cannot satisfy observer acknowledgement via internal updates; only explicit publication establishes its fence.

Known closed-checkout registry/open membership, origin/observer identities, immutable receipt/CAS behavior and actual-producer provenance remain. Current regression fixtures use real previous public producers, not speculative DB-edited causal histories. No legacy import or physical-durability claim is made.

Pi signed-error oracle P1, postcommit Create P2 and postdispatch generation-loss P2 remain resolved at unchanged235. Current53 Pi/7 integration cover raw proof/live-grant ordering, preserved original Create identity, and Uncertain after actual dispatch versus pure Cancelled waits, retaining combined cleanup causes. Prior independent relay/commit/old-adapter causal matrices remain their own evidence. Two-phase ordinary Pi submission, public submissionByRequest, exact task/null Stop, bounded previews/pages/tool projections, view disposal and SQLite ownership remain covered. Pi is execution/transcript authority; no external exactly-once claim.

SSH's four fixes remain resolved at unchanged1aec: early/coalesced Disconnect releases pre-start waiters; authentication-bypass options reject; exit invalidates endpoint while release owns inherited pipes/helpers/process group; macOS EPERM ambiguity retries within the bounded release budget, ESRCH alone proves absence and persistent failure blocks reconnect observably. Current43 tests include real no-network ssh -G validation. No new real-host/agent/ProxyJump claim.

Chat's retry-preservation P1 and native200% scrolling P2 remain resolved at unchangeddbd with current38 tests and composed native wheel/Tab/Stop/Send. Read-only retry cannot bypass changed/unwritable local storage; immutable input/newer drafts stay distinct. No automatic resend or enablement workaround was added.

## Unexplained observations, historical cleanup and harness limits

Original rapid Open→Find→fill dismissal remains **UNEXPLAINED**: original trace overwritten, raw failure retained. Fresh bounded flows pass but do not explain it. Earlier Undo/Redo timing and public Reopen false-versus-settling observations retain their no-demonstrated-loss limits. Historical chat Create-disabled remains **UNATTRIBUTED** despite earlier readiness passes; this review does not erase it.

Historical owner initial editor22/25 used stale outer-main selectors and observed Trash before its receipt. Raw log remains; initial default traces were overwritten. **Initial synthetic Trash cleanup remains UNPROVEN:** no returned path/inode survives, no safe identified target exists, and no broad Trash scan/sweep/basename/content-guess deletion was performed or authorized here. Later exact-identity/content fixture Trash checks clean their own known files. This residue is separate from this review's verified process/group/port cleanup.

Owner's lifecycle argument-setup correction, navigation/evaluate race and early app.exit-before-Disconnect teardown failures remain in its records. Three controlled groups33312/34835/35391 were separately ownership-verified and recovered; masked timeouts are not causal product reds. The later corrected old lifecycle assertions and clean teardown remain separate evidence. No claim that all historical runs cleaned normally is made.

Other retained limits/corrections: frozen workspace links; ES2024 app lib; audit path-regexp; fixture initial health-query baseline; readFile envelope; faux completion after Stop replaced by holding the original task through Quit; process handle captured before Quit; concurrent rebuild/startup artifact race; fresh-document focus setup; forced-crash stale Playwright Target flag and native recovery; earlier volatile host-notice waits; StyleX0px→1px longhand repair; scheme registration before await; layout/faux SDK/prototype-driver corrections; explicit move-status delivery gate versus separate automatic convergence; native capture versus cropped Playwright zoom images; parent/srcdoc authority versus CSP; actual Vite graphs versus stub/IIFE audit. Their exact original scopes remain in the linked full records. No corrected fixture is promoted to a product fix.

Fresh review-only corrections, all raw outputs retained:

- `git-audit-initial.log`: overly broad workspace-tree equality expected38c; later docs/manifest differ while source equals38c and full package equals4dd.
- `git-audit-second.log`: whole scripts-directory equality was too broad; later check-package audit added, while actual build/package scripts equalb4f.
- `old-install.log`: nested archive shell selected Bun1.3.14 and rejected the newer lockfile before installation. Explicit pinned Bun1.4.4/Node26.13.0 then installed frozen dependencies; no lock rewrite or symlinked dependency substitute.
- `supplementary-source.log`: fresh-tail test failed its BEFORE-reload DOM-space assertion because Monaco uses NBSP. Initial script preserved; corrected assertion normalizes NBSP. This setup failure is not a causal product red. The separate latest-chat gate test passed in that run.
- `fresh-public.log` / `initial-fresh-public.*`: initial temporary `/var` path was rejected by no-follow workspace validation before scenarios ran. Canonical realpath fixes the fixture; corrected public real run passes both loss/control observations. No production validation changed.

No fresh phase needed manual process/group recovery. No test failure or discovery/setup error was omitted or retrospectively counted as a passing run.

## Artifacts, captures and notices

[source-artifact.json](source-artifact.json) byte-checks selected tracked product/test/fixture/package inputs against Git objects:198 current,196 cc06,133 standalone4dd files. It maps all built outputs and three fresh archives. [package-audit.json](package-audit.json) verifies actual asar bytes against built output, five Monaco workers/font, external executable native helper/rg and upstream release notices. [graph-notice-audit.json](graph-notice-audit.json) and `main-metafile.json`/`preload-metafile.json` come from independently rebuilt actual entries whose output bytes equal the build, plus actual Vite inputs.

- Current main271/preload5/renderer1588 inputs. Actual shipped client excludes test fixture, host/Pi SDK/provider implementations; renderer excludes privileged workspace/SSH/remote/application runtime implementations. Desktop main intentionally owns the local workspace's real SQLite persistence; Pi host SDK/SQLite implementation is not shipped in the client.
-15 independently derived notice package roots, installed notice bytes and pinned StyleX license checksum verified. No frozen reference source/excluded T3/Pocket/Codex/Microsoft application helper/schema/provider enters shipped graphs. Test metadata/source maps/evidence are excluded from archive.
- Current asar `96d74c67389db0c3d41083d6b39b01f79844b60ddfeada48619625c1351e74e3`; main `4307318656f6e83d2bb9ae0d128e1934ae7cdd1d8bce781d3b33323d320c0083`; preload `11fa565d9925f355975b4c98ec55ee1ea65225a47ba86e4562f4b3c6c810b776`.
- Helper `3b1431e53880081151fb7e2ca398f3534924c644d2aa240990e9f8ff5eafb3e1`; qualified rg `a326a1fb48074202e9ad41e4cd1e389eeea372c8c6f7d7e80da81176d5d9430e`; generated notices `7d947781e53597a8e9ef08eba28f9e0184ad08370036ddc2e28405d77c118d42`.
- Runtime actual Electron45.1.0/Node24.22.1; build/controlled host pinned Node26.13.0/Bun1.4.4. Packaged client executes with PATH `/usr/bin:/bin`, explicit fresh data and no provider environment. Absolute Node paths belong to the controlled fixture host/forwarder, not a claimed client dependency.

All12 fresh current composition captures were visually inspected: normal live chat, dirty editor, restored draft, keyboard focus, native200% normal1180×820 and constrained700×650, in both source/package. They are capturePage after two frames with native bounds/zoom/DPR/dimensions/hashes. Actual wheel/Tab/keyboard Stop/Send assertions pass; the constrained view is cramped and requires scrolling. This is not a manual accessibility verdict. The old reconstructed keyboard image and current post-loss image were also inspected. [SCREENSHOTS.md](SCREENSHOTS.md) / [screenshots.json](screenshots.json) index65 fresh PNG files with head mapping; sidecar-free trace images are not claimed as full native zoom evidence.

## Hosted CI and unrun gates

One metadata read per requested PR; one diagnostic annotation read each for current PR19 and20. Both exact heads report modules failures because execution was blocked before jobs ran by failed account payments/spending limit. Runner-capacity annotation is separately retained. PR20 job: https://github.com/ejjsharpe/moonbase/actions/runs/41306287143/job/124847233039 ; PR19 job: https://github.com/ejjsharpe/moonbase/actions/runs/41300779237/job/124831031693 . Raw `pr19-annotations.json` and `pr20-annotations.json` preserve details. No hosted pass, account/billing change, rerun, watch or poll. Exact-head hosted checks remain UNRUN/BLOCKED.

Required after repair: new independent exact-head source/package qualification of P1/P2 and affected lifecycle/preservation cases, with all prior dispositions carried forward. No repair or new review round was started here. Coordinator must retain DRAFT/human gate and arrange hosted execution after the account restriction is resolved.

UNRUN/PENDING: real SSH handshake/agent/known-host/ProxyJump/remote partition/persistence; real provider quota/auth/OAuth/network/cost; actual host distribution/transitive notices and optional QuickJS/photon/codemode/WASM assets; signing/notarization/Intel/other platforms; physical OS picker/clipboard/drag gestures and Finder Put Back; VoiceOver/full manual accessibility/product acceptance; performance/startup qualification; physical full-volume/instruction-by-instruction crash/power-loss durability. Prior323-source correspondence is not host distribution qualification. No legal, physical durability or external exactly-once claim.

## Cleanup and handoff

[cleanup-audit.py](cleanup-audit.py), [cleanup-summary.json](cleanup-summary.json), `cleanup.log`, every phase's `*-processes.json` and native `cleanup.jsonl` contain raw ownership and checks. The wrapper tracks descendants/process groups; fixture records additionally capture short-lived host/forward/invalid-config PIDs. At this review’s recorded release, all recorded PIDs and groups returned ESRCH; all68 distinct captured ports (including4176) passed bind/listen/close;66 exact named temporary fixture directories were absent. Final ownership-specific process inspection shows no remaining review Electron/helper/host/forward/Vite/Chromium job, excluding the inspection process itself. No audit signal or broad deletion was used.

Separate fixture phases, never conflated with owner's phase counts:

| This review phase |Electron/helper IDs|Hosts|Forward PIDs/groups|Ports|
| --- | ---: | ---: | ---: | ---: |
|Current source11|53|11|25/25|23|
|Current package10|45|10|22/22|21|
|Historical source2|8|2|4/4|4|
|Historical package2|8|2|4/4|4|
|Supplementary initial source2|8|2|2/2|3|
|Supplementary corrected source2|8|2|2/2|3|
|Supplementary package2|8|2|2/2|3|
|Each of four timed fresh-Reload phases|4|1|0/0|1|
|Independent combined public|0|1|2/2|2|

Preserved editor/package, config, public flush and Chromium process inventories are separately enumerated by the wrapper, not invented into the fixture counts above. Source/package owner-reported53+11+24/24/23 and45+10+23/23/21 belong to earlier owner phases, not this review. Historical unidentified Trash residue remains outside verified cleanup.

**FOREGROUND ELECTRON SLOT RELEASED.** No further native job is planned by this reviewer. The coordinator subsequently assigned foreground to the original Sol owner for targeted causal reproduction/archiving only; that later owner phase is outside these cleanup counts. Tracked tree remains clean on new review branch at exact8a; original/parent/owner branches are preserved. Durable report, runnable probes and evidence remain ignored in this worktree. Return this report for owner repair; keep PR20 blocked and PR19 seam clearance narrowly scoped as stated. Human acceptance and final coordinator handoff remain pending.
