# Headless application lifecycle

`createMoonbaseApplication` is the direct in-process TypeScript composition API. It creates one empty client Effect runtime and aggregate scope, acquires each editor/chat model in a separate removable scope, and binds its controller once. It installs no filesystem, SSH, Pi, provider or UI implementation. Privileged main composition remains a separate runtime and authority owner.

```ts
import { createMoonbaseApplication } from '@moonbase/application';

const application = await createMoonbaseApplication({
  editors: [{ client: editorClient, clientId: stableEditorId }],
  chat: async () => configured ? { chat, connection, context, storage } : null,
});
const [editor] = application.editors;
const unsubscribe = application.subscribe(renderLifecycle);
await editor.openCheckout(approvedRoot);
```

The head supplies validated clients, stable distinct recovery IDs, exact chat context and synchronous storage. Factory acquisition loads editor recovery; chat Connect/Send/Stop remain explicit. Multiple editors share the application runtime but keep independent scopes, recovery namespaces and presentation identities. Empty compositions and duplicate explicit editor IDs reject before acquisition. The chat supplier is a concrete asynchronous configuration/context capability, called at startup and explicit reopen, never automatically on reconnect.

Editors are required. A failing editor releases all acquired resources before factory rejection. Chat is optional alongside editors and required when it is the sole feature. Optional supplier/model failure leaves editors usable and records a safe bounded `initialization-failed` message. Missing configuration is `unavailable`; failed release is `cleanup-blocked`. Failed initialization vetoes unload/Quit until an explicit successful reopen. Invalid or unreadable saved chat remains a live model with `storageError` and failed preservation, retaining original bytes rather than becoming an absent feature.

## Public API

| Member | Contract |
| --- | --- |
| `editors` | Stable readonly list of supplied editor controllers, already loaded |
| `chat` | Current chat controller, or `null` after removal/unavailability |
| `getSnapshot`, `subscribe` | Synchronous lifecycle snapshot and synchronous unsubscribe |
| `canUnload()` | Synchronously checks editor recovery readiness and preserves active chat; unsafe startup, opening, pending/failed cleanup or preservation vetoes reload |
| `openChat()` | Explicit acquisition; concurrent calls share one Promise; unfinished cleanup and preparing/prepared/disposed applications reject |
| `closeChat()` | Synchronous preservation decision; success removes chat immediately and retains actual cleanup at the root |
| `prepareQuit()` | Coordinated asynchronous preservation/consent; concurrent calls join the same attempt |
| `dispose()` | Synchronously fences models, cancels prompts and joins actual cleanup; repeated calls return the same Promise and failure stays failure |
| `reportCleanup(error)` | Records a normalized external cleanup error for the existing head/native acknowledgment path |

Snapshots are serializable data: `{ phase, chat: { state, error }, cleanup: { pending, errors } }`. Phases are `live`, `preparing`, `prepared`, `disposing`, `disposed` and `failed`. Chat states are `unavailable`, `opening`, `ready`, `closed`, `initialization-failed` and `cleanup-blocked`. Cleanup retains four bounded error messages. Snapshot unsubscribe differs from awaitable IO observation close. Controllers, callbacks, cancellation handles and Effect objects remain runtime-only; a future process/language boundary needs a concrete adapter and separate qualification.

## Quit and head handoff

Quit checks chat preservation, waits for each editor's exact Save/Discard/Cancel protocol and fences each successful editor before moving to the next. A model-owned final check rejects newer dirty text or unfinished evidence; clean position/view metadata produced by close activation is confirmed through the existing recovery publisher. Uncertain confirmation retains its original publication ID and vetoes until explicit resolution. The application then synchronously fences every model before preserving latest chat state and checking readiness again. The project `@moonbase/workbench` view renders `closePrompt` and supplies `answerClose`. The consuming head routes presentation to editor prompts/uncertainty or its separate Chat preservation failures before and after calling `application.prepareQuit()`; desktop uses its internal `DesktopShellHandle.prepareQuit()`. Native heads retain acknowledgment and disposal wiring. Chat is temporarily fenced during its first preservation write, then accepts drafts during editor prompts for the final pass. Veto or failed final preservation restores admissions without reversing completed Saves/Discards. Duplicate Quit joins its current attempt. Panel open/close is blocked during preparation; an existing open settles before the first preservation pass.

