# Pi runtime evidence

Task05 starts at `7bfc7764b8950f93ee8fd41cc8ca86914b434f86` (`chore/pi-runtime-base`), the checked chat contract plus three first-party research files. PR base is `chore/chat-contract`, exact `d38833db81c5d97a1aa60f25e0dc27dd670af60f`; dependencies #1 → #2 → #5 → #6 → #8 → #10. The inherited research carry is coordinator-authored. This module uses the authorized independent-work exception while editor technical fixes continue; no editor composition or SSH implementation is included.

Work stays in the same Moonbase-bound isolated worktree on `feat/pi-runtime`, private `ejjsharpe/moonbase`. Workspace checkpoint `38c6c551ff0ab1108077275d223a32967f32b9f6` is preserved. Pi WIP was safely committed/pushed at `cef64eee5f8fd9e0572e4c0dc380358485a650ee` before the separately requested SSH R2 repair, now cleared at `1aec1a438ba0d5592b0e6c3f0e1be835cf3c034b`; Pi resumed afterward. No unfinished source was discarded, shared worktree created, sub-agent spawned, user SSH state changed or PR watched/merged.

## Executed checks

Environment: macOS arm64, Node **26.13.0**, Bun **1.4.4**, TypeScript **7.0.2**, Effect **4.1.0**, pinned Durable/AI/Chord **1.4.0**. Published tarball integrity/API/asset checks are recorded in PROVENANCE.md. A first metadata-inspection command attempted AI's unexported `package.json` subpath and failed; read-only file inspection corrected that qualification command. No production import bypass was introduced.

```sh
bun install --no-save
bun run --cwd packages/pi-runtime typecheck
bun run --cwd packages/pi-runtime lint
bun run --cwd packages/pi-runtime build
bun run --cwd packages/pi-runtime test
bun run --cwd packages/application test
bun run check:foundation
git diff --check
```

**37 module tests pass together**, zero failures/skips, including actual queued withdrawal, pipelined-request bounds and private-key/public-metadata controls. **33 application tests pass uncached**. Typecheck/lint/build diagnostics, foundation40 hashes/browser contracts and diff checks pass. Build is `tsc --noEmit`, not a distributed application. Root frozen-install/Nx qualification follows the coordinator-only lockfile/Node26 CI registration from this committed manifest; final PR body records those exact registration commits/checks. Hosted CI and independent exact-head review remain pending until separately evidenced.

Core tests enter `makeChatClient`/shared handlers with `PiRuntimeLive`, actual temporary SQLite and public Pi providers/registries. HTTP tests use production `serveChat` and `RemoteChatLive`, with only the exact verified endpoint capability controlled. No private module helper or second execution store is used to create results.

## Persistence and execution

- Atomic create/configure/ownership metadata/request binding, concurrent/matching retries, changed/cross-operation IDs, saved listing and restart are observed with zero model calls for creation.
- Duplicate and lost Send acknowledgement resolves the original submission. Public Pi `submit` fault seams exercise failure before admission and after real admission but before binding. Restart/query does not submit reserved input; an explicit matching retry alone may admit it. Actor/target/model/cwd authority is retained; no old store is discovered/imported.
- An interrupted caller after persisted admission receives Cancelled while Pi completes once. Busy admission rejects, retaining its immutable reserved intent. Unsubscribe does not Stop work. Model failure survives restart as failed, with static diagnostics rather than raw provider text.
- Actual SQLite full (`PRAGMA max_page_count` on the real public database facade) fails visibly, closes the failed Session and preserves earlier committed chats for reopen. No admission/model call is fabricated. Queries on failed storage do not report healthy idle.
- Counted tools publish progress and survive view disposal. Ten actual tools expose at most eight live previews; failed completed tools are marked failed. Forty long escaped/Unicode answers page without a skipped/duplicated durable entry ID, with 32-entry/4096-byte/256-KiB bounds and authority-bound cursors. Invalid Unicode/input limits reject before admission.
- Exact Stop joins a cooperative task; null-task Stop cannot abort placed work, and a superseded task never follows handover/later input. A public Pi ordinary-followUp fixture creates a real queued submission; null-task Stop withdraws only it while the unrelated active input completes. Production Send always uses `whenBusy: reject`.
- Actual Pi coding-tool Bash runs in the fixed cwd, writes one counter, exits and is not rerun by an admitted matching Send after reopening. The real native PID is gone. This is one controlled native effect, not general exactly-once execution.
- Actual child hosts own SQLite exclusively before readiness: second-process startup fails, SIGKILL releases ownership, and later startup/shutdown/reopen succeeds with the port rebindable. Another child test crashes during a counted unsafe tool, then Pi resumes the same admitted input: tool effects1, model calls2, user entry1, retained receipt unchanged. Repeated real model-phase crashes reach Pi's restart limit and surface a parked failed view. Provider/task calls may repeat during Pi recovery; no application Send is invented.
- Watch limits, unsubscribe during pending Harness acquisition plus concurrent root disposal, and an arbitrary throwing unsubscribe cleanup are checked through the public client. Releases are observable, subscriptions are removed and the store can reopen.

