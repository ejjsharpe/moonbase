# Structured transcript reads

`ChatClient.command` and `ChatService` expose `getChatTranscriptContent` and `getChatHistoryAround`. Local and authenticated remote Pi implement the same contracts. These reads never submit, retry, Stop or change context. Create/Send/Stop inputs, request bindings, saved drafts and Pi documents keep their existing formats; existing stores require no migration.

Authenticated `getChatHost` replies optionally contain `features: ['transcript-v1']`. The list allows at most 16 names of 64 UTF-8 bytes; ignore unfamiliar feature names. Absence means legacy chat: keep its existing operations usable and present an upgrade state for structured reads. Advertised support followed by a failed read is a visible error. No Find operation/feature is installed here. Health proofs, `chat-v0`, host version and HMAC domains remain unchanged.

## Sources and ordered manifests

`ChatEntry.transcript` and `ChatRun.transcript` are optional additive `ChatTranscript` summaries. They contain the exact `source`, the first four ordered `parts`, a `nextCursor`, and `thinking: 'available' | 'redacted' | 'none' | 'pending'`. They are previews of the manifest, not a total-content limit. Fetch all descriptors with:

```ts
client.command('getChatTranscriptContent', { source, cursor? });
```

The reply has `kind: 'manifest'`, echoes `source` and the request `cursor` (null initially), and contains at most 32 descriptors. Continue with `nextCursor` until null. A summary's `nextCursor` continues after its first four descriptors; a request without a cursor starts at the beginning. Manifest position is an ordinal within the source's ordered parts. Changed live manifests return `Conflict` instead of combining two revisions.

`ChatTranscriptSource` is either:

- `{kind: 'entry', target, entryId}` for an immutable committed record.
- `{kind: 'live', target, submissionId, taskId, attempt, incarnation}` for an exact live generation/tool round. The task is the generation task. The opaque incarnation binds its control phase, restart incarnation and committed history boundary. Task/attempt alone does not identify a replay.

Every target includes host/store/actor/conversation. Entry ownership, live control and cursor ownership are checked on each read. No source accepts a path or URL. A valid DTO or guessed entry ID grants no authority.

Parts use stable block positions (`m0.b0`, etc.) and retain text/tool/thinking order across all messages of a record. `kind` distinguishes text, thinking, requested `arguments`, `executed-arguments`, result, inert JSON details, recorded patch, numbered diff, image and notice. `role`, `state`, `availability`, `text` preview and `truncated` describe presentation. `bytes` is the full decoded UTF-8/binary size, and `revision` is SHA-256 prefix evidence. Previews are at most 256 UTF-8 bytes. Supported content is never permanently clipped to that preview.

Tool results pair through the public tool task's originating assistant entry and full call ID. `call: {entryId, partId}` names that exact requested argument block; `pairing` is matched, unmatched or ambiguous. Reused IDs across assistants cannot cross-pair, and duplicates within one assistant remain ambiguous. A requested call alone is not evidence of completion or of a globally missing result in an unloaded page. Model-issued live tool tasks expose executed arguments while the public SDK checkpoint retains them. Nested calls always retain their original requested `arguments` from immutable task input. They additionally expose `executed-arguments` from a running execute checkpoint, or from the final slot arguments when the retained result has SDK execution-time evidence; pending and blocked calls have no executed-input claim. Task/parent-task identities support live nested activity. Completed nested content comes from the exact parent-owned public `NestedCallDoc`, including retained text/media, program JSON, details/patches and diagnostics. Those SDK documents retire with the parent; disappearance invalidates the live source rather than claiming available empty content. Live tool parts already backed by immutable entries carry `committed: {entryId, partId}` as an explicit equivalence reference.

Redacted thinking has no content or signature. A live source without supplied thinking remains `pending`; only a committed record with no thinking reports `none`. Authored partial output remains readable after failure/interruption; provider diagnostics, signatures, deferred handles, task checkpoints and configuration never become DTOs. Published tool output/details/diagnostics remain inert data, including truncation notices and interrupted states. Live tails report `droppedBytes`/`droppedLines`; their revisions also bind that tail evidence. Stored images expose only recorded bytes/MIME; malformed base64 is unavailable. Decoding/pixel/MIME display policy belongs to the image consumer. Reset/compaction markers and unknown-record notices retain navigable durable IDs. No spill file or current checkout is read.

