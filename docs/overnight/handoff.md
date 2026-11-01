# Moonbase handoff — qualification still in progress

Workspace, Pi, SSH and standalone chat technical gates are clear. The final composition review found fresh-edit native Reload loss in both composition8a and exact standalone editor4dd source/package; editor Reload preservation is therefore open again despite the earlier R2 clearance. Task08 is published and its independent R1 review is active; this is a working handoff and **not a completion claim**. The independent review and final audit will replace this status before delivery; current composition head is `8a1636902b129f2fd6e04d26cfa75dd2e90ee415`. All human/product acceptance remains **PENDING**. No GitHub PR is merged or deployed by this run.

Private target: `ejjsharpe/moonbase`, T3 project `mcp:7cbe46d8-154d-422f-969f-cfaff7f0f0dd`. Fresh lead started clean at exact `3edf9814569ed8c9fa24e155355605cdcf26b98e` in isolated `t3-f9e2f375`. A meaningful checkpoint confirms private/open PRs and unchanged main `c89e4db49efcb998cdd3834b89d43ac581694314`; final recheck is pending. Original escode checkout/tracker and old state were not edited, imported or deleted. Source selection uses the immutable provenance manifest and40 verified hashes.

## Exact review queue

These are real dependency branches, not T3's derived display order. Additional fan-in parents: #11 includes #3, #15 includes #9, #19 includes #18. Composition will be based on #19. #17 is unrelated user work and excluded.

