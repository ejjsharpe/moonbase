# Native import and create dialog follow-up

Base: reviewed editor/workspace integration `80b0ede184205b9fff1d633d19426c2bf9671688` (PR #11). This change uses the existing application contracts, controller handlers, native token authority and mutation dialog. It introduces no service, runtime, dependency or source-path authority.

The desktop producer exposed two real mismatches: a single picker token was submitted with an empty destination, which production rejects; New File/New Folder inspected an empty source array, which production also rejects. The memory adapter previously accepted that empty inspection and hid the create failure.

`EditorWorkbenchHandle.importFiles(checkout, references): void` now copies the exact open checkout and tokens into the same dialog used by the picker. Single imports require a filename destination. Batches allow an existing folder or the checkout root, with optional exact replacement paths inspected and confirmed. Subsequent checkout selection/caller argument changes cannot redirect the captured dialog. Busy preservation/dialogs and unavailable exact checkouts reject visibly. Cancel dispatches nothing. `prepareQuit()` and the command/service schemas are unchanged.

Create/import with no local source selection now use `[]` without calling inspection. The memory inspection adapter rejects empty and oversized selections with `InvalidInput`, matching production's 1–256 bound.

## Validation

- Before the fix, the new public memory test failed with **Missing expected rejection**. After enabling strict memory validation, the existing Chromium create journey failed to open `created.txt`, reproducing the production UI mismatch. Both now pass. Logs: `/tmp/moonbase-import-memory-red.log` and `/tmp/moonbase-import-create-red.log` in the coordinator worktree environment.
- Nine uncached Nx tasks pass: application **14**, editor **103**, workspace/native **91** tests, typecheck and lint (TypeScript diagnostics).
- Real editor/workspace integration **15/15** passes, including the new public producer test: empty inspection rejected; create file/folder with `sources: []`; single token + explicit captured replacement; consumed-token rejection; two-token root import with exact replacement; original native source remains intact. These use real SQLite/filesystem/native helper and temporary Git roots.
- Chromium **31/31** passes (the prior 26 plus five new import journeys). After a final import description-only change, all five affected journeys, TypeScript and the Vite build pass again. Browser import tests record calls at the public controller boundary; native filesystem behavior is separately established by the real integration test.
- Browser cases cover picker/imperative shared dialog, disabled blank single destination including Enter, explicit replacement consent, copied tokens/checkout, later selection, duplicate-dialog rejection, batch root replacement, Cancel/empty/unapproved target, create file/folder and picker resolution after checkout closure.
- Frozen install unchanged, foundation **40** hashes/browser contracts, renderer **1,569** inputs without privileged imports, Vite five-worker build and `git diff --check` pass. Existing large-Monaco-chunk warning remains.
- Visually inspected actual [single replacement dialog, 1600×1000](import-replacement.png) and [batch dialog, 760×720](import-batch.png). Destination, captured replacement, Cancel and confirmation remain visible in the constrained viewport.

Independent review and desktop adoption/actual Electron picker, clipboard and drop integration remain pending. Signing, full-app accessibility/VoiceOver, human acceptance and physical durability remain separate unrun gates; controlled browser/native integration establishes no packaged acceptance.
