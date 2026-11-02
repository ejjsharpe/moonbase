# Direct headless consumer

An in-process TypeScript client uses `createMoonbaseApplication` and its supplied controllers directly. It needs no Electron, React, Monaco, platform service implementation or additional adapter. The factory owns one client application runtime; the example injects ordinary Promise/callback clients and synchronous chat storage, without creating a second runtime for fake capabilities.

```ts
import { createMoonbaseApplication } from '@moonbase/application';

const application = await createMoonbaseApplication({
  editors: [{ client: editorClient, clientId: stableEditorId }],
  chat: async () => configured ? { chat, connection, context, storage } : null,
});
const [editor] = application.editors; // Recovery is already loaded.
const unsubscribe = editor.subscribe(() => render(editor.getSnapshot()));
await editor.openCheckout(approvedRoot);

// Render the model's exact closePrompt and call answerClose(id, choice).
if (await application.prepareQuit()) {
  unsubscribe();
  releasePresentationResources();
  await application.dispose();
}
```

Omit `chat` for editor-only use or `editors` for chat-only use. Chat startup observes configuration; Connect, Create, Send and Stop are explicit controller actions. Every editor requires a distinct stable recovery ID. Clients and storage retain their existing authorization, exact identity and preservation responsibilities; shape validation grants no authority. See [lifecycle](LIFECYCLE.md) for optional startup failure, synchronous unload veto, prompt answers, the prepared admission fence and root-owned panel cleanup.

## Executable evidence

[`examples/headless.ts`](../examples/headless.ts) is a portable self-check against public imports. It runs editor-only, chat-only and combined applications with one application runtime per composition. It asserts loaded recovery, synchronous snapshot/draft delivery, explicit Open/Save/Connect/Send completion, synchronous draft writes, awaitable detach, no Send replay, successful Quit admission fencing, public error codes, synchronous snapshot unsubscribe, stable disposal, closed IO observations and no late state/storage changes. Its tiny editor capability implements only the commands this example uses; it makes no filesystem or durability claim. The chat capability is shared with the lifecycle tests.

From the repository root with Node `26.13.0` and Bun `1.4.4`:

```sh
bun install --frozen-lockfile
node --experimental-strip-types --test packages/application/test/headless-consumer.test.ts
bun run --cwd packages/application typecheck
bun run --cwd packages/application test
bun run check:foundation
```

`check:foundation` bundles the existing public smoke fixture, including this consumer, with esbuild's browser target and no Node polyfills. It inspects the actual transitive inputs for React/Monaco/Electron, Node, provider and filesystem/SSH/Pi implementations, writes the emitted ordinary JavaScript to ignored `test-results/headless/consumer.mjs`, then executes that JavaScript under Node and checks all three compositions. The output reports input count and emitted bytes. Browser-target bundling and Node execution are distinct evidence; this check does not execute a browser or another native runtime. The migration starts this qualification from composition revision `61867e86a5279cb038474cc52106f272e94efcdd`; the delivery PR records the qualified code revision and results.

The initial #71 run passed both consumer tests, all 256 application tests, application typecheck/lint, formatting and foundation checks. Its public smoke bundle contained 274 actual inputs and 1,174,244 emitted bytes. The full application run needed loopback access for its controlled host fixtures; a sandboxed attempt passed 253 tests and could not start those three fixtures, then the permitted controlled run passed all 256. These results describe this qualification run, not later revisions.

The application test command also runs the public factory regressions in `test/application.test.ts`: optional chat failure with a usable editor, required acquisition unwind, unsafe saved bytes, Quit veto and restoration, reentrant final preservation, all controller/workflow admission paths, duplicate/opening/Quit races, head loss, namespace reuse fencing and held/failing IO cleanup. `test/effect-client.test.ts` retains pre-aborted/cancelled invocation, responsive unrelated work, normalized errors and actual observation finalizer coverage. These existing focused tests supply failure/race evidence instead of copying them into the example. Snapshot subscriptions unsubscribe synchronously; IO observation close is a separate awaitable resource contract.

## Data and a future process/language boundary

Domain command inputs/results, editor/chat/lifecycle snapshots and public error DTOs contain serializable data. `test/headless-consumer.test.ts` round-trips representative unchanged baseline Send/Stop/recovery fixtures, an admitted Send result, a chat snapshot and the existing error DTO through JSON, preserving original whitespace and a null queued task. The baseline files stay byte-for-byte unchanged; the foundation compatibility check still decodes their saved/protocol formats.

Controllers, callback functions, subscriptions, AbortSignals/cancellation handles, IO close handles, Effect service tags and runtime objects stay inside the TypeScript process. `ApplicationError` is a runtime class; a process boundary encodes its existing public error DTO and validates it at the receiving boundary. Privileged `ConnectionService.endpoint` credentials, configuration and service ports must remain behind the authority boundary and never become head-facing data.

A future client in another process or language would require a concrete adapter that maps its commands, snapshots, error DTOs, cancellation, observation release and lifecycle handoff to this application, with its own authorization and transport/runtime qualification. The portable capability seam and these JSON examples do not establish interoperability with another language. No generic adapter, new transport, binding framework or alternate runtime is introduced here.

These are source and controlled portable-consumer checks using temporary in-memory data. Native/packaged desktop execution, real SSH/providers, physical durability, accessibility and another-language integration remain separate qualification.
