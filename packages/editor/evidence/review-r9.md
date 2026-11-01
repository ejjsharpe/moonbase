# R9 — retain missing and reordered Save receipts

Historical owner evidence at4494969. Paired independent R9 cleared the original Save-reordering defect but found a connected publication-resolution defect and a flaky last-alert assertion; see the [current R10 response](review-r10.md). Earlier passing owner runs do not override that independent result.

This followup fixes the production fan-in P1 reported against reviewed editor `c31bb4164d2ff18031e2b391a83198bb5e40d027`. PR #4 remains based on publication contract #7, `8557fdd0d7a71f93a6584c77430e6fde57668580`; the coordinator owns the real workspace fan-in and independent R9 review. Only this package changes.

## Cause and change

The original controller cleared a successful Save's immutable request before its recovery transition/publication succeeded. If A's reply was lost and B's receipt arrived first, B's revision-gap error discarded the receipt needed to finish A's later exact retry.

The buffer now retains its original `pendingSave` until a confirmed recovery publication. Known successful results remain in the same editor instance's pending facts, and each fact pass considers all retained Save transitions together with operation receipts. Only contiguous transitions advance; loaded latest revision/state grants no substitute authority. A retry uses its already-known result without another Save dispatch. Missing results use the original immutable request. Known disk baselines advance immediately while newer live text remains untouched.

A recovery publication captures exactly which known Save requests it settles. Only its exact confirmed receipt releases those requests, including delayed exact resolution after publication response/status failure. A failed/uncertain publication retains both request and result. Destructive Close/Reload/Quit gates still veto unresolved Save identities. There is no new runtime, command queue, durable store or automatic native replay.

## Causal reproduction and public checks

The four initial public scenarios failed against the original controller: lost A discarded B's `pendingSave`, and reversed three-file replies stranded recovery CAS. The unchanged focused Chromium regression also fails against that original source: after B's gap, its Retry Save control disappears. Logs: `/tmp/moonbase-r9-red.log` and `/tmp/moonbase-r9-ui-causal-red.log`.

Ten new public cases use `createEditor`, the concrete memory `WorkspaceService`, shared `makeEditorClient`/handlers and scoped test runtime:

- Lost A → B → repeated known B retry → original A retry, with watchers enabled and disabled. Both newer drafts and captured saved baselines survive a fresh controller; two native-save equivalents, one B dispatch, identical A retry payload.
- Three real service Saves with replies C/B/A, with watchers enabled and disabled. All three known transitions reconcile without repeated writes; newer text/baselines restore and Quit resumes.
- Reconciliation publication failure before commit and after commit with unavailable exact status. Both Save identities survive, exact resolution releases them, later edits persist and restore; native count remains two.
- A genuine unrelated same-client publication remains a revision gap. All exact own results remain retained, latest CAS is never adopted, and Discard/Quit stay blocked.
- After the chain settles, captured multi-file Close with a later Cancel or conflict retains earlier successful Save facts, proposed drafts and tab state. Persisted/restarted drafts are checked.
- Disposal releases watchers and suppresses a late Save receipt/publication.

The new Chromium journey edits both demo files, loses a committed reply, sees the other Retry Save survive the revision gap, retries the original Save, flushes, and actually types after reconciliation. [Inspected screenshot](save-receipts.png): 1600×1000, two editor instances over the four-file volatile demo; the first has modified `welcome.ts` and `README.md`. The historical gap message is dismissed after confirmed reconciliation. This is controlled module UI, not a desktop or real filesystem claim.

## Validation and limits

Passed: frozen install with unchanged lockfile; all six uncached root Nx typecheck/lint/test tasks (92 editor +14 application tests); foundation's40 snapshot hashes; renderer check1,569 inputs without privileged code/runtime; Vite+ build with five Monaco workers/font; all25 supplied Chromium journeys; whitespace check. Lint remains TypeScript diagnostics. Vite reports the existing chunk-size advisory.

Logs: `/tmp/moonbase-r9-nx.log`, `/tmp/moonbase-r9-build.log`, `/tmp/moonbase-r9-ui.log`. Test-generated screenshots/traces are ignored; the inspected current capture is committed here.

PENDING: fresh independent R9 review, coordinator's actual WorkspaceLive/SQLite/native/live-watcher reruns and fan-in; task04 Electron/IPC/package/lifecycle proof, signing, Finder Put Back, VoiceOver, physical durability and human acceptance. The separate unfinished task04 checkpoint is preserved on `feat/standalone-editor`; this module repair does not complete that task.
