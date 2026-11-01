# File activation and close preservation

Implements the two architecture deepening decisions agreed in the review conversation on 2026-10-31. This is an internal refactor of accepted file-tab and checkout behavior; product terminology, wire contracts, storage formats and host authority are unchanged.

`src/file-activation.ts` owns normal/comparison/conflict activation, shared clean-buffer refresh, dirty-baseline retention, stale-response rejection and suppression of comparison refresh during pending activation. Lookup supplies its current-scope predicate. Focus checkpoints retain presentation validity after successful lookup closes its popup. The checkout renderer applies presentation results and retains Monaco setup, tab arrangement and explicit save/reload actions. The former positional selection flags and caller-owned opening/generation counters are removed.

`src/close-preservation.ts` owns captured Save/Discard/Cancel choices, recovery publication, scoped rollback and deferred model reset. Snapshots are taken after choices so completed Saves remain facts. File close, checkout close and Quit use the same preservation path; callers retain tab history, survivor selection and host lifecycle preparation/completion. Checkout participants retain their close gate until the whole operation finishes, including failure. Rollback preserves unrelated recovery changes.

The existing file-operation journal and shared path reconciler remain authoritative for filesystem outcomes. There is no new transport adapter, dependency or generalized file-operation transaction module.

## Verification

- Typecheck, lint, renderer/host build and macOS arm64 packaging passed.
- Nine module-interface tests cover stale normal reads overtaken by comparisons, clean/dirty conflict restoration, pending activation versus refresh, cancelled lookup scope, focus after popup closure, Save then Discard then Cancel, publication/lifecycle failure and reset ordering.
- Development Electron: **33/33 passed** across `editable-diff`, `file-tabs-close`, `file-tabs-restore`, `lifecycle-races`, `lifecycle`, `navigation` and `retained-project`. These use real temporary repositories and existing visible-control assertions without exclusions.
- Packaged Electron: **9/9 passed** with `ESCODE_PACKAGED=1` and the restricted PATH harness: deferred batch Discards, failed close publication, clean/dirty conflict restoration, delayed conflict activation, inactive Save-before-Trash Overwrite/Reload, Open affected files, cancelled Quit and cancelled/edited lookup.
- Full unit suite with one worker: **293 passed, four skipped** across 31 passing files and one skipped file (`bun run --cwd apps/desktop test -- --maxWorkers=1`).

Both default parallel full unit runs passed 292 tests with four skipped and failed the same unchanged lookup-policy observation test waiting for a notification (`host/lookup.test.ts:106`). Its isolated rerun passed all five lookup tests. No watcher code or timeout was changed; the default parallel suite is not claimed as passing.

## Limits

No real-provider turn, manual VoiceOver session or exhaustive desktop suite was run. Recovery remains best effort; completed filesystem effects cannot be rolled back, and existing check-before-save limits remain. This evidence does not extend earlier parent acceptance claims.
