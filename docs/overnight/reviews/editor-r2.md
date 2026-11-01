# Independent editor review, round 2

PR #4 head `46bae019450dc600f50142e82c8c3e61da6388f3`, base `6e58c1c4ea6944e8ca25eadc46e35c843f0f9fbe`. GPT-6 Astra `xhigh`, isolated read-only Moonbase worktree and private origin verified. Original eight scenarios are repaired; four blockers remain.

1. **P1: memory adapter loses a pre-existing dirty replacement draft.** Dirty A and B persisted before foreign A→B replacement become duplicate B drafts. Restart keeps one, publishes loss and acknowledges. Validate/remap before committing; on collision retain both original drafts and pending evidence. Test both drafts predating the operation.
2. **P2: definitive mutation rejection wedges Save/Close/Quit.** Unchanged rename produces InvalidInput with zero mutations, but pending uncertain operation remains and status is null. Clear definitively non-admitted operations while preserving genuinely uncertain identity.
3. **P2: closing restored/reopened active file does not load survivor.** A survivor with no buffer displays unavailable despite existing on disk. After preservation, activate it through normal opening with remembered view/current contents.
4. **P2: keyboard file navigation loses focus.** Cmd+Option+Right and Ctrl+Tab/Control-release select correctly but leave focus on BODY. Restore intended focus after activation/mount, retaining preview tree and originating tab-strip focus. Browser regressions must type afterward.

All 38 controller tests, five Chromium journeys, uncached root diagnostics/tests, forty source hashes, 1,569-input renderer isolation, five-worker build and whitespace checks passed; all three screenshots were inspected. Exact-head hosted CI succeeded. Extra probes reproduced every finding. Shared command routing, watch/resource ownership and observer receipts remain intact; no source edits or copied notice bundle.

Owner R2 repair assigned; PR remains DRAFT. Actual filesystem/controller integration, native/package/signing, VoiceOver and human acceptance remain PENDING. Memory evidence does not establish production durability.
