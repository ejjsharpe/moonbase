# Application

`@moonbase/application` holds the headless editor and chat features: controllers, shared command dispatch, cancellation, composition and lifecycle. It imports no Node, Electron, React or infrastructure implementation; callers inject clients and platform capabilities.

`createMoonbaseApplication` composes editor-only, chat-only or combined applications in one client runtime, with coordinated Quit (preservation, Save/Discard/Cancel prompts) and disposal. [`examples/headless.ts`](examples/headless.ts) runs all three compositions without Electron.

| Export | Purpose |
| --- | --- |
| `.` | Application factory, lifecycle snapshots and types |
| `chat` | Headless chat model and controller, including transcript navigation and Find |
| `editor` | Headless editor model and controller |
| `testing/memory-workspace` | In-memory workspace capability for tests and demos |
| `runtime/handlers` | Shared command dispatch and subscriptions |
| `runtime/clients` | Editor, chat and connection clients bound to an existing runtime |
| `runtime/effect-client` | Invocation and observation helpers bound to a supplied runtime |

Renderers receive browser-safe clients. Native and transport adapters validate and authorize input before calling the shared handlers; schema validation alone grants no authority. A `ChatClient` that receives untrusted data decodes and size-bounds every reply and snapshot (the Pi runtime's local and remote services; desktop forwards them to the renderer unchanged); shared chat code trusts `ChatClient` outputs and checks only their meaning: echoed sources and selections, cursors, offsets, authority and liveness.

The transcript retains up to `transcriptLimits.summaryRecords` history records and `summaryBytes` of summaries (each entry's text is a 4 KiB preview). Earlier and later reads add a page and evict from the end the reader is moving away from, never the reading anchor's row; other growth (snapshots, part reads) evicts away from a page read in flight, else from the end farther from the anchor, or the oldest at the live edge. Evicting the newest records stops following. Only history reads set `error`; manifest and part reads keep their failures on their own state. A jump to an entry outside them replaces them and bumps `dataset`. `rows` lists them with the live response for a virtualized list; a saved reading position (`TranscriptViewAnchor`) is `{key, offset}`, the first visible row and its offset from the viewport top.

After a retryable (`Unavailable`) watch failure, the chat controller shows the last snapshot as reconnecting and re-watches the selected chat after each backoff in `transcriptLimits.watchRetryMs`. Recovery only reads. A failed watch delivers nothing more and is released at once. The attempt count resets only when the failed watch had stayed up for `transcriptLimits.watchHealthyMs` after its first snapshot. Once the attempts run out, or if the transcript had already failed, the transcript stays failed until Refresh or reopening the chat.

```sh
bun run --cwd packages/application typecheck
bun run --cwd packages/application lint
bun run --cwd packages/application test
node packages/application/scripts/measure-editor-snapshots.mjs   # editor snapshot timing harness
```
