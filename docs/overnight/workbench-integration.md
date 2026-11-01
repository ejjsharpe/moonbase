# Reviewed standalone fan-in for task08

This non-default branch normally merges standalone editor `4dd148ade5f279e2b3820df0325313ee08ce4f8d` (#14; module473/workspace38c) and standalone chat `dbd06a6d3f8c8f310868349e7ed099468db9b9ba` (#18; integration132/Pi235/SSH1aec). Merge90747e4 preserves both exact histories. No GitHub PR is merged. Both independent technical gates are clear; human acceptance remains PENDING.

The merge conflicts were only root package scripts/dependencies, bun.lock and CI. Both sets are retained; Bun1.4.4 regenerated the lock with existing pins and frozen installation passes. Application auto-merges preserve the reviewed recovery-publication additions and chat/connection handlers. Feature implementations are unchanged. Existing editor and chat standalone roots still install only their capabilities and remain runnable on their preserved branches.

Coordinator registration adds only three public existing-adapter exports in chat (`./bridge`, `./native-session`, `./native-config`) and three workspace dependencies in desktop, plus corresponding lock entries. No adapter implementation or runtime is introduced. This lets task08 reuse the production boundaries without copying them or importing app internals. New composition must authenticate its owning frame before the native session; browser bridge/controller graph excludes Node/Effect runtime/feature implementations.

## Validation

- Frozen install unchanged;40 provenance hashes/active UI/browser contracts; whitespace check pass.
-21 uncached Nx type/lint/test targets pass: application33 +editor106 +workspace91 +Pi53 +SSH43 +chat38 +desktop5 =369. Lint is TypeScript diagnostics.
-15 real editor/workspace integration and7 separate-host production HTTP/SQLite/controlled-forward integration cases pass. Total391 distinct shipped cases; no real provider/SSH claim.
-Both app builds and four dependency build tasks pass. Actual desktop renderer1585-input audit passes; chat build guards main263/renderer50. Native helper and qualified rg are built/available. Build warnings about chunk size remain informational, not performance qualification.
-Public bridge/controller browser consumer check executes from the actual desktop dependency context and includes only application/client,wire,controller and a virtual consumer entry. This is a public-export check; actual renderer graphs are audited separately.
-Logs: `/tmp/moonbase-workbench-fanin-{nx,editor,chat,build}.log` in coordinator t3-f9e2f375. No GUI/native package test was rerun here: exact independent desktopR2 and chatR2 reports establish their separate proof checkpoints; final composition needs fresh actual Electron/package qualification.

One initial foundation attempt ran before Bun installation completed and could not resolve esbuild's binary. It passed after installation. An initial export probe ran from root, which does not depend on chat-probe; the corrected desktop-consumer probe passes. These setup failures are not product failures or claimed passes.

## Review and remaining gates

Full independent desktopR2, PiR3/integrationR2, chatR1/response/R2 reports are under `reviews/`. Chat R1 preservation/200% blockers are causally clear at dbd. Source/unsigned controlled runtime eligibility does not establish GitHub CI: current relevant app/Pi/integration jobs could not start because of account billing/spending restriction.

Original editor rapid-lookup dismissal, initial undo/redo timing/public-reopen observations, and historical chat Create-disabled transient remain unexplained/nonblocking observations. Keep them in task08 review/handoff. Actual host distribution/transitive notices, real provider/SSH/agent/known-host/ProxyJump, signing/Intel/VoiceOver/manual accessibility, performance and physical durability remain UNRUN/PENDING. No quota, unspecified remote host, host-key bypass, user clipboard or old state is used.

Task08 owns apps/desktop composition/navigation and its tests/evidence. It must keep one root runtime, preserve local editor and remote chat authority independently, never auto-connect/resend/Stop on navigation or client Quit, and prove dirty editing/live chat, drafts, Save/Discard/Cancel/Quit, exact Stop, reconnect and native200% reachability. The final draft and this shared registration require independent paired review.

## Task08 test fixture follow-up

The task08 owner requested `@moonbase/chat-probe/test-fixture` -> existing `./test/fixture.ts` to reuse controlled host tests through a public entry. Only the export map and ownership documentation change; fixture implementation/dependencies stay exact. Frozen install and a desktop-consumer public import/lifecycle smoke pass (zero model/tool calls, host PID absent and port rebound). No lockfile change. The active headless PR19 review stays fixed at `dff2ece7503aef4159994e8e169dd29180842a4d`; this later test-only seam is not covered by that checkpoint and must be included in the new composition review. Production graphs must exclude all fixture/SDK/host test inputs.
