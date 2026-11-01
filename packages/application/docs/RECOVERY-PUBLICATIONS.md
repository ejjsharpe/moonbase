# Exact recovery publications

`persistRecovery` binds `{clientId, requestId, expectedRevision, state}` immutably and returns `{clientId, requestId, previousRevision, revision}`. The workspace atomically stores the binding, original receipt, snapshot and explicit-publication fence in its journal; success advances the CAS revision once.

- Matching ID/payload returns its original receipt before checking current CAS, without another write or fence advance.
- Changed ID reuse rejects with `InvalidInput` before effects. A new ID with stale CAS rejects with `Conflict`.
- `getRecoveryPublication({clientId, requestId})` returns that exact receipt or null without publishing. Null during an in-flight request does not prove non-admission; storage failures remain visible.
- Clients validate the exact identity and `previousRevision → revision` transition. Equal state or an arbitrary latest revision cannot prove receipt ownership.

The editor retains captured drafts through fallible close preflight/metadata publications. One final destructive publication commits captured close choices. Its exact receipt confirms the close; a later metadata failure reports separately and cannot veto committed Discard.

An unresolved response retains live buffers and immutable publication/close evidence, and blocks further destructive actions and Quit. Resolve by bounded exact lookup or original-input retry without repeating filesystem effects. Do not clear unknown requests, substitute payloads/IDs or adopt competing revisions. Restart follows durable committed state, otherwise prior drafts remain.

Both workspace and editor/memory adapters must test reply loss, changed reuse, competing CAS, restart, failure and observer bounds through public interfaces. Filesystem and SQLite remain separate resources; these semantics add no external exactly-once or power-loss guarantee.