## Fixed selections and complete Copy

For a selected descriptor, capture only `{partId, bytes, revision}` as `ChatTranscriptSelection`, then request:

```ts
client.command('getChatTranscriptContent', { source, selection, cursor? });
```

The `kind: 'content'` reply echoes the complete `source`, `selection` and request `cursor`. `offset` counts decoded bytes from zero. `data` uses the reply's `encoding: 'utf8' | 'base64'`. Every chunk contains at most 32 KiB decoded bytes and the entire serialized response, including escaping/envelopes/cursors, stays below 256 KiB. UTF-8 boundaries are preserved. Decode each base64 chunk before concatenation; independently padded base64 strings must not be concatenated as one encoded string.

Advance with `nextCursor` until null. Each live reply revalidates its source/control and fixed prefix before publication. Null proves `offset + decodedChunkBytes === selection.bytes`; a nonterminal chunk must advance. Validate all echoed identities, offsets, byte counts and continuations before publishing or writing the clipboard. A complete message can require multiple ordered text parts. A content read never means clipboard success by itself. Native Copy must validate the captured selection again immediately before writing, and fence replies against newer observed source/control changes; a held transport reply alone is not evidence that a live source still exists now.

An immutable selection remains stable across restart. Live selection evidence fixes the prefix and length at capture: later appends are excluded. Prefix replacement, tail rollover, disappearance, restart or finalization without proved equivalence returns `Conflict` with a source-changed message. Leave the clipboard untouched and reload/retry explicitly. The runtime does not guess a generation's live-to-committed mapping by task ID or matching text. Refresh the coherent snapshot. Only an explicit `committed` tool-part reference proves that correspondence.

Cursors are authenticated, operation/source/selection/direction-bound, transient and opaque. A wrong/tampered cursor returns `InvalidInput` without content. Host restart invalidates cursors; restart immutable reads from their source/entry. A live manifest revision change is `Conflict`. Read cancellation is `Cancelled`; malformed remote echoes are `Incompatible`, and lost reads are `Unavailable`, never mutation uncertainty.

## Around-entry navigation and coherent snapshots

`getChatHistoryAround({target, entryId, cursor?})` returns `target`, `entryId`, request `cursor`, a fixed `upperEntryId`, up to 32 entries newest first, and both `olderCursor` and `newerCursor`. Initially it selects up to 16 entries at/before the anchor and 16 after it. Either continuation is consumed by the same operation with the original target/anchor. Both directions remain available on continuation pages; merge by durable ID in server order. Appends above the captured upper entry do not enter that navigation chain. Restart navigation from the anchor if a transient cursor expires.

`getChat` captures LiveDoc, generation/tool control, tool result references and latest committed entry in one public SDK transaction. Its `transcriptBoundary` is that committed upper entry, or null. History is scanned only through that boundary, while live data comes from the same frozen capture. A held read can therefore return an older coherent view after completion; it cannot mix the new committed partial/final with the preceding live incarnation. Distinct committed IDs are never deduplicated by text/task/attempt, including same-attempt recovery and scheduler-finalized partials lacking attribution.

New reads use no admission lease. Cancellation interrupts the caller's wait, signals the root-owned read between slices and joins actual SDK Promise settlement before resources close. Each around page and content/manifest request is bounded; a future whole-conversation reader must invoke bounded slices, not wrap an entire scan in the legacy uninterruptible command path. Exact Stop and unrelated conversations remain independent.

## Remote observation

The installed network server additionally advertises `chat-stream-v1`. It transports these same coherent replacement snapshots, including boundaries/incarnations/part revisions, directly from the supplied watch. It performs no per-update history or `getChat` reads. Optional `observationStatus: 'connected' | 'reconnecting'` passes through existing snapshot validation and IPC. A reconnecting snapshot retains stale evidence; fresh stream establishment replaces it after validation. See [wire proofs, limits and lifetime](../../pi-runtime/docs/STREAMING.md).
