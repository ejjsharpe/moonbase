# App Astra R1 response and artifact qualification

Both P2 findings were fixed in the editor owner follow-up [PR16](https://github.com/ejjsharpe/moonbase/pull/16), exact `473e0fe03f6c5fc34fd8282fab4875c20f143ac2`, based on PR13 `71f272d354359f8d5e1cff7a9f57159325eeabc5`. PR14 normally merged that head (`d6edd8c7d4ce9e7327593df420aaec19d9b9bf48`) and is retargeted to `fix/editor-filename-maps-and-menu`. Original editor branch remains `3c7f0c3daf337753bbca10df495264af28b280eb`; original app8f remains in ancestry. No app-side workaround, dependency/API change or root authoring was added. The app's module tree equals exact473.

## Causal reproduction

Before rebuilding adoption, both supplied packaged repros and both new built-Electron filename/menu regressions failed against the preserved app8f artifact. [Red artifact mapping](red-artifact.json): asar `7a24f8ea0d9386307318ab8bf12b5cfee5eb855443ce16fd56e5312c785e6d6b`, inherited editor module71f. The owning [module response](../../../../packages/editor/evidence/filename-maps-menu/review-app-r1.md) contains the controller/real-workspace red, safe prototype cleanup, implementation, scoped browser controls and read-only backend inspection.

After rebuilding the exact adoption:

- All four valid names (`__proto__`, `constructor`, `toString`, `hasOwnProperty`) open, move the caret, edit and explicitly Save through the actual bridge/native workspace. Object/function prototype descriptors remain unchanged. Staged originals remain readonly. All own JSON mode/caret keys, working baselines and dirty text survive a real fixture-process restart, alongside an unrelated dirty sibling; another Save after restart succeeds. [Actual packaged state](packaged-filename-maps.json) and [capture](packaged-filename-maps.png).
- The actual menu at 1280×850/100%, 760×650/100% and 760×650/140% supports Home/End, Enter on Keep Open/Reopen, and a real Close click. First/last focused items fit the viewport and the popup scrolls internally. [Actual package geometry](packaged-menu-geometry.json), [first at native zoom](packaged-menu-first-zoom.png), [last after scrolling](packaged-menu-last-zoom.png).
- Both original supplied packaged regressions now pass, including the original direct Close click. [Results](original-packaged-repros-green.json), [original filename probe](original-repro-green-prototype.png), [original menu probe](original-repro-green-menu.png).

## Test-harness corrections kept separate

A raw Playwright evaluated-object result dropped own `__proto__` fields while reconstructing the value in the test driver. This initially made the new recovery assertion appear to show missing persisted metadata. Instrumented live renderer clones retained both maps, and direct real IPC key-array probes retained own shallow and recovery-depth keys in main. Reading recovery as JSON text across the evaluation boundary preserves those fields and confirms actual persistence/restoration. No product bridge/backend/schema fix was made for this observation. The committed boundary regression checks actual own keys using primitive arrays; the shared new evidence helper parses JSON text in the driver. Temporary clone instrumentation was removed.

The new menu fixture also waits for its setup close to commit, a reopened tab to become selected, and Base UI's initial focus to settle before another gesture. The post-restart Save waits for the intended tab/editor to activate. These are explicit user-flow preconditions, not a positioning or command workaround. Prototype red tests remain isolated/restored; fixture processes/data are the only things killed/deleted.

## Final checks

| Check | Result |
| --- | --- |
| Frozen install / provenance / whitespace | Unchanged install, all40 hashes/contracts, diff clean |
| Nx diagnostics and public tests | All12 uncached tasks; desktop5 + application14 + editor106 + workspace91 =216 tests |
| Real integration | All15 controller→shared client→WorkspaceLive files/Git/SQLite/native cases |
| Module Chromium | All35 journeys, recorded in owning PR16 |
| Actual Electron | All25 journeys (22 prior + three new filename/boundary/menu cases) |
| Actual unsigned package | Extended smoke passes with system-only PATH, Electron45.1/Node24.22.1, files/SQLite/Git/rg/create/import/workers plus new filename/restart/menu cases |
| Original actual packaged regressions | Both pass unchanged |
| Renderer |1,585 actual Vite inputs; no privileged/feature runtime/provider/remote implementation; five workers/font |

New asar SHA256: **37ad94c692afbde6b2b9a6afabfda6272425e98470e5557419e1b83818ba2f8d**. [Full package resource record](../packaged-resources.json) includes executable helper/rg, upstream/package notices, assets, embedded runtime and zero worker errors. [Capture metadata/hashes](captures.json) records dataset, actual windows/viewport/zoom and PNG sizes. Images were opened for inspection. Generated assets remain ignored; evidence copies are committed explicitly.

Commands are unchanged in the [consumer README](../../README.md). Local logs: `/tmp/moonbase-app-r1-{own-red,own-green,desktop-full,nx,integration,package,packaged-green,original-repros-green}.log`. Raw original red and green traces/IO are preserved locally under `apps/desktop/evidence/test-results/`. Owned Electron/helper fixtures are stopped; a scoped process snapshot found none remaining. No PR watching/polling, merge, deployment or real provider/SSH/user clipboard/legacy state access.

Pending: fresh paired Astra R2 at exact PR16/PR14 heads and hosted checks. The original rapid Open→Find dismissal remains **unexplained**, with its old failure and later bounded passing probes preserved; this follow-up does not causally clear it. Same-origin srcdoc may access a parent's exposed bridge: absence of its own preload is not an isolated capability boundary. CSP blocks inline script/app-URL frame loads; no untrusted HTML renderer was added. Real OS gestures/Finder Put Back, signing/notarization/Intel, VoiceOver, performance, physical full-volume/power-loss and human product acceptance remain **PENDING**.
