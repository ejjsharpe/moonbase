# Moonbase handoff — qualification still in progress

The independent editor, workspace, Pi, SSH and standalone chat technical gates are clear. Task08 composition is active; this is a working handoff and **not a completion claim**. The final composition head, independent review and final audit will replace this status before delivery. All human/product acceptance remains **PENDING**. No GitHub PR is merged or deployed by this run.

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
| [#14](https://github.com/ejjsharpe/moonbase/pull/14) Standalone editor | `feat/standalone-editor`<br>`4dd148ade5f279e2b3820df0325313ee08ce4f8d` | `fix/editor-filename-maps-and-menu`<br>`473e0fe03f6c5fc34fd8282fab4875c20f143ac2` | DRAFT; Desktop R2 clear; manual/CI pending |
| [#6](https://github.com/ejjsharpe/moonbase/pull/6) Authenticated health contract | `chore/host-health-contract`<br>`42836b0421898b963e67f02795edc35f5e546173` | `chore/checkout-recovery-contract`<br>`6e58c1c4ea6944e8ca25eadc46e35c843f0f9fbe` | Ready; Health R2 clear |
| [#8](https://github.com/ejjsharpe/moonbase/pull/8) Connection contract | `chore/connection-contract`<br>`09b21f2ee8556c54ef4f8238f0be2ee88fd990c3` | `chore/host-health-contract`<br>`42836b0421898b963e67f02795edc35f5e546173` | Ready; R1 clear |
| [#9](https://github.com/ejjsharpe/moonbase/pull/9) SSH transport | `feat/ssh-transport`<br>`1aec1a438ba0d5592b0e6c3f0e1be835cf3c034b` | `chore/connection-contract`<br>`09b21f2ee8556c54ef4f8238f0be2ee88fd990c3` | Ready; R3:4 findings clear; controlled transport |
| [#10](https://github.com/ejjsharpe/moonbase/pull/10) Chat contract | `chore/chat-contract`<br>`d38833db81c5d97a1aa60f25e0dc27dd670af60f` | `chore/connection-contract`<br>`09b21f2ee8556c54ef4f8238f0be2ee88fd990c3` | Ready; R1 contract clear |
| [#12](https://github.com/ejjsharpe/moonbase/pull/12) Pi Durable runtime | `feat/pi-runtime`<br>`235eb27a448635a995bb65e67147e99119830b92` | `chore/chat-contract`<br>`d38833db81c5d97a1aa60f25e0dc27dd670af60f` | DRAFT; Pi R3 clear; distribution/CI pending |
| [#15](https://github.com/ejjsharpe/moonbase/pull/15) Pi/SSH integration | `chore/chat-integration`<br>`132d273073889bd0702cf96b1fc2a62d5027598c` | `feat/pi-runtime`<br>`235eb27a448635a995bb65e67147e99119830b92` | DRAFT; Integration R2 clear; CI pending |
| [#18](https://github.com/ejjsharpe/moonbase/pull/18) Standalone chat | `feat/chat-proof`<br>`dbd06a6d3f8c8f310868349e7ed099468db9b9ba` | `chore/chat-integration`<br>`132d273073889bd0702cf96b1fc2a62d5027598c` | DRAFT; Proof R2 clear; manual/real/CI pending |
| [#19](https://github.com/ejjsharpe/moonbase/pull/19) Reviewed proof fan-in/adapters | `chore/workbench-integration`<br>`d79d1e9b8347f7f5f19cdbe9aad0233a0c47be8d` | `feat/standalone-editor`<br>`4dd148ade5f279e2b3820df0325313ee08ce4f8d` | DRAFT; DFF checkpoint R1 clear; D79 fixture seam pending composition review |
<!-- PR_QUEUE_END -->

## What is qualified

- **Standalone editor #14/#16:** independent Astra R2 clears both packaged prototype-filename/menu P2s.231 repository/real integration tests,35 Chromium journeys and final25 Electron journeys; restricted-PATH unsigned package and independent own-key/SQLite/move/focus/menu probes pass. Exact editor asar `37ad94c692afbde6b2b9a6afabfda6272425e98470e5557419e1b83818ba2f8d`. [Full report](reviews/desktop-r2.md), [owner source/evidence](https://github.com/ejjsharpe/moonbase/blob/4dd148ade5f279e2b3820df0325313ee08ce4f8d/apps/desktop/evidence/app-r1/review-r1-response.md).
- **Pi235/integration132:** independent Astra R3/R2 clears generation-loss uncertainty while retaining prior authentication/Create/SSH fixes.136 shipped tests and22 independent probes pass;21 expected historical failures reproduced. Actual compiled remote under Electron45.1/Node24.22 versus separate Node26.13 host is included. [Full report](reviews/pi-r3-chat-integration-r2.md).
- **Standalone chat dbd:** independent Astra R2 clears retry-preservation P1 and native200% P2.167 module/public +7 integration tests,6 original independent public probes and31 native case executions pass;31 includes overlapping scenarios.18 public/12 native historical failures reproduce. Actual archive `baabf3fc9734aea731d83d19ae1ec6392f264fc4a311e14381752dc178946990`,7 packaged build files and9 generated notices verified. [R1](reviews/chat-proof-r1.md), [response](reviews/chat-proof-r1-response.md), [R2](reviews/chat-proof-r2.md), [captures](https://github.com/ejjsharpe/moonbase/blob/dbd06a6d3f8c8f310868349e7ed099468db9b9ba/apps/chat-probe/EVIDENCE.md).
- **Shared fan-in DFF:**391 tests (369 module +15 real editor +7 controlled chat),21 uncached Nx tasks, both builds,40 source/UI/browser checks and actual graphs pass. Two independently authored combined-root probes establish Save/recovery responsiveness during admitted Send, cancellation without Stop, exact Stop, generation-loss uncertainty/no resend and independent drafts. [Full review](reviews/workbench-integration-r1.md). That verdict excludes the later D79 test-fixture export; final composition review must cover it.

Source/type checks, controlled file/Git/SQLite/HTTP/SSH-child integration, actual Electron/unsigned packaging and real/manual evidence are separate. Controlled faux providers/TCP forwards never qualify a real provider or SSH peer.

## Findings and evidence limits

| Scope | Findings / disposition |
| --- | --- |
| Shared contracts | Boundary R5 and exact checkout/recovery/publication/health/connection/chat contracts clear; immutable receipts/CAS, nonce authentication, cancellation and normalized cleanup errors retained. |
| Workspace | All13 prior findings clear at38c; closed registry/open membership, independent drafts, exact observer/origin identities, conservative uncertainty and non-replay remain required. |
| Editor/integration | Original22 editor findings, lost/reordered Save P1, rejected-publication P1, transient alert P2 and native import/Create mismatches clear in their reports. Filename-map own-property and bounded-menu P2s causally clear in actual package. |
| SSH | Four findings clear: early/coalesced release, host-authentication bypass flags, terminal exit versus inherited pipes/helpers, and EPERM/owned-group deadline uncertainty. No real peer/agent/ProxyJump claim. |
| Pi/integration | Signed-error oracle P1 and postcommit Create P2 clear. Postdispatch generation disappearance P2 now preserves Uncertain plus reader-cleanup details. No automatic resend, successor Stop or external exactly-once claim. |
| Standalone chat | Retry must recheck preservation immediately before mutation after read-only query; actual200% controls must be reachable. Both R1 blockers causally clear atdbd. |
| Task08 | Pointer focus handoff on keyboard Enter produced a real native red at source `cc06d753e76dc02470628a611a3a481f771953b9`; repair/final qualification active. Original asar was overwritten before digest recording: no original binary-equivalence claim. Exact source/two-frame trace retained; any reconstructed archive gets its own provenance/digest. A separate keyboard-driver sequencing correction must be distinguished from the product fix. A corrected reload probe also found surviving renderer watches; unload teardown/preservation guard qualification active. |

**Historical cleanup limit:** initial task08 22/25 Trash fixture observed source removal before its receipt; after failed-run teardown its native-returned destination/inode record was unavailable. Cleanup of that synthetic Trash artifact is **UNPROVEN**. There is no safely identified deletion target; no broad/unverified Trash sweep or basename/content guess was used. Later cases verify returned inode/content before cleaning their own fixture. This uncertainty is separate from final verified PID/group/listener cleanup, and no original/escode/user data was removed.

**Unresolved observations:** original rapid Open checkout→Find→fill dismissal remains unexplained; its original trace was overwritten and raw failure retained. Initial undo/redo timing and public Reopen return-value/settling observations did not demonstrate lost text but remain recorded. Historical chat Create-disabled remains unattributed despite bounded passing readiness cycles. These are not causally cleared by repeated passes.

**Corrections retained, not additional product fixes:** own-key Playwright reconstruction uses JSON/primitive facts; setup/selection/focus awaits, explicit lost-move observation gate, .png.json sidecars, actual Vite graph audit, same-origin srcdoc parent-bridge/CSP limit; volatile Verified-host notice assertions, StyleX0px→1px border repair; module-loader/process-wrapper/IPC ErrorDTO/native paint/symlink-path/no-match discovery corrections. Cropped Playwright zoom captures are retained as cropped; full native capturePage evidence is separate. Owner/reviewer storage-fault teardown corrections and phase-specific cleanup counts remain in full reports. Task08 initial22/25 shell-selector/Trash-receipt, health baseline/readFile envelope/faux response/build startup corrections are retained separately.

## Remaining external/manual gates

- Current relevant hosted jobs could not start because GitHub reports account billing/spending restrictions. This is **BLOCKED/UNRUN**, not a failing local test or a hosted pass. Account owner must resolve billing and run exact-head checks before merge.
- No explicit real SSH host or real-provider quota authorization was supplied. Real handshake/known-host/agent/ProxyJump/remote partition/persistence and provider authentication/network/cost are **UNRUN**. No host-key bypass, provisioning or host shutdown was attempted.
- Actual host-distribution/transitive notices and optional engine assets remain unqualified. Pi1.4 source correspondence323/3README/7manifest checks do not qualify a shipped host. Desktop graphs exclude the SDK; actual desktop notices derive from shipped graph/release inputs, with no manual blanket source bundle.
- Signing/notarization/distribution, Intel/other platforms, Finder/native picker/clipboard/drag/Put Back gestures, VoiceOver/physical keyboard/manual visual acceptance, performance and physical full-volume/power loss remain **UNRUN/PENDING**. Unsigned ARM64/native automation is not those gates.

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

**Composed application:** final exact head, runnable/package commands and independent review are pending task08 publication. It must start as local editor when chat is unconfigured, and connect only on explicit user action when private configuration is supplied.

## Human merge/retarget order

1. Resolve GitHub billing/CI and review provenance/contracts: #1 → #2 → #5.
2. Editor line: #7 → siblings #3/#4 → #11 → #13 → #16 → #14.
3. Chat line can be reviewed alongside editor: #6 → #8 → siblings #9/#10 → #12 after#10 → #15 after#12+#9 → #18.
4. #19 after#14+#18, then the final composition, then final handoff documentation.

After a human merges dependencies, retarget newly unblocked PRs to the updated appropriate base, retain ancestry and rerun exact-head checks. Integration branches normally contain reviewed parent merges; don't merge duplicate whole-project diffs blindly. This run performs no GitHub merges, deployment or acceptance. Final cleanup/link/privacy/default-branch/pushed-state audit remains pending.
