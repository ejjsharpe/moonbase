# Independent workspace review, round 1

Reviewer: GPT-6 Astra, explicit `xhigh`, isolated read-only Moonbase worktree. PR #3 reviewed head `271920d48ae377aa8671c3a569ede429d43cc38f`, base `68aa035b9c283a65cac6e78ab02865e99882d15b`. Seven reproduced findings require owning-module fixes and a fresh review.

1. **P1: case aliases bypass save locks.** Case-insensitive paths to the same object allowed two same-baseline saves to succeed and overwrite. Reject aliases using actual spelling/identity and lock consistently.
2. **P1: native import can Trash its own source.** Self-import with replacement consent Trashed the original before failing. Validate source/destination identity and directory ancestry before replacement Trash.
3. **P1: concurrent immutable IDs admit two mutations.** Same actor/request ID on different paths passed absent-record checks before awaited IO. Reserve/bind each ID before effects without globally blocking unrelated resources.
4. **P1: concurrent recovery erases revision receipts.** Simultaneous status/load reconciliation could overwrite a committed `1→2` transition with an empty array. Serialize per-operation recovery or re-read/merge within publication transactions.
5. **P1: copied drafts can invalidate all recovery.** A 257-draft folder copy committed 514 drafts past the 512 limit, making later loads reject. Validate internally reconciled state, retaining the previous valid snapshot and pending facts on overflow; never truncate drafts.
6. **P1: uncertain Save can hide newer admitted text.** An older persisted draft prevented recovery from exposing later journaled Save text after staging interruption/external change. Restore captured text/baseline when admission revision still matches; preserve competing later publications.
7. **P2: single-use native references admit concurrent reuse.** Two operations could consume one token before completion. Atomically claim for one admitted operation and finalize its descriptor with that operation.

All 41 original native/module tests, 14 shared tests, type/lint/hash and whitespace checks passed; extra public-interface probes reproduced every finding. No prohibited imports, feature-owned root runtime or provenance defect was found. The reviewer changed no tracked files.

The review's inspected older CI run failed because rg was absent. Coordinator subsequently fixed provisioning at `9cb6723e65ddd3d9fe16d12e2702fe7671103dbd`; exact-head hosted checks pass and the lead passed all 41 tests with the freshly generated asset. That CI prerequisite is resolved separately from these runtime defects.

Owner follow-up reports nine initially failing regression tests, eleven focused cases passing after fixes, and full schema/normal-suite validation in progress. This is not independent technical approval. Packaged/controller integration, physical-volume/power-loss and human/native/accessibility gates remain PENDING.
