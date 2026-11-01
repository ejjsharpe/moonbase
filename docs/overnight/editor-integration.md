# Reviewed independent editor integration

**DRAFT repair candidate.** Independent fan-in R1 at f44 found a P1 lost/reordered Save-receipt gap in inherited c31 editor behavior. This candidate includes committed module repair `449496961c29c90c7a2e3c44d0618f08ef504947` and two real regressions; module R9 and fan-in R2 review are pending. No app acceptance/resume follows from local tests alone.

This non-default working branch normal-merges reviewed workspace `38c6c551ff0ab1108077275d223a32967f32b9f6` (PR #3, Astra R6) and editor `c31bb4164d2ff18031e2b391a83198bb5e40d027` (PR #4, Astra R8). Both depend on publication contract #7 `8557fdd0d7a71f93a6584c77430e6fde57668580`. The parent merge commits are `c15bc16` (workspace) and `1e7c442` (editor). No GitHub PR/default-branch merge or source rewrite occurred.

The original coordinator fan-in added real boundary tests, test imports/lock registration, CI invocation and evidence. Its new candidate additionally normal-merges the editor owner's committed repair; `packages/editor` exactly matches4494969. Shared application interfaces, workspace implementation source and pinned versions are unchanged. A coordinator follow-up adds the public `@moonbase/workspace/filesystem` asset export for require.resolve-based packaging, with no executable JavaScript import or native source change. The real fixture resolves that public asset rather than a sibling implementation path. Root test dependencies reference application/editor/workspace through their workspace exports; no private helpers or memory adapter are used. This branch contains no chat, connection or SSH implementation.

## Public production-adapter proof

`tests/editor-workspace/integration.test.ts` constructs one root `ManagedRuntime` with public `WorkspaceLive`, uses shared `makeEditorClient`, then creates public editor controllers. Tests use real temporary Git repositories, files, native helper, official standalone ripgrep and fresh SQLite state. Every fixture disposes controllers/runtime and removes its temporary data. User Git/SSH configuration, old stores and escode are untouched.

The original nine scenarios pass:

1. HEAD/index/working comparisons share a dirty buffer; identical paths in different checkouts remain independent; restart initializes open discovery and retains the correct dirty target.
2. A real completed Save held at the reply boundary retains newer edits and its exact saved baseline over restart, with one Save dispatch.
3. One controller's successful Save leaves another controller's original dirty baseline intact, including restart and subsequent conflict.
4. Real move facts remain available after origin acknowledgement until the other observer reconciles/publishes; both live dirty drafts remap without text loss.
5. Copy materializes independent dirty buffers against the actual copied disk baseline and Save changes only its destination.
6. A real external SQLite write lock vetoes Discard; resolving the failed preflight retains the draft and requires a new explicit Close choice.
7. Lost final Close response retains visible pending identity/live text; exact original receipt resolves committed Discard even after a later publication. A subsequent stale flush conflicts rather than adopting the latest revision; restart retains the committed closed state.
8. Closing and restarting while a checkout directory is unavailable retains views/positions/tree with no discovery reads; authorized reopen restores its comparison and current working data.
9. A captured close retains an earlier successful Save and every proposed Discard when a later Save conflicts, preserving dirty recovery and original baselines. Quit Cancel remains a veto.

Two additional real scenarios causally failed at old c31 (9pass/2fail) and now pass: lost A reply → B commit → original A retry, and reversed A/B replies. Both retain newer drafts/baselines through restart and recover Quit. Original request-ID sets and saved-file inodes remain unchanged during receipt recovery. See editor-save-regressions.md and the committed owner response.

One move scenario coalesces actual watcher delivery until origin acknowledgement, then releases it; the service, controllers, SQLite and native mutation are real. Reply-loss scenarios wrap the public command response only, leaving actual committed persistence intact. These are controlled process-boundary failures, not Electron IPC tests.

## Validation

```sh
bun install --frozen-lockfile
node scripts/prepare-ripgrep.mjs
MOONBASE_TEST_RIPGREP="$PWD/dist/tools/ripgrep/rg" bun run test:editor-integration
bun run check:foundation
NX_DAEMON=false MOONBASE_TEST_RIPGREP="$PWD/dist/tools/ripgrep/rg" \
  bunx nx run-many -t typecheck lint test --skip-nx-cache --outputStyle=static
git diff --check
```

Passed locally: frozen install unchanged after root test registration; eleven integration cases; all nine uncached Nx tasks across three projects; application14/editor92/workspace91 tests, no failures/skips; forty source hashes/UI/browser boundaries. Lint is TypeScript diagnostics. Eleven integration cases plus197 module tests total208 tests. Source/compiled assets are unchanged: native helper SHA256 `3b1431e53880081151fb7e2ca398f3534924c644d2aa240990e9f8ff5eafb3e1`; official rg15.2.0 SHA256 `a326a1fb48074202e9ad41e4cd1e389eeea372c8c6f7d7e80da81176d5d9430e`. Raw local Nx log: `/tmp/moonbase-editor-save-repair-nx.log`. CI now invokes these typed integration cases after module tests using its qualified standalone rg asset.

Prior browser evidence remains at reviewed editor head: 24 supplied Chromium journeys plus four fresh R8 journeys, inspected screenshots,1,569-input renderer isolation and five Monaco workers/font build. Those unchanged-source browser tests were not repeated for test/root-only fan-in additions. The two exact-head independent review reports are retained under `reviews/`.

## Next gate

The local repaired candidate passes its real controller/workspace handoff checks. Independent exact-head review must clear the newly found P1 before task04 resumes Save/recovery acceptance. It is not a runnable Electron shell or packaged/native acceptance. Task04 owns `apps/desktop`, composes the same shared handlers/runtime and must validate actual sandboxed IPC, native approval/token paths, Quit/hide behavior and packaged helper/rg/Monaco assets. Full scope is in the embedded overnight task and `editor-proof-gates.md`.

PENDING: fresh integration review/hosted CI, Electron/preload/renderer IPC, native picker/drop/clipboard, packaged execution/signing, Finder Put Back, VoiceOver/full-app accessibility, performance, physical full-volume/power-loss and human acceptance. No provider or unspecified SSH host was used. No filesystem/SQLite atomicity or external exactly-once guarantee is inferred.
