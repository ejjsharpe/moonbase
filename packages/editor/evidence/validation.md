# Editor module validation

Validated executable/test source: `1e010afff23facf07759e1dddeffce2b248372c9`.
Exact committed dependency: `68aa035b9c283a65cac6e78ab02865e99882d15b` on `chore/application-coordination` (#2, after foundation #1). The follow-up evidence commit only updates this record, README links and the inspected PNGs; final checks are repeated against the final PR head and reported in its description/handoff.

Checks completed on 2026-11-01:

- `bun run typecheck`, `bun run lint`, `bun run test`: all two-project Nx tasks passed without cache hits. Lint is TypeScript diagnostics, as in the foundation.
- Editor public tests: **27 passed**, no skips. Real application handlers/runtime adapter plus concrete volatile `WorkspaceService`; no production workspace/filesystem claim.
- `bun run check:foundation`: 40 frozen source hashes, active shared UI and browser boundary verified.
- `bun run --cwd packages/editor check:renderer`: browser bundle, **1,569 inputs**; no Node/Electron, Effect runtime, workspace/Pi/SSH implementation or frozen application source in the renderer entry.
- `bun run --cwd packages/editor build`: passed, compiling StyleX and all five Monaco workers/font assets. Vite reports Monaco chunks over 500 kB; no bundle-size/performance qualification is claimed.
- `bun run --cwd packages/editor test:ui`: **4/4 passed** in actual Chromium 156 through the development demo. Typed Monaco edits, explicit Save, shared working/diff buffer, independent second instance, external conflict Compare/Cancel, failed Save, close Cancel/Discard, current-source reopen, model/subscription disposal, hide/show retention, lookup history/highlights, new file, constrained layout and keyboard sidebar resize. A comparison-teardown worker rejection observed in one earlier run was fixed by explicitly disposing Monaco's diff view model before its text models; the same final four journeys pass with page-error assertions and no rejection logged.
- Impeccable mechanical detector on workbench/Monaco/styles returned `[]`; `git diff --check` passed.

The public tests include dirty conflict baseline retention; immutable lost-response Save retry; Save/Discard/Cancel batch rollback; preview replacement/promotion/reorder; order/reopen/view positions; independent recovery namespaces/CAS; exact host/checkout identities with equal paths; uncertain-operation status with one mutation; dirty copies/Trash preservation; restart; disposal; per-observer acknowledgement; newer live edits during Save/move/copy; and unrelated same-client publication gaps that veto close.

## Inspected Chromium captures

- [two-instances.png](two-instances.png): **1600×1000 CSS px**, two editor instances over the same four-file memory workspace. First saved `export const value = 42;` in staged comparison; second retains its independent original working buffer.
- [constrained.png](constrained.png): **760×720 CSS px**, first editor after highlighted lookup opens `src/example.ts` and New File creates empty `created.txt`. The demo hides the second column below 1100 px. No document overflow; separator keyboard resize verified.

Both PNGs were opened and visually inspected. Source dataset: `packages/editor/demo/main.tsx`; only in-memory checkout/files and scripted failure controls. The initial T3 preview snapshot timed out twice; Playwright supplied the rendered checks/captures. Initial missing Playwright Chromium was installed; initial textarea-click/implicit-select-label test issues were corrected, with the final four journeys passing.

## Remaining gates

**PENDING HUMAN ACCEPTANCE.** Real workspace/controller fan-in through files/Git/SQLite, desktop integration, native authorized picker/drop/Trash, packaged Electron assets, complete-app keyboard/focus and VoiceOver are unrun in this module worktree. The module adds no Electron app and imports no sibling implementation. The lead must establish those proofs from reviewed committed fan-in; controlled memory/Chromium success does not establish native persistence or package execution. No provider quota, SSH host, legacy state, deployment or GitHub merge was used.

Source/license provenance is in the package README and immutable snapshot manifest. Distribution notices come from the normal package/release inputs under coordinator ownership; this package adds no manually copied notice bundle.
