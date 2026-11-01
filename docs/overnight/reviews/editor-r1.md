# Independent editor review, round 1

Reviewer: GPT-6 Astra, explicit `xhigh`, isolated read-only Moonbase worktree. PR #4 head `0556678460b139abb961b4a67f23ce8383e2136e`, base `68aa035b9c283a65cac6e78ab02865e99882d15b`.

1. **P1: move reconciliation overwrites newer destination edits.** A delayed own/foreign move replaces an already opened/edited destination buffer and removes its recovery. Retain both drafts and unacknowledged evidence when remapping collides.
2. **P1: closing checkout crashes UI/leaks Monaco.** Late position recording after target removal throws during cleanup. Ignore stale position writes and finish all disposal even if recording fails; cover actual Chromium close.
3. **P2: definitive Save rejection wedges pending request/Quit.** Invalid NUL input stays pending after correction. Clear definitively rejected requests while retaining genuinely uncertain/lost-response identity.
4. **P2: retained dirty missing files cannot activate.** A mandatory disk read blocks a tab whose dirty buffer is still available. Activate retained buffers with unavailable feedback; failed new opens still preserve prior state.
5. **P2: checkout close loses restoration metadata/adds file history.** Preserve order, active/comparison selection and positions separately from open membership; checkout closure creates no file-close history action.
6. **P2: restored checkouts never initialize Files/Git.** Load installs watches but ignores ready and never refreshes. Initialize open roots and expanded directories without waiting for an external change.
7. **P2: stale activation overrides newer checkout choice.** Delayed file read in A steals focus after explicit B selection. Invalidate earlier activation when selection changes.
8. **P2: lookup completion leaves focus on body.** After Enter opens a result and closes the dialog, typing/shortcuts miss Monaco. Focus the successful explicit editor after teardown; previews retain tree focus.

All 27 original controller tests, four Chromium journeys, type/lint/hash, 1,569-input renderer check, five-worker build and whitespace checks passed. Reviewer inspected both screenshots and reproduced the eight defects with additional probes. Exact-head hosted CI also passed. No tracked changes were made.

Coordinator additionally found persisted view-key incompatibility: editor composite keys versus production checkoutId keys. PR #5 makes keys explicit and separates retained known targets from open membership, enabling valid closed metadata. Both owners are adopting it. Existing isolated memory/browser evidence does not prove production workspace persistence. Owning fixes and fresh independent review are pending; native/package/manual/human gates remain PENDING.
