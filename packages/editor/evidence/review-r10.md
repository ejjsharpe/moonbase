# R10 — retire only an authoritatively rejected recovery publication

This is the owning editor response to the paired R9/module449 + fan-in R2 review. Starting editor head: `449496961c29c90c7a2e3c44d0618f08ef504947`. PR #4 remains DRAFT against #7 `8557fdd0d7a71f93a6584c77430e6fde57668580`. Only `packages/editor/**` changes; the separate task04 checkpoint `f33ed9004643a530aed7f04408751d933f3e9b52` is unchanged and unfinished.

## P1 — before-commit publication failure plus an already-started Save

Causal red was established before changing the controller through public `createEditor`, shared `makeEditorClient`/handlers and the concrete memory service. Hold B before service admission, commit A's Save, fail A's metadata publication before commit, then release B and edit both files. The old controller cannot resolve its now-stale original publication; two public variants (watch on/off) fail. Committed-response-loss controls pass. The actual Chromium/Monaco reproduction also fails before the fix: after Resolve, the pending-publication control remains and newer text cannot be checkpointed. Logs: `/tmp/moonbase-r10-red.log`, `/tmp/moonbase-r10-ui-red.log`.

The fix is limited to resolution of the existing immutable pending publication. An exact query failure, null response, Persistence or Unavailable does not establish non-admission. The controller only retires the old request if retrying its **identical original input** returns typed CAS `Conflict`: the reviewed #7 adapter contract returns a matching committed request's original receipt before checking current CAS. A Conflict from the status query does not qualify. Committed original receipts still confirm normally.

Retirement keeps all Save requests/results, live text and baselines. After the existing publication tail settles, the existing facts pipeline considers all retained contiguous transitions and publishes a fresh current capture. It never adopts a loaded latest revision/equal state, resends a Save, changes a Save ID or creates another runtime/store/global queue. An unrelated same-client CAS gap remains blocked.

A rejected final Close/Reload callback is never run. Preservation releases with the draft retained and resolution returns false for that original destructive action. Fresh metadata publication cannot apply old Discard/Reload consent; the user must explicitly choose again. Exact receipts still commit successful destructive actions once, and uncertainty retains the lock until receipt or authoritative rejection.

Ten new public cases cover:

- Before-commit failure and committed response loss with B already started, each with watchers on/off. Lookup/delivery outages retain the original identity; repeated publication inputs are identical, only two Save commands/effects occur, newer drafts and captured baselines restore, and Cancel/Discard Quit work after resolution.
- A competing same-client publication after failure: old request is definitively rejected, but the unbridgeable revision gap still vetoes recovery/Discard/Quit without adopting or overwriting its sidebar metadata.
- Rejected final Close and Reload after a known foreign move: drafts survive in live/backend/restarted state, old destructive callbacks never run, and a new explicit choice is required. No Save replay occurs.
- Status-query Conflict alone retains the pending request.
- A's committed receipt clears only A's captured Save identity; B's later uncertain publication retains B until its own exact resolution.
- Disposal during uncertainty prevents delayed B admission and later publication, and releases watchers.

The original R4 competing-CAS test expected the rejected Close identity to remain pending forever. Full checks caught this obsolete expectation. It now requires authoritative retirement while strengthening the underlying safety assertions: retained draft, no old Discard, fresh Cancel choice, continued competing-CAS veto, unchanged backend metadata/write count and no receipt for the rejected original. The other R4 committed/uncommitted controls are unchanged.

## P2 — stable browser assertions

The R9 journey no longer waits for the transient last revision-gap alert. It asserts both immutable pending Save inputs, waits for B's command to settle, explicitly exercises a competing flush that may replace the error, and checks the same identities/Retry Save controls, eventual reconciliation and actual typing. No timer timing or particular error-string ordering determines success.

The new `demo/save-race` fixture is a controlled two-file memory composition behind the same shared command interface. Its browser journey holds B, fails A's publication before commit, types newer A/B, resolves, checks two original Save IDs/effects, restarts a fresh controller, checks both texts/baselines, actually types again and performs a later explicit Save. [Inspected capture](publication-rejoined.png): 1600×1000, A remains dirty while B shows the later typed/saved text. The existing two-instance [receipt capture](save-receipts.png) was also inspected. Neither image qualifies native or real-workspace behavior.

## Validation and remaining gates

Passed on the final source/test tree:

- `bun install --frozen-lockfile` — no lock changes.
- `bun run check:foundation` —40 frozen source hashes/UI/browser contracts.
- `NX_DAEMON=false bunx nx run-many -t typecheck lint test --skip-nx-cache --outputStyle=static` —all six tasks;102 editor +14 application tests, no skips/failures. Lint remains TypeScript diagnostics.
- Renderer import check —1,569 inputs, no privileged modules/feature runtime.
- Vite+ build —StyleX/font/five Monaco workers; existing chunk-size advisory only.
- Focused R9/R10 Chromium journeys repeated three times each —6/6.
- Full Chromium suite —26/26, including all prior supplied scenarios.
- `git diff --check`.

Raw final logs: `/tmp/moonbase-r10-cases.log`, `/tmp/moonbase-r10-nx.log`, `/tmp/moonbase-r10-build.log`, `/tmp/moonbase-r10-ui-repeat.log`, `/tmp/moonbase-r10-ui.log`. Test traces/results remain ignored; inspected screenshots are committed.

PENDING: fresh paired independent R10/fan-in R3, coordinator's real WorkspaceLive/native/SQLite contention regressions and hosted CI. No root/workspace/application/app source or contract changes, sibling imports, dependency additions, delegation, watches/polls, GitHub merges or history rewrites. Task04 Electron/IPC/package/lifecycle/native actions, signing, Finder Put Back, VoiceOver, physical durability and human acceptance remain unqualified. The original lost/reordered Save fix remains retained; this followup does not claim production or task04 acceptance.
