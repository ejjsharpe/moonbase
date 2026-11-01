# Reviewed independent editor integration

This non-default working branch normal-merges reviewed workspace `38c6c551ff0ab1108077275d223a32967f32b9f6` (PR #3, Astra R6) and editor `c31bb4164d2ff18031e2b391a83198bb5e40d027` (PR #4, Astra R8). Both depend on publication contract #7 `8557fdd0d7a71f93a6584c77430e6fde57668580`. The parent merge commits are `c15bc16` (workspace) and `1e7c442` (editor). No GitHub PR/default-branch merge or source rewrite occurred.

The coordinator adds only the real boundary tests, test imports/lock registration, CI invocation and this evidence. Module source, public interfaces and pinned versions are unchanged. A coordinator follow-up adds the public `@moonbase/workspace/filesystem` asset export for require.resolve-based packaging, with no executable JavaScript import or native source change. The real fixture resolves that public asset rather than a sibling implementation path. Root test dependencies reference application/editor/workspace through their workspace exports; no private helpers or memory adapter are used. This branch contains no chat, connection or SSH implementation.

## Public production-adapter proof

`tests/editor-workspace/integration.test.ts` constructs one root `ManagedRuntime` with public `WorkspaceLive`, uses shared `makeEditorClient`, then creates public editor controllers. Tests use real temporary Git repositories, files, native helper, official standalone ripgrep and fresh SQLite state. Every fixture disposes controllers/runtime and removes its temporary data. User Git/SSH configuration, old stores and escode are untouched.

All nine scenarios pass:

1. HEAD/index/working comparisons share a dirty buffer; identical paths in different checkouts remain independent; restart initializes open discovery and retains the correct dirty target.
2. A real completed Save held at the reply boundary retains newer edits and its exact saved baseline over restart, with one Save dispatch.
3. One controller's successful Save leaves another controller's original dirty baseline intact, including restart and subsequent conflict.
4. Real move facts remain available after origin acknowledgement until the other observer reconciles/publishes; both live dirty drafts remap without text loss.
5. Copy materializes independent dirty buffers against the actual copied disk baseline and Save changes only its destination.
6. A real external SQLite write lock vetoes Discard; resolving the failed preflight retains the draft and requires a new explicit Close choice.
7. Lost final Close response retains visible pending identity/live text; exact original receipt resolves committed Discard even after a later publication. A subsequent stale flush conflicts rather than adopting the latest revision; restart retains the committed closed state.
8. Closing and restarting while a checkout directory is unavailable retains views/positions/tree with no discovery reads; authorized reopen restores its comparison and current working data.
9. A captured close retains an earlier successful Save and every proposed Discard when a later Save conflicts, preserving dirty recovery and original baselines. Quit Cancel remains a veto.

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

Passed locally: frozen install unchanged after root test registration; nine integration cases; all nine uncached Nx tasks across three projects; application14/editor82/workspace91 tests, no failures/skips; forty source hashes/UI/browser boundaries. Lint is TypeScript diagnostics. Nine integration cases plus187 module tests total196 tests. Source/compiled assets are unchanged: native helper SHA256 `3b1431e53880081151fb7e2ca398f3534924c644d2aa240990e9f8ff5eafb3e1`; official rg15.2.0 SHA256 `a326a1fb48074202e9ad41e4cd1e389eeea372c8c6f7d7e80da81176d5d9430e`. Raw local Nx log: `/tmp/moonbase-editor-integration-nx.log`. CI now invokes these typed integration cases after module tests using its qualified standalone rg asset.

Prior browser evidence remains at reviewed editor head: 24 supplied Chromium journeys plus four fresh R8 journeys, inspected screenshots,1,569-input renderer isolation and five Monaco workers/font build. Those unchanged-source browser tests were not repeated for test/root-only fan-in additions. The two exact-head independent review reports are retained under `reviews/`.

## Next gate

This qualifies the real controller/workspace handoff for task04. It is not a runnable Electron shell or packaged/native acceptance. Task04 owns `apps/desktop`, composes the same shared handlers/runtime and must validate actual sandboxed IPC, native approval/token paths, Quit/hide behavior and packaged helper/rg/Monaco assets. Full scope is in the embedded overnight task and `editor-proof-gates.md`.

PENDING: fresh integration review/hosted CI, Electron/preload/renderer IPC, native picker/drop/clipboard, packaged execution/signing, Finder Put Back, VoiceOver/full-app accessibility, performance, physical full-volume/power-loss and human acceptance. No provider or unspecified SSH host was used. No filesystem/SQLite atomicity or external exactly-once guarantee is inferred.
