# Private ownership extraction qualification

Issue [#87](https://github.com/ejjsharpe/moonbase/issues/87) starts from integrated main `3f15bcaf21dae36ec6f84c1a6a74c6a55e09e343`, including local Pi/provider support. Implementation and guard revision: `6e2e755e8c3aa56d9cf68f498396d438cc1bea6a`; the subsequent evidence-only update changes no runtime or test source.

Checks ran on 2026-11-03, macOS arm64, Bun 1.4.4 and Node 26.13.0. Frozen installation installed 564 pinned packages without dependency or lockfile changes. Package and integration commands ran serially; root tests retain package-local concurrency and existing deadlines. Logs are in the worktree's ignored `test-results/issue-87/`.

The focused baseline at `3f15bca` passed Pi typecheck, lint and all 97 package tests. After source extraction, the same 97 tests passed before reorganization. A syntax-tree comparison against that baseline confirmed all 34 original top-level test cases/parameterized groups, fixture logic, 13 unchanged command methods and Request/Store/Metadata declarations were retained. No duplicate behavioral tests were added for file movement.

| Final command | Result |
| --- | --- |
| `bun run --cwd packages/pi-runtime typecheck` | Pass |
| `bun run --cwd packages/pi-runtime lint` | Pass |
| `bun run --cwd packages/pi-runtime test` | 97/97, zero failed/cancelled/skipped |
| `bun run test:chat-integration` | 7/7, zero failed/cancelled/skipped |
| `bun run check:foundation` | Pass: source ownership, public exports/cycles, private-chain negative fixtures, unchanged saved/wire bytes and actual browser graphs |
| `NX_DAEMON=false NX_SKIP_NX_CACHE=true bun run typecheck --output-style=static` | All 8 tasks passed, cache disabled |
| `bun run lint` | Pass |
| `NX_DAEMON=false NX_SKIP_NX_CACHE=true bun run test --output-style=static` | All 8 tasks plus root script test passed: 668/668, zero failed/cancelled/skipped, cache disabled |
| `bun run format:check` | Pass |
| `git diff --check` | Pass |

Root test counts: config 2, contracts 61, SSH 61, application 277, Effect helpers 2, Pi 97, workspace 124, desktop 43 and root script 1. Earlier default root commands also passed, with 7/8 typecheck and 4/8 test tasks cached; the uncached runs above supply the final source evidence.

A fresh independent review of `3f15bca..6e2e755` returned **Ship, no actionable findings**. It separately checked callers, document definitions, command/Stop/watch behavior, test/fixture preservation, retained adapters, acquisition/cleanup registration order and the source/bundle guards.

Controlled checks cover temporary SQLite, faux providers/tools, HTTP/forwarding, child host crash/reopen and compiled remote/local entry execution under Electron 45.1.0's Node 24.22.1 runtime. The remote check audits resolved bundle inputs and permits only transport/protocol/validation Pi leaves. TypeScript/Nx/CI discovery already includes the new private source and `test/*.test.ts` suites; exports and process-root exceptions are unchanged.

No desktop build/package or native foreground UI run was performed for this extraction. Real providers/SSH, manual interaction/accessibility, signing/notarization, Intel execution and physical durability remain unqualified. No real provider quota, legacy-state import/deletion, deployment or merge was performed.