<!-- PR_QUEUE_START -->
| PR / contribution | Branch / exact HEAD | Dependency branch / exact BASE | Host state / technical scope |
| --- | --- | --- | --- |
| [#1](https://github.com/ejjsharpe/moonbase/pull/1) Foundation/provenance | `chore/module-foundation`<br>`8ef20b06222db32b54b4bdf9e6c2223a1ebd4da4` | `main`<br>`c89e4db49efcb998cdd3834b89d43ac581694314` | Ready; Clear provenance |
| [#2](https://github.com/ejjsharpe/moonbase/pull/2) Application command center | `chore/application-coordination`<br>`68aa035b9c283a65cac6e78ab02865e99882d15b` | `chore/module-foundation`<br>`8ef20b06222db32b54b4bdf9e6c2223a1ebd4da4` | Ready; Boundary R5 clear |
| [#5](https://github.com/ejjsharpe/moonbase/pull/5) Retained checkout contract | `chore/checkout-recovery-contract`<br>`6e58c1c4ea6944e8ca25eadc46e35c843f0f9fbe` | `chore/application-coordination`<br>`68aa035b9c283a65cac6e78ab02865e99882d15b` | Ready; Contract clear |
| [#7](https://github.com/ejjsharpe/moonbase/pull/7) Recovery publication contract | `chore/recovery-publication-contract`<br>`8557fdd0d7a71f93a6584c77430e6fde57668580` | `chore/checkout-recovery-contract`<br>`6e58c1c4ea6944e8ca25eadc46e35c843f0f9fbe` | Ready; Contract clear |
| [#3](https://github.com/ejjsharpe/moonbase/pull/3) Workspace module | `feat/workspace-module`<br>`38c6c551ff0ab1108077275d223a32967f32b9f6` | `chore/recovery-publication-contract`<br>`8557fdd0d7a71f93a6584c77430e6fde57668580` | Ready; R6:13 findings clear |
| [#4](https://github.com/ejjsharpe/moonbase/pull/4) Editor module | `feat/editor-module`<br>`3c7f0c3daf337753bbca10df495264af28b280eb` | `chore/recovery-publication-contract`<br>`8557fdd0d7a71f93a6584c77430e6fde57668580` | Ready; Paired R10:22 findings clear |
| [#11](https://github.com/ejjsharpe/moonbase/pull/11) Editor/workspace integration | `chore/editor-integration`<br>`80b0ede184205b9fff1d633d19426c2bf9671688` | `feat/editor-module`<br>`3c7f0c3daf337753bbca10df495264af28b280eb` | Ready; Paired R10/fan-in R3 clear |
| [#13](https://github.com/ejjsharpe/moonbase/pull/13) Native import/Create follow-up | `fix/editor-native-import-dialog`<br>`71f272d354359f8d5e1cff7a9f57159325eeabc5` | `chore/editor-integration`<br>`80b0ede184205b9fff1d633d19426c2bf9671688` | Ready; R1 clear |
| [#16](https://github.com/ejjsharpe/moonbase/pull/16) Filename maps/menu follow-up | `fix/editor-filename-maps-and-menu`<br>`473e0fe03f6c5fc34fd8282fab4875c20f143ac2` | `fix/editor-native-import-dialog`<br>`71f272d354359f8d5e1cff7a9f57159325eeabc5` | Ready; Paired desktop R2 clear |
| [#14](https://github.com/ejjsharpe/moonbase/pull/14) Standalone editor | `feat/standalone-editor`<br>`4dd148ade5f279e2b3820df0325313ee08ce4f8d` | `fix/editor-filename-maps-and-menu`<br>`473e0fe03f6c5fc34fd8282fab4875c20f143ac2` | DRAFT; prior Desktop R2 clear; newly reproduced Reload loss open |
| [#6](https://github.com/ejjsharpe/moonbase/pull/6) Authenticated health contract | `chore/host-health-contract`<br>`42836b0421898b963e67f02795edc35f5e546173` | `chore/checkout-recovery-contract`<br>`6e58c1c4ea6944e8ca25eadc46e35c843f0f9fbe` | Ready; Health R2 clear |
| [#8](https://github.com/ejjsharpe/moonbase/pull/8) Connection contract | `chore/connection-contract`<br>`09b21f2ee8556c54ef4f8238f0be2ee88fd990c3` | `chore/host-health-contract`<br>`42836b0421898b963e67f02795edc35f5e546173` | Ready; R1 clear |
| [#9](https://github.com/ejjsharpe/moonbase/pull/9) SSH transport | `feat/ssh-transport`<br>`1aec1a438ba0d5592b0e6c3f0e1be835cf3c034b` | `chore/connection-contract`<br>`09b21f2ee8556c54ef4f8238f0be2ee88fd990c3` | Ready; R3:4 findings clear; controlled transport |
| [#10](https://github.com/ejjsharpe/moonbase/pull/10) Chat contract | `chore/chat-contract`<br>`d38833db81c5d97a1aa60f25e0dc27dd670af60f` | `chore/connection-contract`<br>`09b21f2ee8556c54ef4f8238f0be2ee88fd990c3` | Ready; R1 contract clear |
| [#12](https://github.com/ejjsharpe/moonbase/pull/12) Pi Durable runtime | `feat/pi-runtime`<br>`235eb27a448635a995bb65e67147e99119830b92` | `chore/chat-contract`<br>`d38833db81c5d97a1aa60f25e0dc27dd670af60f` | DRAFT; Pi R3 clear; distribution/CI pending |
| [#15](https://github.com/ejjsharpe/moonbase/pull/15) Pi/SSH integration | `chore/chat-integration`<br>`132d273073889bd0702cf96b1fc2a62d5027598c` | `feat/pi-runtime`<br>`235eb27a448635a995bb65e67147e99119830b92` | DRAFT; Integration R2 clear; CI pending |
| [#18](https://github.com/ejjsharpe/moonbase/pull/18) Standalone chat | `feat/chat-proof`<br>`dbd06a6d3f8c8f310868349e7ed099468db9b9ba` | `chore/chat-integration`<br>`132d273073889bd0702cf96b1fc2a62d5027598c` | DRAFT; Proof R2 clear; manual/real/CI pending |
| [#19](https://github.com/ejjsharpe/moonbase/pull/19) Reviewed proof fan-in/adapters | `chore/workbench-integration`<br>`d79d1e9b8347f7f5f19cdbe9aad0233a0c47be8d` | `feat/standalone-editor`<br>`4dd148ade5f279e2b3820df0325313ee08ce4f8d` | DRAFT; DFF checkpoint R1 clear; D79 fixture-export delta clear; inherited Reload defect open |
| [#20](https://github.com/ejjsharpe/moonbase/pull/20) Composed workbench | `feat/workbench-composition`<br>`8a1636902b129f2fd6e04d26cfa75dd2e90ee415` | `chore/workbench-integration`<br>`d79d1e9b8347f7f5f19cdbe9aad0233a0c47be8d` | DRAFT; R1 blocked: fresh-edit Reload P1 and empty-config P2; original owner repairing |
<!-- PR_QUEUE_END -->

## Technical status and review evidence

- **Editor baseline #14/#16:** paired Astra R2 cleared prototype-like filenames and bounded menus in source/package (231 repository/integration tests,35 Chromium journeys,25 Electron journeys). Final composition R1 subsequently found a distinct native document Reload P1 at exact4dd: a visibly typed tail can be lost before the150ms recovery debounce. The old proof remains preserved; a focused standalone follow-up is being prepared. Its targeted native checks additionally reproduced a direct held-read resource surviving committed Reload/renderer loss in source; the editor-only cleanup repair and package qualification are pending. Use the repaired standalone ref once its fresh review is complete. [Desktop R2](reviews/desktop-r2.md), [new R1](reviews/composition-r1.md).
- **Pi #12 / integration #15:** independent R3/R2 clears exact235/132, including postdispatch generation loss.136 shipped tests and22 independent probes pass;21 expected historical failures reproduce. Controlled production HTTP/SQLite/SSH-child evidence is separate from real remote qualification. [Full report](reviews/pi-r3-chat-integration-r2.md).
- **Standalone chat #18:** independent R2 clears exactdbd. Retry now checks preservation immediately before mutation after awaited read-only lookup; native200% Send/Stop are reachable by scrolling/keyboard.167 module/public +7 integration tests,6 original public probes and31 native case executions pass (overlapping scenarios);18 public/12 native expected old failures reproduce. Actual archive `baabf3fc9734aea731d83d19ae1ec6392f264fc4a311e14381752dc178946990`, seven packaged files and nine generated notices verified. [R1](reviews/chat-proof-r1.md), [response](reviews/chat-proof-r1-response.md), [R2](reviews/chat-proof-r2.md).
- **Fan-in #19:** independent DFF R1 clears391 shipped tests and two independent combined-root probes. Final composition R1 separately clears the exact DFF→D79 test-fixture export delta. That seam clearance does not approve its inherited old desktop Reload behavior. Public exports reuse existing implementations; production graphs exclude the test host/SDK. [DFF review](reviews/workbench-integration-r1.md), [D79 review](reviews/composition-r1.md).
- **Composition #20:** R1 at exact8a is **NOT CLEARED**. It reproduced the Reload P1 in current source/package and exact standalone4dd source/package, whose rebuilt archive matches the original37ad94c. P2: a present empty configuration silently takes the absent branch. Original Sol owner is repairing both apps, preserving old refs and the archived8a package. A new independent review on exact pushed repaired heads is mandatory.

R1 nevertheless passed392 shipped tests (370 module +15 real editor +7 controlled chat),35 Chromium journeys,11 source/10 unsigned-package composition cases,25 preserved editor journeys and one packaged-resource journey. These passing checks do not clear the new findings. Prior keyboard activation and committed-unload resource defects are independently cleared within the limits below. [Full R1, all prior dispositions and artifact audit](reviews/composition-r1.md), [commands](reviews/composition-r1-commands.md), [cleanup](reviews/composition-r1-cleanup.json).

The committed reports preserve their originating evidence references. For R1's local probes, raw traces and native captures, open the [original report and artifact tree](/Users/elliotsharpe/.t3/worktrees/moonbase/t3-95174512/apps/desktop/test-results/review-task08-r1/REPORT.md); exact source refs and archive hashes are also retained in the committed copy.

## Findings and disposition

| Scope | Concrete findings / current disposition |
| --- | --- |
| Application/contracts | Boundary R5 clears identity, cancellation and cleanup error findings. Exact receipts/CAS, nonce authentication and normalized failures remain required. |
| Workspace | All13 prior findings clear at38c: path/native authority, immutable requests, grouped restoration/capacity, conservative journal order and per-client publication/observer identity. The full individual list is retained in the R1 report and original reviews. |
| Editor/integration | All22 original editor findings, lost/reordered Save P1, rejected-publication P1, transient alert P2, native import/Create mismatches and filename-map/menu P2s retain their scoped clearance. New native document Reload P1 is distinct from the earlier controller Reload/Close cases and remains open. |
| SSH | Four findings clear at1aec: early/coalesced release, authentication bypass flags, inherited helpers/pipes after exit, and bounded EPERM uncertainty. No real-peer claim. |
| Pi/integration | Signed-error oracle P1, postcommit Create P2 and postdispatch generation-loss P2 clear at235/132. Retain original identities and Uncertain after possible dispatch; no resend, successor Stop or external exactly-once claim. |
| Chat | Retry-preservation P1 and native200% controls P2 causally clear atdbd. Border0px→1px is an independent own-UI repair; volatile notice assertions were fixture corrections. |
| Composition keyboard | Enter activation produced a click with detail0 and incorrectly returned focus to Monaco. Pointer-only detail>0 fix is independently causal with the same corrected driver in old/new source/package. |
| Composition lifecycle | Committed unload now releases document-owned observers/waits while preserving root, native approval registry and connection. Reviewer old runs canceled both chat observers but retained editor observer/held read; owner previously observed all three observers retained. Both observations are preserved. Current cancels all four exact resources; veto cancels none. This does not clear fresh-edit preservation. |
| New R1 repairs | Public observable exact-publication readiness must cover debounce, ordinary in-flight publication and edits during preservation; already durable dirty reload must remain possible. Present configuration must validate even when empty. Repairs and re-review are in progress. |

## Evidence limits and unresolved observations

- **New owner evidence deletion:** preserved editor suite default Playwright outputDir cleared the owner's local test-results, deleting its baseline archive copies and targeted raw phases before commit. Reviewer R1 artifacts and committed8a evidence are intact. Checksum-verified replacement copies outside all runner output roots and repeated old/new probes must be labeled NEW records, not recovered/surviving originals. The owner is inventorying exactly which earlier raw records remain.
- **Original keyboard binary unavailable:** actual red source `cc06d753e76dc02470628a611a3a481f771953b9` and trace survive; the original asar was overwritten before a digest was recorded. Reconstructed asar `4f59a6c209607daf72a253315bbf04fda2dcf95ed9bf4b91007c8a604b159993` is a NEW artifact, not proof of original binary equivalence. The final corrected driver `c7cea1c946a4fad94977e7c0df712c980452ed037de1d662fa65c84b87e29b5b` reproduces old focus failures and passes current source/package. Earlier Arrow-only/Tab-count corrections remain distinct from the product defect.
- **Historical synthetic Trash cleanup UNPROVEN:** initial22/25 fixture observed source removal before receipt, and its returned destination/inode was unavailable after failed teardown. No safely identified deletion target exists; no broad Trash scan/sweep or basename/content guess was used. Later cases clean only their exact returned identity/content. This residual uncertainty is separate from verified final PID/group/listener cleanup. Original/escode/user data was not removed.
- **Unexplained:** original rapid Open→Find→fill dismissal (trace overwritten, raw failure retained); initial Undo/Redo timing and public Reopen return-value/settling observations (no demonstrated lost text); historical Create-disabled transient despite bounded passing readiness cycles. Repeated greens do not explain them.
- **Harness corrections remain raw evidence:** initial shell selectors/Trash receipt wait; health baseline/readFile envelope/faux alternating completion; process-wrapper and concurrent-build startup; lifecycle argument/navigation/stale crashed-Page drivers; storage-fault teardown, volatile host notice, cropped Playwright captures versus full native capturePage. Three historical failed-harness forward groups were separately ownership-verified/recovered; do not claim all historical runs cleaned normally. Reviewer-only NBSP/path-canonicalization/setup audit corrections are listed in the full report.
- **Runtime/trust boundary:** same-origin srcdoc parent-bridge access under privileged evaluation remains a documented limit. CSP, owned frame/document validation and ordinary app data paths are separate controls. No renderer-compromise immunity is claimed.

All12 owning composition captures were inspected by the owner and independent reviewer; root also inspected packaged dirty editor, live chat and constrained200% images. Actual wheel/Tab/Stop/Send checks establish reachability; the small view is cramped and requires scrolling. The captures do not prove manual accessibility. R1 current archive is `96d74c67389db0c3d41083d6b39b01f79844b60ddfeada48619625c1351e74e3`, main271/preload5/renderer1588 actual inputs,15 independently derived notice roots. Final repaired artifacts will replace the runnable recommendation after re-review.

## External and manual gates

- Hosted jobs at current relevant source heads were blocked **before execution** by GitHub account billing/spending restrictions. This is UNRUN/BLOCKED, not a local source failure or a hosted pass. Account owner must resolve the restriction and run exact-head checks before merge.
- No explicit real SSH peer or provider quota authorization was supplied. Real handshake/known-host/agent/ProxyJump, remote partition/persistence and provider authentication/network/cost are UNRUN. No bypass, provisioning or remote shutdown was attempted.
- Actual host-distribution/transitive notices and optional engine assets remain unqualified. Release-pinned323-source/three-README/seven-manifest correspondence is not distribution qualification. Actual desktop notices derive from shipped graphs; the SDK is excluded from the client.
- Signing/notarization, Intel/other platforms, physical picker/clipboard/drag/Finder Put Back, VoiceOver/full manual accessibility/product acceptance, performance and physical full-volume/power-loss checks remain UNRUN/PENDING. Unsigned ARM64 automation is not these gates.

## Runnable checkpoints

Use a new clean checkout for each exact ref; preserve existing dirty work. Build requires pinned Bun1.4.4/Node26.13 tooling and macOS compiler tools. The package runs bundled Electron45.1/Node24.22. Separate explicit Moonbase data directories are mandatory for review; never point at an old application's data.

**Independent editor, no Pi/SSH/configuration required:**

```sh
git worktree add --detach /tmp/moonbase-editor-proof 4dd148ade5f279e2b3820df0325313ee08ce4f8d
cd /tmp/moonbase-editor-proof
bun install --frozen-lockfile
node scripts/prepare-ripgrep.mjs
MOONBASE_USER_DATA="$(mktemp -d -t moonbase-editor)" NX_DAEMON=false bunx nx run @moonbase/desktop:dev
```

Package: `NX_DAEMON=false bunx nx run @moonbase/desktop:package`, then run `apps/desktop/release/mac-arm64/Moonbase.app/Contents/MacOS/Moonbase` with a fresh `MOONBASE_USER_DATA`. Actual source/package tests are `bun run --cwd apps/desktop test:desktop` / `test:package` after build/package. [Guide](https://github.com/ejjsharpe/moonbase/blob/4dd148ade5f279e2b3820df0325313ee08ce4f8d/apps/desktop/README.md).

**Independent chat, no editor dependency:**

```sh
git worktree add --detach /tmp/moonbase-chat-proof dbd06a6d3f8c8f310868349e7ed099468db9b9ba
cd /tmp/moonbase-chat-proof
bun install --frozen-lockfile
bun run --cwd apps/chat-probe build
MOONBASE_CHAT_CONFIG=/absolute/private/chat-client.json MOONBASE_CHAT_DATA="$(mktemp -d -t moonbase-chat)" bun run --cwd apps/chat-probe start
```

The private0600 configuration must name an already authorized SSH alias/expected host+store and separately provisioned matching key. No remote is assumed. Start the host **separately on its machine** with qualified Node26.13:

```sh
node --experimental-strip-types packages/pi-runtime/src/host.ts /absolute/private/moonbase-host.json
```

The standalone public SSH consumer is `node --experimental-strip-types packages/ssh/examples/connect.ts /absolute/private/connection.json`. It uses normal SSH policy and explicitly connects/disconnects; run only with an approved host. [Host](https://github.com/ejjsharpe/moonbase/blob/235eb27a448635a995bb65e67147e99119830b92/packages/pi-runtime/README.md), [SSH](https://github.com/ejjsharpe/moonbase/blob/1aec1a438ba0d5592b0e6c3f0e1be835cf3c034b/packages/ssh/README.md), [chat guide](https://github.com/ejjsharpe/moonbase/blob/dbd06a6d3f8c8f310868349e7ed099468db9b9ba/apps/chat-probe/README.md).

Controlled checks need no real credentials: `bun run --cwd apps/chat-probe test`, `bun run test:chat-integration`, then package and `bun run --cwd apps/chat-probe test:desktop` with the foreground free. No passing controlled check spends real provider quota or establishes real SSH acceptance.

**Composed application, exact current review head:**

```sh
git worktree add --detach /tmp/moonbase-workbench-proof 8a1636902b129f2fd6e04d26cfa75dd2e90ee415
cd /tmp/moonbase-workbench-proof
bun install --frozen-lockfile
node scripts/prepare-ripgrep.mjs
env -u MOONBASE_CHAT_CONFIG MOONBASE_USER_DATA="$(mktemp -d -t moonbase-workbench)" NX_DAEMON=false bunx nx run @moonbase/desktop:dev
```

This explicitly removes any inherited chat configuration for the launched process and starts the local editor with Chat unconfigured. To enable optional chat, additionally set `MOONBASE_CHAT_CONFIG=/absolute/private/chat-client.json` to the separately prepared owner-only client configuration; Connect stays explicit. Package with `NX_DAEMON=false bunx nx run @moonbase/desktop:package`, then launch the same Moonbase binary path with fresh `MOONBASE_USER_DATA` and optional configuration. Source/package composed tests: `MOONBASE_COMPOSITION_TEST=1 bun run --cwd apps/desktop test:desktop` and add `MOONBASE_PACKAGED_TEST=1` for the actual package, after build/package and with the foreground free. [Current guide](https://github.com/ejjsharpe/moonbase/blob/8a1636902b129f2fd6e04d26cfa75dd2e90ee415/apps/desktop/README.md). Independent R1 is blocked on the two findings; follow-up repair/new exact-head review remains pending.

## Human merge/retarget order

1. Resolve GitHub billing/CI and review provenance/contracts: #1 → #2 → #5.
2. Editor line: #7 → siblings #3/#4 → #11 → #13 → #16 → #14.
3. Chat line can be reviewed alongside editor: #6 → #8 → siblings #9/#10 → #12 after#10 → #15 after#12+#9 → #18.
4. #19 after#14+#18, then the final composition, then final handoff documentation.

After a human merges dependencies, retarget newly unblocked PRs to the updated appropriate base, retain ancestry and rerun exact-head checks. Integration branches normally contain reviewed parent merges; don't merge duplicate whole-project diffs blindly. This run performs no GitHub merges, deployment or acceptance. Final cleanup/link/privacy/default-branch/pushed-state audit remains pending.
