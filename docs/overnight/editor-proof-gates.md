# Editor fan-in and standalone proof

Run against exact independently reviewed editor/workspace heads on a new non-default integration branch. Preserve sibling PR ancestry; regenerate the coordinator-owned Bun lockfile for both manifests. Neither isolated browser evidence nor this checklist qualifies the production editor.

## Real controller/workspace boundary

Compose one scoped `WorkspaceLive` and application runtime, `makeEditorClient` and the public editor controller. Use real temporary Git checkouts, SQLite and native helper/ripgrep assets; count mutations when injecting response loss.

- Load/save/publish/restart through the controller: receipt-contiguous revision transitions, current live edits retained during delayed Save, original conflict baselines retained, and same-client competing publications veto close rather than adopting the latest revision.
- Two clients with equal-looking paths and text: Save A never rebases B; A acknowledgement cannot hide move/copy evidence from B. Two distinct checkouts with the same relative paths never share drafts or authority.
- Dirty source and destination before a replacement move: retain both original drafts when reconciliation collides, keep evidence unacknowledged, and offer explicit resolution. Capacity/publication failure retains the entire previous valid state without replay or truncation.
- Known closed checkout metadata survives close/reopen/restart, remaps known facts without probing an unavailable closed directory, and uses checkoutId view keys. Only open membership acquires watches/discovery. Replaced identity is never silently reapproved.
- Exercise lost Save/move responses, grouped interrupted Saves, unrelated module publications, observer concurrency, persistence contention and failed publication. Restart queries facts without repeating mutations. Keep raw counts and returned recovery/receipt evidence.

## Electron composition and transport

Task 04 owns `apps/desktop`; root manifests/lock/CI/exports and shared application changes remain coordinator-owned. A narrow main/preload adapter calls the same handlers. One main-process runtime acquires capabilities once; no feature/runtime implementation enters the renderer.

- Sandboxed/context-isolated renderer, no Node integration, production CSP and bundled worker policy. Reject foreign senders, subframes, unexpected documents/navigation/popups and unknown IPC shapes. Native directory choice approves roots; raw renderer paths do not.
- Preserve typed application error codes/targets across IPC serialization and reconstruct browser errors. Exercise InvalidInput, conflict, persistence, uncertainty and cancellation through the actual bridge; never lose identity merely because Error prototypes do not cross IPC.
- Native picker/drop/clipboard imports issue scoped single-use references via `WorkspaceNative.capture`; renderer paths grant no import authority. Creation, rename/move, copy, replacement consent and Trash retain the same public operation/journal path and dirty-buffer gates.
- Hide/close retains the mounted editor/models. Explicit Quit awaits Save/Discard/Cancel and recovery acknowledgement; failed/cancelled Quit keeps the window usable. Watch/model/native/IPC resources dispose on real teardown.

## Actual built application

Map the twelve examples in `docs/source-snapshot/escode/docs/specifications/file-editor-tabs.md` to focused desktop checks. Chat-specific switching belongs to later composition; do not add a placeholder chat panel. Include normal/staged/unstaged/conflict buffer sharing, preview/Keep Open, ordering/overflow/MRU, safe single/bulk close, reopen, current-source restoration, unavailable identities, exact operation outcomes and keyboard focus after real typing.

Build/package through Nx with a fresh user-data directory. Start the unsigned macOS app under `PATH=/usr/bin:/bin` without any provider. Verify executable native helper and qualified standalone rg outside asar, Monaco's five workers/fonts, actual read/save/lookup/Git/native operations and restart recovery. No reliance on a compiler, shell-installed Node or Codex executable path at runtime.

Inspect actual normal and constrained screenshots, long names/many tabs, zoom and keyboard-only dialogs/menus. Keep console/worker failures visible. Record renderer graph inputs and package asset evidence at the exact head. Signing, Finder Put Back, VoiceOver, human visual acceptance and physical power loss stay explicitly unrun unless directly exercised; they do not become passing gates by inheritance from escode.