## Protocol and client boundary

- Real loopback HTTP verifies immutable commands through shared handlers; reusable keys never enter command arguments, public snapshots/errors or observed response data. A server refuses a private key reused in public configuration. Raw provider/config errors are sanitized.
- Concurrent matching POSTs consume one grant once. Changed body proofs, unknown operations/shapes/actors, invalid/canonical nonces, malformed raw UTF-8/escaped Unicode and oversized raw bodies reject before mutation. Challenge cache capacity is128, expiry is tested with actual20-second time and server restart invalidates old grants. Pipelined HTTP has a bounded128 active window with no extra application read queued.
- Challenge/reply signatures bind exact domains, nonce, challenge, method/path, status/body digest. Wrong listener/proof/health, reflected request proofs, tampered bodies, altered nonce/challenge, oversized/non-JSON/malformed-UTF8 replies fail. Unknown private output fields are projected away. Input is not disclosed until challenge proof and expected health verify.
- Lost HTTP Send response/caller cancellation followed by a new connection generation resolves the persisted receipt without another model call. Both successful/error responses from stale generations are rejected. Disconnected lookup never connects or rebinds.
- Actual stalled response cancellation closes the reader/connection while the independent host remains usable. A delayed challenge plus stalled RPC proves one20-second overall deadline. Unknown throwing reader cleanup initially hid uncertainty; construction now assigns the RPC uncertainty before cleanup cause combination, using shared `releaseResource`. Public retry resolves the committed create exactly once and no private cleanup value leaks.
- The standalone CLI starts with real production provider factories/catalog/auth resolution and no provider request. The pinned Electron package resolved/downloaded its binary on the first client-boundary check; the executed binary reported the exact expected Electron/Node versions. Its controlled child preloader rejects non-loopback fetches. It rejects malformed private JSON without echoing contents/path. No real provider quota is spent.
- The compiled `./remote` consumer executes getHost/create/Send/getSend under actual **Electron45.1.0 run-as-node / Node24.22.1**, against an outside **Node26.13** production server/faux host. Its bundle has zero Pi/Chord/provider/SQLite implementation inputs/imports; no feature Electron dependency/import was added. A separate memory-only remote bundle audit has **255 inputs,491,070 bytes**, zero engine/provider/editor/workspace inputs and no `node:sqlite`. Host/index diagnostic bundles retain external normal dependencies and are not packaged host proofs.

The failing-tool-state regression was RED (completed instead of failed) before its projection fix. The throwing-reader cleanup regression was RED (Unavailable instead of Uncertain alongside cleanup failure) before the pre-combination domain error fix. Both pass. Passing mock/faux/loopback evidence is not promoted into real-provider or SSH qualification.

## Limits and pending gates

Real provider smoke/cost, provider OAuth refresh/network APIs, explicit real SSH host/agent/ProxyJump, actual remote persistence/network partition, packaged Electron/native UI/signing/accessibility/human acceptance, other platforms, Node22, and machine crash/power-loss durability are **UNRUN**. No provider credentials/quota or real SSH target was authorized for those checks. SIGKILL and SQLite full are controlled local failures, not power loss. Optional QuickJS/photon/image/codemode worker/WASM engines and distribution notice/assets wiring are unqualified. Source-mode production CLI and compiled remote boundary work independently of editor/React/Electron/Pi initialization on the client; full chat proof/fan-in remains a later task. Keep the PR DRAFT for fresh implementation review and any unresolved technical findings; human acceptance remains PENDING.
