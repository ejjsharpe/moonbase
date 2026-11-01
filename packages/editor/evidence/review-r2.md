# Review R2 corrections

Reviewed head: `46bae019450dc600f50142e82c8c3e61da6388f3`. Base remains `6e58c1c4ea6944e8ca25eadc46e35c843f0f9fbe` (`chore/checkout-recovery-contract`, #5). New executable/test source: `d166c15d39b085ceb700d12e8f0c152e4c8b7d5b`. The following evidence-only commit adds this record/README links and the inspected capture. No root, contract, dependency, sibling implementation or export changes.

PR #4 remains draft for fresh independent R3. Independent R2 cleared the original R1 scenarios; these four additional findings are addressed in implementation, with approval still pending.

1. **P1 persisted replacement collision:** the memory service now plans all affected clients' recovery updates against the proposed file map and validates candidates before its synchronous commit. A move remap that would combine two persisted drafts keeps that observer's BOTH ORIGINAL drafts, paths, disk baselines, view metadata and revision unchanged. It records pending recovery-publication evidence, without a false revision transition. Acknowledgement also rejects an unresolved collision after an arbitrary publication. The restart regression persists dirty `a.ts` and `b.ts` BEFORE a foreign replacement move, confirms no duplicate/invalid recovery snapshot, then reloads both texts and unacknowledged evidence with one mutation.
2. **P2 definitive non-admission:** Save and mutation dispatch use the same typed InvalidInput policy. An input rejection before admission clears only its pending request/operation; the error remains visible. Unknown/lost outcomes retain the immutable original identity. Classification happens at service dispatch, so a later recovery-publication failure cannot discard admitted operation evidence. Both public and Chromium unchanged Rename/Move → replacement confirmation regressions verify zero mutations and usable Save, Close and Quit afterward. Existing lost-response tests remain green.
3. **P2 surviving file activation:** after successful close publication and lock release, the controller opens the selected survivor through its existing activation path. Remembered views, current disk contents, dirty/missing-buffer retention and generation checks are reused. The public restart case restores only active `b.ts`, closes it and loads surviving `a.ts` with its remembered staged comparison. Chromium also exercises Open two → Close All → Reopen Closed Files → close active → usable survivor.
4. **P2 keyboard focus:** successful keyboard activation queues an exact-target focus request, handled after Monaco mounts. Visual Cmd+Option+Right and Ctrl+Tab/Control-release both focus the new file's editable textbox; if navigation started in the file strip, its target tab receives focus. Browser tests TYPE with `page.keyboard` after BOTH shortcuts and assert the new buffer contains the text, then verify tab-strip focus separately. Tree preview and lookup focus regressions remain green.

## Validation

- Red: **3/3** new public controller cases failed on the reviewed head; **4/4** focused Chromium cases failed (rejected move lock, survivor absent, visual/recent focus inactive).
- Green: **41/41** public controller cases and **9/9** actual Chromium journeys, no skips. Includes every previous lost-response, receipt/CAS, observer, disposal and R1 regression.
- Frozen install unchanged. Uncached root Nx typecheck/lint/tests pass for both projects; lint is TypeScript diagnostics. Foundation verifies **40** source hashes. Whitespace passes.
- Vite+ build compiles StyleX and **five** Monaco workers; renderer import check covers **1,569** inputs without Node/Electron, feature runtime or privileged workspace/Pi/SSH code. Monaco's existing large-chunk warning remains.
- Impeccable detector for the changed workbench returns `[]`. No temporary debug logging or scratch helper is shipped.

## Actual UI and remaining gates

[keyboard-typing.png](keyboard-typing.png) was captured in Chromium at **1600×1000 CSS px** and opened for inspection. The first editor has typed `typed after visual` into `README.md` immediately after keyboard navigation; the second retains its independent original buffer. Dataset: the four-file volatile demo in `demo/main.tsx`. Prior normal/constrained/checkout-closed captures remain linked from the README.

These are controlled module and browser checks. Fresh independent R3, actual controller/workspace files/Git/SQLite fan-in, native picker/drop/Trash, packaged Electron/signing, complete-app accessibility/VoiceOver and human acceptance remain **PENDING**. No provider quota, SSH host, legacy-state import, deployment, PR merge, watcher or new delegation was used.
