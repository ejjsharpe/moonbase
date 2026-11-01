# Chat proof origin

All chat presentation/controller/IPC/composition code is first-party Moonbase code authored for task07. No escode/Pocket/T3/Codex/Microsoft application helper, source, asset or test was selected. The frozen `docs/source-snapshot/README.md` rules remain intact; source repository and tracker are untouched.

First-party Moonbase references:

- Shared public contracts and command-center architecture at integration `478ab94f1f434f27c4a8115e2e4a7de7ea1d84c1`; actual Pi `cbe9478` and SSH `1aec1a4` implementations are dependencies, not copied source.
- `tests/chat/README.md`, `host.mjs`, `integration.test.ts` at that base informed the separate-process fixture. `test/fixture.ts` adapts its public-API orchestration/cleanup pattern. The generated controlled executable reads the parent-owned `tests/chat/forward.mjs` unchanged. Neither fixture is compiled/shipped in the proof app. `test/host.mjs` independently composes the public SDK with a counted cooperative fixture tool; it has no native tools/provider network access.
- `apps/desktop` at `8f4a3e9daa6733b023cf84ac040943241c0bd712` informed the secure custom-scheme/trusted-frame IPC, sandboxed preload, preservation-gated Quit and build/unsigned packaging patterns. `scripts/notices.mjs` is reused from that first-party implementation with formatting only; the other proof-specific implementations are authored here. No editor/session/workspace implementation is imported or copied.
- Existing `packages/ui` shared StyleX tokens/controls/workbench recipes are consumed as normal dependencies. Their frozen provenance remains under the foundation snapshot. The proof adds only its own layout/styles using those tokens, with no source CSS except the shared reset.

Dependencies keep their pinned versions and normal package/release notices. The notice collector derives generated desktop notices from actual build inputs, Electron package notices and a hash-verified exact StyleX upstream release notice when its npm tarball lacks LICENSE. No manually copied license bundle, SDK source or native binary is tracked here. Generated host/SDK distribution qualification remains coordinator-owned and pending; this client graph excludes them.

The current native fixture reply-hold pattern follows the first-party `tests/chat/host.mjs` at integration `132d273` through public ChatClient/SDK APIs. It records bounded test-case inputs/receipts and does not add a production event store. `scripts/check-artifacts.mjs` uses the pinned electron-builder dependency's normal public archive API to compare actual packaged bytes/notices with the build. No dependency, copied notice bundle or helper binary was added.
