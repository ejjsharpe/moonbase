# App Astra R1 owning editor follow-up

Base: `71f272d354359f8d5e1cff7a9f57159325eeabc5` (`fix/editor-native-import-dialog`, PR13). The preserved app branch is `8f4a3e9daa6733b023cf84ac040943241c0bd712`; original editor branch remains `3c7f0c3daf337753bbca10df495264af28b280eb`. This follow-up changes only `packages/editor/**`; manifest, public exports, application contracts, workspace implementation and shared UI are unchanged.

Both findings were reproduced before implementation against the actual original unsigned app. Its asar SHA256 was `7a24f8ea0d9386307318ab8bf12b5cfee5eb855443ce16fd56e5312c785e6d6b`; the inherited module source equals this follow-up's base. [Packaged filename red](packaged-red-prototype.png) and [packaged menu red](packaged-red-menu.png). First-party review repros were read before execution; fixtures use fresh temporary Git/user-data and destroy only their own processes/data.

## P2 filename maps

`positions['__proto__']` inherited `Object.prototype`; writing its mode position added a global property. The related fileViews assignment invoked the legacy setter and lost the filename entry. Merely initializing a null-prototype object would not cover JSON/structuredClone restoration.

Two internal functions now read only own properties and define enumerable own data properties. Controller activation, caret tracking, conflict/reset, close history/reopen, recovery registry and presentation reads use them. Existing Object.entries/fromEntries remaps already enumerate/define own keys and remain. The concrete memory adapter's Git baseline reads also use own keys, so missing `constructor`/`toString` baselines remain missing. No valid filename is banned, and path/checkout scope checks are unchanged. The real workspace validator/remapper was inspected read-only: filename maps use Object.entries/fromEntries; no concrete matching backend gap was found.

- [Public controller red](node-red.txt) shows the added Object.prototype caret property. The test captures/restores prototype/function descriptors in finally; Node's test-file process isolates this regression.
- The supplied real WorkspaceLive public probe also [failed before](public-real-red.txt). Its own-checkout execution now records [ownView=true, polluted=false](public-real-green.json), with real files/SQLite and scoped cleanup.
- New public tests cover `__proto__`, `constructor`, `toString`, `hasOwnProperty`: edit/Save, own JSON view keys, staged/original positions, retained dirty sibling, close/reopen, restart, own and foreign move reconciliation, four mutations without replay and unchanged prototype descriptors. Missing own Git baselines reject rather than inheriting functions.
- Chromium creates the four files through the public mutation interface, opens them through Files, moves the caret, actually types and Saves, queries the public client and checks prototype/page/console state. An initial attempted externalWrite of a nonexistent fixture file was discarded as an invalid fixture, not counted as causal red; the original packaged/controller reds remain the causal evidence.

## P2 menu bounds

The existing Base UI Popup now composes the shared `overlays.options` bounded scrolling recipe with `overlays.popup`. No shared UI edits, positioning framework or dependencies were added. Home/End scroll the actual focused items; clicking Close remains reachable.

The Chromium tests exercise Home/End and Enter on the first/last actions, then click Close, at 1600×1000, 760×650 and 543×441 CSS pixels (the latter matches the reviewed actual 760×650 window at native 140% zoom). All six captures were inspected; [dimensions and fixture](captures.json), [first at zoom-equivalent size](tab-menu-first-543.png), [last after scrolling](tab-menu-543.png). These green images are controlled module UI with the memory adapter, not a new packaged-app success claim.

## Validation

- Frozen install: unchanged. Foundation: all40 hashes/UI/browser contracts pass.
- All9 uncached Nx typecheck/lint/test tasks pass: editor106 + application14 + workspace91 =211 public/module tests. Lint is the repository's TypeScript diagnostics.
- All15 existing typed real editor→WorkspaceLive files/Git/SQLite/native integration cases pass.
- All35 Chromium module journeys pass (31 prior + four new); focused four passed separately.
- Renderer import graph:1,570 inputs, no privileged implementation/feature runtime; production Vite build/five workers/font pass. Existing large-chunk advisory remains.
- `git diff --check` passes. No new manifest/lock registration is needed.

Commands:

```sh
bun install --frozen-lockfile
bun run check:foundation
NX_DAEMON=false MOONBASE_TEST_RIPGREP="$PWD/dist/tools/ripgrep/rg" bunx nx run-many -t typecheck lint test --skip-nx-cache
MOONBASE_TEST_RIPGREP="$PWD/dist/tools/ripgrep/rg" bun run test:editor-integration
bun run --cwd packages/editor test:ui
bun run --cwd packages/editor check:renderer
bun run --cwd packages/editor build
```

Raw local logs are `/tmp/moonbase-filename-{node-red,public-real-red,public-real-green}.log` and `/tmp/moonbase-filename-menu-{packaged-red,nx,integration,ui-full,build}.log`. Original headless red traces remain in ignored `packages/editor/evidence/test-results/filename-menu-red`.

Pending: merge this exact committed module head into the preserved app branch, rerun actual Electron/packaged regressions and refresh its artifact record in PR14; fresh independent paired Astra review and hosted checks. The original rapid Open→Find dismissal remains unexplained and is not repaired or declared cleared by this follow-up. Real OS gestures, signing/Intel/VoiceOver/performance/physical durability and human acceptance remain PENDING. No provider, SSH host, user clipboard, legacy state or original escode access.
