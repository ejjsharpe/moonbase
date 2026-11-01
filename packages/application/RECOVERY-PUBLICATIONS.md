# Exact recovery publications

`persistRecovery` binds `{ clientId, requestId, expectedRevision, state }` immutably and returns `{ clientId, requestId, previousRevision, revision }`. A successful publication increments the CAS revision once. The workspace stores the binding (a canonical payload digest suffices) and original receipt atomically with the snapshot and explicit-publication fence in its existing journal.

- Same ID and payload returns the original receipt before checking current CAS. It does not repeat a write or advance the publication fence.
- Reusing the ID with changed expected revision, state or client binding rejects with `InvalidInput` before effects. A new ID with stale CAS rejects with `Conflict`.
- `getRecoveryPublication({ clientId, requestId })` returns that exact receipt or null without publishing anything. Null during an in-flight request does not prove non-admission. Service/storage failure remains visible.
- Clients validate the receipt's client, request ID and exact `previousRevision → revision` transition. A receipt for their original request can resolve a lost response; an arbitrary `loadRecovery` revision or equal-looking snapshot cannot.

The editor retains captured drafts throughout fallible close preflight/metadata publications. One final destructive publication commits the captured close choices. Once its exact receipt confirms success, close is committed; a later unrelated metadata failure cannot turn that committed Discard into a vetoed close. Later metadata stays live/scheduled and reports its own persistence failure.

An unresolved final response retains live buffers and the immutable pending publication/close evidence, reports pending or uncertain outcome, and blocks further destructive actions and Quit until exact resolution. Bounded status lookup or retry of the original publication is safe; neither repeats filesystem work. Do not clear an unknown request, substitute a new payload/ID or adopt a competing revision. On process restart, durable recovery reflects the committed final choice if it happened; otherwise the prior retained drafts remain. No second browser store or generic workflow engine is required.

These are contract semantics, not qualification of either adapter. Editor/memory and workspace owners must implement them and test real lost responses, changed reuse, later competing CAS, restart, failure and explicit-publication observer bounds. Best-effort recovery and the separate filesystem/SQLite resource boundaries remain unchanged; no external exactly-once or power-loss promise is added.
