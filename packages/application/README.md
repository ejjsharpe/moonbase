# Application runtime

`@moonbase/application` owns shared typed dispatch, runtime-bound Promise clients and reusable headless feature behavior. Independent definitions, schemas and Effect service ports live in [`@moonbase/contracts`](../contracts/README.md); reusable infrastructure implements those ports without depending on application behavior. Process roots compose only their needed capabilities in one scoped runtime.

The root `createMoonbaseApplication` factory composes supplied editor/chat capabilities into one headless application with direct controllers, synchronous unload preservation and coordinated Quit/disposal. It supports named local/remote chat targets alongside the existing single-chat API, independent and combined features, with visible optional-chat degradation. See [application lifecycle and usage](docs/LIFECYCLE.md) for the API, admission fence, prompt handoff and root-owned panel cleanup.

The [direct headless consumer](docs/HEADLESS-CONSUMER.md) runs all three compositions without Electron through public APIs. Foundation checks audit its browser bundle and execute its emitted JavaScript; the guide records the data/runtime seam and the separate qualification a future process/language adapter would require.

| Export | Purpose |
| --- | --- |
| `.` | Headless application factory, lifecycle snapshots and types |
| `chat` | Scoped headless chat model, bound controller and synchronous draft preservation |
| `editor` | Headless editor model/controller, close prompts, workflow sessions and state |
| `testing/memory-workspace` | Concrete volatile workspace capability for tests and demos; excluded from `editor` imports |
| `runtime/handlers` | Shared command dispatch and subscriptions |
| `runtime/clients` | Editor/chat/connection clients bound to an existing process runtime |
| `runtime/effect-client` | Invocation and awaitable observation close bound to a supplied runtime |

`@moonbase/contracts` supplies the single error brand, decoder functions and service tags. `@moonbase/effect` owns shared safe normalization/release behavior; application invocation reexports its normalizer. Runtime helpers create no runtime, retry no operation and leave injected resource ownership with their caller. Only the application factory owns the client runtime it creates.

Use the public runtime entries directly from TypeScript. `makeEditorClient`, `makeChatClient` and `makeConnectionClient` bind the process root's existing runtime to the same typed handlers; they acquire no second service graph. Headless features use a caller-supplied runtime and bind their already-acquired models. The [chat API](docs/CHAT.md) preserves synchronous snapshots/drafts/storage and reports awaitable observation cleanup; importing or acquiring it neither installs backend capabilities nor Connects, Sends or Stops. Command cancellation affects that invocation; observation close fences delivery immediately and awaits its actual finalizers. Synchronous snapshot subscriptions retain their separate synchronous unsubscribe API. See the [runtime API handoff](docs/SCHEMAS.md) for exact signatures and ownership.

Renderers receive browser-safe clients. Native/transport adapters validate and authorize unknown inputs before shared handlers; infrastructure retains domain validation and resource ownership. DTO types use erased schema imports. Shape validation grants no authority, and privileged endpoint credentials never belong in renderer bridges.

See [Effect invocation and observation cleanup](docs/SCHEMAS.md), [contract schema policies](../contracts/docs/SCHEMAS.md), [chat admission/RPC](../contracts/docs/CHAT.md), [host authentication](../contracts/docs/HOST-PROTOCOL.md) and [recovery publications](../contracts/docs/RECOVERY-PUBLICATIONS.md).

Chat accepts `setDraft()` before selection. `send(settings?)` creates a conversation from that preserved draft when none is selected, retaining the Create and first Send identities through uncertainty; local callers supply approved folder/model settings. Existing `create(title, settings?)` remains available to headless consumers. See [chat composition and preservation](docs/CHAT.md).

`setModelPreference({ model, reasoningEffort? })` synchronously preserves an explicit choice in the chat namespace. New views and replacement controllers retain it; opening an existing conversation does not replace it with that conversation's settings. Provider defaults remain supplied catalog metadata until the user chooses a preference.

The [headless editor](docs/EDITOR.md) acquires once in a supplied scope and binds to the caller's runtime. `@moonbase/workbench` presents a supplied editor controller and exact project/checkout. Consuming apps own main navigation, layout and separate Chat presentation. Synchronous snapshots/recovery readiness, exact close prompts and awaitable disposal retain their existing contracts; unmounting presentation never owns model lifetime.

Editor internals stay private under `src/features/editor/`; consumers continue importing `/editor`.

| Owner | Behavior suites in `test/` |
| --- | --- |
| `editor.ts`: buffers, views, commands, mutation/reference facts and synchronous snapshots | `editor.test.ts`, `editor-save-receipts.test.ts`, `editor-filename-maps.test.ts`, `editor-snapshots.test.ts` |
| `recovery-publications.ts`: exact CAS receipts, retained attempts and scoped debounce | `editor-recovery-readiness.test.ts` |
| `preservation.ts`: captured Close/Reload/Quit, exact prompts and close history | `editor-preservation-races.test.ts` |
| `discovery.ts`: checkout watches, selection scopes, cancellation and refresh coalescing | `editor-discovery-activation.test.ts`, `editor-model-lifecycle.test.ts` |
| `editor.ts`: shared in-flight directory reads, progressive ignore classification and stale-reply fencing | `editor-listing.test.ts` |

Directory navigation publishes all file entries before Git ignore classification completes. Ignored entries remain available for selection, editing and Reveal; later snapshots carry their `ignored` flags for presentation. The saved `tree.hideIgnored` field is retained for recovery compatibility and no longer filters the explorer. Classification uses a child of the caller's read scope, cancels superseded work without delaying entries, reports failures without removing files and fences stale results and disposal.

The existing public model fixture freezes controller signatures at compile time. `application.test.ts` covers aggregate admission/lifecycle; `portable-runtime.test.ts` audits the actual public browser graph, including all three private owners. Tests use public controllers and injected clients rather than private owners.

```sh
bun run --cwd packages/application typecheck
bun run --cwd packages/application lint
bun run --cwd packages/application test
```

Runtime-bound chat clients and shared dispatch also carry the optional [structured transcript reads](../contracts/docs/TRANSCRIPTS.md). The controller negotiates structured transcript support; controlled legacy demo capabilities do not advertise it. Fixed-selection iteration retains its source/length/revision through appends and uses bounded fresh prefix proofs when observed evidence changes.

The [transcript owner](docs/TRANSCRIPTS.md) supplies canonical bounded history, progressive selected content reads, complete-source iteration and transient application-lifetime anchors. Consumers use `ChatState.transcript.entries`; they do not merge the latest snapshot with a separate older page. Durable entry anchors remain compatible; exact live-part anchors carry `controller.backendId`, the full live source and fixed part selection. Apply live anchors/expansions only when `transcript.viewStatus` is `ready`; pending/unavailable/source-changed restoration remains explicit. Saved drafts retain their existing format.
