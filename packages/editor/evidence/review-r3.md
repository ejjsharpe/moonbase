# Review R3 corrections

Reviewed head: `8e95e18a1823246e2859b5e9ae731c08d90539b8`. Base remains `6e58c1c4ea6944e8ca25eadc46e35c843f0f9fbe` (`chore/checkout-recovery-contract`, #5). Executable/test source: `3ff979cca6206fc19416150b189b211fcc6de86b`. The following evidence-only commit records these checks/README links and inspected captures. All changes are within `packages/editor`; public exports, dependencies, root/shared contracts and resource conventions are unchanged.

Independent R3 cleared the eight R1 and four R2 scenarios, then found these two P2 blockers. PR #4 remains **DRAFT** for fresh independent R4; implementation checks do not constitute approval.

## Responses

1. **Close publication versus newer metadata.** The shared preservation path now applies captured close changes to current metadata instead of installing an old snapshot. It republishes retained newer metadata through the normal recovery queue using the actual acknowledged CAS revision before committing local close changes or removing buffers. It never adopts a revision from `loadRecovery`. Failed publication retains buffers and unrelated checkout metadata; repair publication still respects competing CAS. The reference-change guard is also checked after each publication. Survivor activation is determined from the actual current checkout at commit and guarded against any subsequent newer activation.

   Public regressions delay recovery publication after a restart where only active `b.ts` has a buffer. Newer explicit checkout selection, tree state and sidebar size survive both live and durably for **File Close, Checkout Close and Quit**. Failure probes retain dirty text during a competing CAS rejection and during a later metadata-publication failure, then verify repair uses the actual revision. Chromium clicks beta while alpha's close is pending and verifies live/durable beta selection plus its usable Monaco buffer.

2. **Keyboard Close/Reopen typing focus.** Both keyboard callers now use the same exact-target post-mount handoff as visual/recent navigation. Focus waits for preservation/dialog teardown, retains tree/tab-strip origins, and uses Find file when the last file closes. A hidden root cannot receive the handoff. Cancelled or failed preservation restores the current buffer's focus without discarding its text. No global keyboard listener was introduced.

   Chromium tests actually TYPE after **Cmd+W** and **Cmd+Shift+T** and assert each target buffer contains the input. Additional checks cover Cancel, failed Discard publication, dialog shortcut isolation, tree and tab-strip origins, last-file meaningful focus, reopening from that focus, and shortcuts outside a hidden editor. Original visual/recent typing, tree-preview, lookup, conflict and model-disposal cases remain green.

Caller audit: `close`, `closeCheckout` and `prepareQuit` share the changed preservation path; reload publishes before its buffer change without adopting metadata. Mouse close/batch-menu and native Quit callers continue through the same controller gate. All four keyboard activation callers (visual, recent, Close, Reopen) use the shared focus handoff. Lookup retains its Base UI final-focus behavior; tree previews retain tree focus.

## Checks

- **Before implementation:** the new public probes reproduced stale selection/sidebar metadata for all three preservation kinds and the missing retained-metadata handoff; competing-CAS failure already preserved buffers. Actual Chromium reproduced stale checkout selection, inactive typing focus after both keyboard commands, and a strip/reopen focus failure. The cancelled/failed-dialog scope probe already passed. Initial test-fixture URL/preamble setup was corrected before counting the selection reproduction; no runtime resolver workaround is shipped.
- **46/46 public editor tests** pass, no skips, retaining all prior lost-response, receipt/observer/CAS, cancellation/disposal and R1/R2 cases.
- **14/14 actual Chromium journeys** pass, no skips, including all five focused R3 journeys.
- `bun install --frozen-lockfile`: 486 installs/619 packages checked, no changes.
- `NX_DAEMON=false bun x nx run-many -t typecheck lint test --skip-nx-cache`: all six tasks pass, cache skipped (application 14/editor 46). Lint is TypeScript diagnostics.
- `bun run check:foundation`: 40 immutable source hashes/UI/client checks pass.
- `bun run --cwd packages/editor check:renderer`: 1,569 browser inputs, no privileged modules or feature runtime.
- `bun run --cwd packages/editor build`: StyleX, Monaco font and all five workers build. Existing >500 kB chunk warning remains; startup/performance qualification is unrun.
- Impeccable static detector for the changed workbench returns `[]`; `git diff --check` passes.

## Inspected Chromium evidence and pending gates

All captures below were opened for inspection at **1600×1000 CSS px**:

- [close-selection.png](close-selection.png): restored two-root/two-files-per-root volatile fixture (`demo/recovery-race.tsx`); beta remains selected after alpha's delayed close publication, with beta `a.ts` available. Public/browser assertions also check durable selection.
- [keyboard-close.png](keyboard-close.png): first editor contains `typed after close` in the surviving `welcome.ts` after Cmd+W. Second editor retains its original independent text.
- [keyboard-reopen.png](keyboard-reopen.png): first editor contains `typed after reopen` in reopened `README.md` after Cmd+Shift+T. Dataset is the four-file `demo/main.tsx` workspace; second editor remains independent.

These are controlled module checks. Fresh independent R4, actual controller/workspace filesystem/Git/SQLite fan-in, native picker/drop/Trash, packaged Electron/signing, complete-app accessibility/VoiceOver and human acceptance remain **PENDING**. No real provider, SSH, legacy state, deployment, PR merge, history rewrite, watcher/poll or new child delegation was used.