Admission setters publish no callbacks between models. The final storage write may reenter the application, but controllers and retained workflow handles cannot admit new actions or draft edits. Already-admitted save/mutation/publication continuations retain their existing resource scopes and reconciliation. Position/prompt teardown setters safely do nothing after fencing.

The synchronous unload check uses the same fence temporarily while preserving chat and rechecking editor readiness, then restores live admissions. A reentrant storage callback cannot create a new edit or panel between the readiness check and its result.

Successful preparation returns consent with admissions still fenced. The head becomes inert, releases presentation resources, awaits `application.dispose()` and acknowledges its outcome through the existing native/transport boundary. `canUnload()` accepts this completed handoff. Preparation never disposes models or stops remote work.

On head/document loss, call `dispose()` directly. It cancels prompt owners immediately rather than waiting for an unanswered Quit prompt. Late acquisition is released without publishing a new panel. Unload cleanup is best effort; asynchronous or physical durability after process loss is not guaranteed.

## Panels, cleanup and Hide

`closeChat()` fences that model before preserving, removes the current controller promptly on success, and disposes it outside its removable scope. A veto restores admissions while it remains live/current. Root cleanup retains pending/failing outcomes, fences late writes and prevents overlapping namespace reuse. Other editors stay usable while release is held. Reopen requires actual successful finalization. Failed cleanup stays visible and keeps its lease; controlled Quit can still obtain consent and drain/report the failure.

Disposal attempts every instance release, waits for pending acquisition and cleanup, closes the aggregate scope and finally disposes the shared runtime. Failure rejects with a safe bounded aggregate error and phase `failed`, never `disposed`. Initialization uses the same unwind, including held/failing finalizers. No saved recovery is deleted.

Hide differs from disposal. Keep editor presentation mounted for Monaco undo/view state and call chat `detach()`/`start()` for visibility. These operations, local cancellation and disposal never invent Stop or replay Create/Send. Native approval, IPC document authority, windows/reload and private endpoint credentials remain in the head.

## Evidence

`test/application.test.ts` exercises public factory composition, startup degradation/unwind, corrupt saved bytes, prompt veto, final-write reentrancy, every controller admission, workflow handles, opening/Quit races, head loss, namespace fencing and held/failing finalizers. Existing feature suites retain mutation uncertainty and exact publication/receipt coverage. `test/portable-runtime.test.ts` audits the actual browser graph of the public root. These are source/controlled checks; native/package, real-provider/SSH, accessibility and physical durability qualification remain separate.

## Named chat targets and final confirmation

As an alternative to `chat`, supply `chatTargets: [{id, label, acquire}]` and optional `defaultChatTargetId`. IDs must be distinct and the default must exist. Snapshots include `chatTargets` and `chatTargetId`; the existing `chat` controller/open/close API remains intact. `selectChatTarget(id)` preserves the old namespace, awaits its real controller/scope cleanup, then acquires the chosen target. A failed preservation/cleanup vetoes switching. It never Connects, Sends, retries mutations or Stops work. Each target supplies its own exact context and draft storage. Backend execution resources stay with the privileged root across switching/reload.

Optional `confirmQuit(): Promise<boolean>` runs after editor preservation and final chat preservation, with all client admissions fenced. A false result restores admissions and the live phase. The head owns native confirmation and privileged inspection of all local work, including hidden tasks and unfinished admissions; it must restore its backend admission fence when cancelling or losing that document. Returning true leaves client admissions fenced through normal disposal. No Stop is added to shutdown.
