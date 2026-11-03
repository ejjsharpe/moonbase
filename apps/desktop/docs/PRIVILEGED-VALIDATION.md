# Privileged desktop extraction evidence

Issue [#89](https://github.com/ejjsharpe/moonbase/issues/89) starts from clean integrated `3f15bca` (including local Pi #97) on macOS arm64, Node `v26.13.0` and Bun `1.4.4`. No dependency, public export, bridge/channel, fixed compatibility fixture or storage namespace changes. Baseline desktop build and all 43 source tests passed. Verified ripgrep 15.2.0 assets were prepared with `scripts/prepare-ripgrep.mjs`.

Main retains setup/acquisition/assets/window security/menu/installation. Private native actions, command IPC, window lifecycle and chat backend wiring use its supplied capabilities and existing sessions. Two focused lifecycle fixes accompany the move: rejected callers cannot clear a pending preservation attempt, and Quit awaits outstanding document cleanup before collecting failures. Final cleanup still attempts chat, editor and runtime release in order. The original absent-local-backend confirmation guard is retained, with a regression proving a later successful retry cannot inherit consent cached while the backend was absent.

New controlled source checks exercise exact sender/frame/full-document rejection, registration ownership/reinstallation, replacement during both Quit stages, fresh IDs, malformed/stale acknowledgments, veto, held/failing release, late document cleanup failure, native consent/cancellation and local retry/late folder selection. Existing session tests retain finalizer/authority policy. Build/archive guards require every extracted owner; renderer/preload audits reject all privileged main-subtree inputs. Existing Nx inputs and `test/*.test.ts` discovery already include the new source/tests; CI commands and native project deadlines/workers are unchanged.

Source/build checks on the final tree:

| Command | Result |
| --- | --- |
| `bun install --frozen-lockfile`; `node scripts/prepare-ripgrep.mjs` | Pass; pinned lockfile unchanged; verified complete ripgrep assets |
| `NX_DAEMON=false bunx nx run @moonbase/desktop:build` | Pass; desktop executed, unchanged prerequisite builds cached |
| Desktop `typecheck`, `lint`, `test` | Pass; 52 source tests, including nine new regressions |
| `bun run check:foundation` | Pass; negative fixtures, public export/source cycles, fixed compatibility bytes and emitted headless consumer |
| Desktop and workbench `check:renderer` | Pass; actual desktop graph has 1,926 inputs and five Monaco workers/font |
| `bun run test:editor-integration`; `bun run test:chat-integration` | Pass; 26 editor/workspace and 7 controlled chat tests |
| `NX_DAEMON=false bun run typecheck`; `bun run lint`; `bun run format:check` | Pass |
| `NX_DAEMON=false bun run test` | Pass; 8 tasks, 6 unchanged tasks cached; desktop source tests also ran directly |
| Desktop `test:browser` | Pass; 13 shell/Chat browser tests |

Final native/archive checks on the delivery code:

| Command | Result |
| --- | --- |
| `bun run --cwd apps/desktop test:native` | Pass; 64 tests, one worker, unchanged deadlines |
| `NX_DAEMON=false bunx nx run @moonbase/desktop:package` | Pass; unsigned Apple Silicon application |
| `bun run --cwd apps/desktop check:package` | Pass; archived bytes match built output; all four private owners and intended local Pi graph present; 1,615 main / 1,926 renderer inputs; native/ripgrep resources, workers/font and required notices retained; hooks/graph metadata excluded |
| `bun run --cwd apps/desktop test:package` | Pass; 23 tests against the final archive, including reload, composition and system-PATH-only execution |

`bun run --cwd packages/workbench test:ui` also passed all 48 project-browser tests, serially after packaged execution. Artifact identity (the PR delivery commit identifies the corresponding source tree):

| Artifact | SHA256 |
| --- | --- |
| `apps/desktop/release/mac-arm64/Moonbase.app/Contents/Resources/app.asar` | `d2a6362a4a6424f42d652919af35947f24ac1117900182c4329b2e7d6d8ddea9` |
| `apps/desktop/dist/main.mjs` | `45224632e3f20a6225241fa6c8537cf28fb06f6f72adb27e7daa21e9415c55a0` |
| `apps/desktop/dist/preload.cjs` | `63d477edc4771cbc4a159159c257c9dda639c811ebfa34776ec7fd44ba9216c1` |
 Detailed logs are in ignored `test-results/issue-89/`.

The first native run had three local fault-fixture failures because its source hook still targeted the pre-extraction `main.ts`; the hook now targets `main/chat-backends.ts` and asserts its marker exists. All four local tests then passed. That run also hit a retained Create retry-button timeout, which passed in isolation and in the subsequent full 64-test native run. Original failure logs/traces remain in `test-results/issue-89/initial-native/`; no deadline or retry assertion was weakened. That intermediate tree also passed all 23 packaged tests before the final absent-backend guard restoration. Only final-tree results below qualify the delivery.

Fresh independent read-only agent review found no actionable issues in the full extraction and a separate follow-up of the final local fault-fixture wiring. A third fresh review of the restored absent-backend confirmation guard also found no issues. Reviewers made no changes and did not substitute source review for execution.

These are source, controlled browser/Electron and archive checks. Real provider/SSH access, physical OS gestures, VoiceOver, power-loss durability, Intel execution and signing/notarization are not qualified. No real provider quota, legacy-state import/deletion, deployment or PR merge is performed.
