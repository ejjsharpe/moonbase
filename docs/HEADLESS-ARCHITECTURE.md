# Headless application migration

This document is the implementation handoff for [epic #63](https://github.com/ejjsharpe/moonbase/issues/63). It records the integrated baseline, ownership decisions and enforcement before implementation moves. This is a behavior-preserving migration. Effect remains the dependency, concurrency and resource-lifetime system; ordinary TypeScript owns buffers and synchronous state. There is no new transport, language binding, provider execution change or UI redesign.

## Baseline and evidence

The implementation base is `7b2e0c5d82ece37573544675d166d60fb0672f79` on `main`. Qualified prerequisite head `5fa6287c2fd80a1c97ef787d9c283396c5198e49` is an ancestor, and `git diff --exit-code 5fa6287c2fd80a1c97ef787d9c283396c5198e49 HEAD -- .` is empty at that base. This proves the integrated tree contains the prerequisite stack; historical CI is not substituted for the fresh checks below.

Fresh checks ran on macOS arm64 on 2026-11-02 with Node `v26.13.0` and Bun `1.4.4`, without dependency upgrades. This machine's default Bun was `1.3.14`, which rejected the version-two lockfile without changing it. The successful commands prepend `/private/tmp/escode-bun-1.4.4/bun-darwin-aarch64` to `PATH`. Nx commands use `NX_DAEMON=false`. Logs are in the ticket worktree's ignored `test-results/baseline/`.

| Command | Fresh result at baseline |
| --- | --- |
| `bun install --frozen-lockfile` | Pass, 564 packages; pinned lockfile unchanged |
| `bun run check:foundation` | Pass, existing DTO and headless browser audits |
| `bun run typecheck` | Pass, 7 tasks; sandbox socket denial fell back to in-process Nx plugins |
| `bun run lint` | Pass |
| `bun run test` | Pass, 8 tasks, no Nx cache hits |
| `bun run format:check` | Pass on a clean `git archive HEAD` snapshot, 189 files; concurrent new ticket files were separately formatted |
| `bun run build` | Pass, 5 tasks; desktop rerun executed, 4 already successful tasks cached |
| `bun run test:editor-integration` | Pass, 16 tests, zero skipped/failed |
| `bun run test:chat-integration` | Pass, 7 tests, zero skipped/failed |

The first build failed because fresh worktrees lack `dist/tools/ripgrep/rg`. The documented `node scripts/prepare-ripgrep.mjs` downloaded and verified ripgrep `15.2.0`; the subsequent build passed. This is a setup requirement, not an inherited source failure. Native helper/build and controlled integrations ran serially. Native foreground Electron, packaged execution, real SSH/providers, manual gestures/accessibility and physical durability were not qualified by this ticket; #70/#72 coordinate those checks against final artifacts.

## Target dependencies

| Owner | Responsibility | Permitted dependencies |
| --- | --- | --- |
| `@moonbase/contracts` | DTOs, command/client interfaces, strict schemas, public errors, Effect service ports | Portable Effect and its own definitions |
| `@moonbase/effect` | Existing safe failure normalization and observable release helper, used by four modules | Contracts and portable Effect |
| `@moonbase/application` | Headless chat/editor workflows, controllers, dispatch, runtime-bound invocation/clients, composition and coordinated lifecycle | Contracts, focused Effect helpers, portable Effect; injected capabilities |
| `@moonbase/editor` | React/Monaco views rendering supplied controllers | Public application/contracts APIs, UI and presentation dependencies |
| Workspace/Pi/SSH reusable services | Files/Git/SQLite, Pi execution, authenticated connectivity and transports | Contracts, Effect/helpers and platform dependencies; Pi may consume only the named SSH host-health leaf |
| Desktop | Main privileged root, IPC/preload/native authority, storage, windows, React/Monaco head and packaging | Public contracts/application, infrastructure and presentation exports |

Contracts never imports application, platform or presentation implementation. Application never imports Node, Electron, React/Monaco or an infrastructure implementation. A reusable service never imports application, even through a type-only import or a helper barrel. Cross-package imports use package public exports, including type-only and dynamic imports. Internal DTO/schema type cycles are allowed because clients use erased schema references; runtime file cycles and cross-package cycles including type-only edges are forbidden.

## Public exports and helper decisions

| Baseline export/implementation | Canonical owner/export | Ticket |
| --- | --- | --- |
| Application `client`, `chat-client`, `connection-client`, `host-client` | Contracts `workspace`, `chat`, `connection`, `host`; common error/options/observation types remain one identity | #65 |
| Application `chat-schema`, `workspace-schema`, `connection-schema`, `host-schema`, `error-schema`, private `schema.ts` | Corresponding contracts schema subpaths; shared `schema` export | #65 |
| Application `services.ts` tags/ports | Contracts `services`, preserving exact Context tag identity | #65 |
| Application `failure.ts`, `services.releaseResource`, `effect-client.normalizeApplicationError` | Focused `@moonbase/effect`: `safeApplicationFailure`, `releaseResource`, `normalizeApplicationError` | #65/#66 |
| Application `host-health.ts` HMAC, health validation and bounded response cleanup | `@moonbase/ssh/host-health`, a Node crypto leaf with no SSH process/service imports | #65 |
| `ChatHostEndpoint`, `VerifiedChatEndpoint` | Contracts privileged `services` definitions; never a renderer bridge export | #65 |
| Public `ChatHostHealth`/health reply data | Contracts `host` definitions/schema; no crypto or token exposure | #65 |
| Application `handlers`, `runtime-client`, `effect-client` | Public application runtime subpaths backed by `src/runtime/{handlers,clients,effect-client}` | #66 |
| Chat package `makeChatModel`, `makeChatController`, controller/state/storage/pending types | Application `chat`, backed by `src/features/chat` | #67 |
| Editor `state`, model/controller/types, reference helpers and headless workflows | Application `editor`, backed by `src/features/editor`; editor becomes presentation | #68 |
| Desktop `RendererCleanup`, `releaseInstance`, renderer feature scope/admission policy | Public application composition/lifecycle and `createMoonbaseApplication` | #69 |

There is no existing module that can own the portable shared helpers without an application-to-infrastructure or service-to-application back edge. The focused Effect helper package has four concrete consumers today: application, workspace, Pi and SSH. It contains only the existing safe normalization/release behavior, not invocation, scheduling, a second runtime or general utilities. `releaseResource` keeps cleanup failures observable as Effect defects after redaction. `normalizeApplicationError` keeps the existing safe default message and branded errors; no raw unknown diagnostics enter clients. Application invocation and observation stay application-owned.

SSH owns the shared authenticated health implementation because it already verifies host identity. Pi server/remote import only `@moonbase/ssh/host-health`, never SSH's main service. This leaf uses contracts, shared Effect helpers and `node:crypto`; it cannot reach SSH process code, Pi/workspace implementation or application. Temporary application host-health re-exports are privileged compatibility paths, excluded from all portable bundles and removed in #72. No duplicate authentication code or service tags is permitted.

Browser DTO/client entries are distinct from privileged Effect ports. `ConnectionService.endpoint` returns origin/token data only to a privileged consumer, without connecting or changing authority. Serializable inputs/results, snapshots and public error DTOs are suitable data for a future boundary. Callback functions, subscriptions, cancellation/observation handles, Context tags and runtime objects are runtime-only. Shape validation never grants native, endpoint or host authority.

## Named process roots

Only `packages/pi-runtime/src/host.ts`, `packages/pi-runtime/examples/remote.ts`, `packages/workspace/examples/local.ts` and `packages/ssh/examples/connect.ts` are infrastructure-package composition roots. They may bind public application runtime clients, dispatch and invocation helpers to a supplied process runtime. This is a file-level exception, never permission for an entire package. Service exports such as Pi `.`, `remote` and `server` are reusable infrastructure and must remain independent of application. The graph checker traverses their imports and rejects reaching a process-root file, so a host barrel cannot conceal an application back edge. Tests/fixtures may compose public APIs without becoming reusable service exports.

## Baseline inventory and handoffs

| Area | Existing implementation, resources and consumers | Handoff |
| --- | --- | --- |
| Contracts/runtime | Application has four client entries, five schema entries/shared schema, services, handlers, runtime clients, effect invocation/failure and privileged host-health. `application/test` verifies commands, schemas, cancellation and held/failing observation finalizers. | #65 moves definitions/schema tests; #66 moves executable runtime code and its tests. Preserve single tags/error brand, Promise errors and awaitable close. |
| Infrastructure | Workspace `index/workspace/store/recovery/validation/schema/filesystem/lookup`; Pi `index/remote/server/protocol/validation/private-schema`; SSH `index/configuration/process` import old application definitions/helpers. Examples bind supplied runtimes. | Exact importer/specifier debt is in `scripts/migration-boundaries.json`; #65 owns removal of each infrastructure edge, including type-only paths. |
| Chat | `chat/src/{controller,saved,index}.ts`; model/facade scopes, synchronous drafts/storage, strict v1 saved envelope, immutable pending Create/Send/Stop. Tests include controller/model fixtures and actual HTTP/SQLite/process protocol. Consumers: desktop renderer/view, `tests/chat`, config foundation checks and docs. | #67 relocates sole implementation/tests and imports; #72 removes package/shims after caller audit. No acquisition/start/reconnect replay or invented Stop. |
| Editor state | `editor.ts`, `references.ts`, `workflows.ts`, `record.ts`; buffers, tabs, recovery/publication, exact prompts, lookup/mutation sessions and scoped IO. `memory.ts` is a concrete demo/test service capability. | #68 owns extraction/tests/demos and public exports; move headless calculations as needed, keep UI out. Decide memory ownership for existing consumers only. |
| Editor presentation | `workbench`, Monaco view, file tree/lookup, mutation/popup views, styles and workers; demos use public state/model composition. Tests include source model/recovery/save behavior, renderer audit and Playwright UI. | #68 keeps supplied-controller rendering, prompt dismissal, workers/fonts and view-only cleanup. |
| Renderer composition | Desktop `renderer/main.tsx` creates one empty document ManagedRuntime, aggregate scope and editor/chat instance scopes. Binding uses already-acquired models. `RendererCleanup/releaseInstance` retain removed-panel cleanup, namespace leases and visible errors; chat is detached on Hide. | #69 relocates concrete composition/cleanup and adds an atomic application admission fence; #71 qualifies it before #70 switches Electron. No per-feature runtime. |
| Desktop lifecycle | Renderer synchronous beforeunload checks `recoveryReady`/chat preservation. Quit checks chat, waits editor Save/Discard/Cancel, preserves latest chat, then main requests disposal. Main close hides; reload/document loss releases document IPC scopes, without Stop. | #69/#70 preserve veto/live state and completed saves/discards, fence every public admission before consent, explicitly handle duplicate Quit/open races and late cleanup. |
| Privileged boundary | Main creates workspace or workspace+SSH+remote services once. `EditorSession`/`ChatIpcSession`, wire/preload and config validate exact trusted frame/document, approved roots, opaque native references, bounded input/capacity and host/store/actor. | #70 retains IPC names/authority/native policy; no renderer credentials, new authority from DTOs or duplicate domain rules. |
| Cross-module fixtures | `tests/editor-workspace`, `tests/chat` and Pi faux host/process fixtures exercise public boundaries; editor demos include save/recovery race clients. Native/package projects use fresh stores and owned processes. | Feature owners update imports, not expected saved/protocol values. Orchestrator owns root manifest/lock/Nx/shared fixtures and serial native slot. |

In-process TypeScript consumers directly use supplied application controllers, synchronous snapshots and lifecycle. No generic TS adapter, mandatory serialization or per-feature runtime is added. #71 adds the smallest non-Electron public consumer with injected capabilities. A future process/language consumer needs a concrete adapter for its actual transport, cancellation and lifetime model, plus separate qualification. These seams do not establish another-language interoperability.

## Enforcement and temporary edges

`bun run check:foundation` runs source parsing, negative fixtures, unchanged-data compatibility assertions and real esbuild browser graphs. Source parsing reuses the Babel parser already installed by pinned StyleX tools; it handles ordinary imports/exports, erased type-only/import-type dependencies and literal dynamic imports. All source/test/demo/example modules are inventoried; production ownership and reusable-export reachability are enforced separately from test composition. Browser builds inspect the actual transitive metafile and reject UI/platform/provider/native implementation dependencies. DTO/client bundles must emit no Effect runtime imports; schema/service/headless graphs may include portable Effect. Computed platform imports are not a new portable capability: browser bundling remains required.

`scripts/migration-boundaries.json` contains 62 exact current importer/specifier exceptions, each assigned a removal ticket: 54 definition/helper/root edges to #65, 8 chat ownership edges to #67. The check rejects new edges and stale exceptions. #65 may replace the old privileged application health implementation edge with only its documented temporary re-export edge; #72 removes it and all remaining aliases. Do not regenerate this file to accept new violations. #66, #67 and #68 coordinate application manifest/export edits with the orchestrator, and update smoke imports as canonical exports appear. #72 removes old imports, aliases and package references only after all callers move.

Negative fixtures prove rejection of Node, UI type-only imports, dynamic Electron, import-type infrastructure, non-public/deep cross-package paths, runtime cycles, cross-package type cycles and reusable service exports reaching a permitted host root. The public headless smoke fixture bundles both models/controllers and application runtime clients without React, Monaco, Electron, Node, provider or infrastructure implementation. At this stage it has 267 actual inputs. #65/#66 expand canonical contracts/runtime coverage; #71 qualifies the final factory consumer.

## Fixed compatibility evidence

`docs/fixtures/headless-baseline/*.txt` contains literal compact JSON bytes captured before extraction from the baseline public APIs: chat restore+preserve with an uncertain original Send and newer draft, empty editor recovery, whitespace-preserving Send and exact Stop with `taskId: null`. `scripts/check-compatibility.mjs` reopens/preserves chat through its public factory with capabilities that throw if invoked, and verifies decoded data serializes to the same bytes. Keep these files unchanged; move only consumer imports. Rejected saved-data and full recovery behavior remain covered by the existing feature/integration suites, not this small smoke check.

| Fixture | SHA256 |
| --- | --- |
| `chat-v1.txt` | `f38bdeec3aa07541b8792ad729eb355734b64744e5127cf3e86c101f87961277` |
| `recovery-v1.txt` | `20b7db711b18ada502b19c49a2674d570be2fc662f8e106f184fe7d7ddc6894f` |
| `send-v1.txt` | `f6a5201d904478d1e2cf46e34882098d7af6ac2417aaf16473edfe5e88644672` |
| `stop-v1.txt` | `3afc970241a178621a3c48a56e427f5b7e08c77502544e6c89b2fb4bd44235ad` |
| Existing `packages/workspace/test/fixtures/workspace-53a0996.tar.gz` | `4b9e54649f195a18e8d93502f86bf21ba12e070c10261aa47a61d6f6b8aa510b` |

The archived workspace fixture retains prior-producer SQLite records and the existing unfamiliar-nested-data test verifies rejection without overwriting original rows. No saved data is imported, migrated, deleted, reset or projected-and-overwritten by this migration.

## Delivery order

#64 → #65 → #66 → (#67 and #68 in separate worktrees with agreed exports) → #69 → #71 → #70 → #72. Each ticket owns its affected callers/tests/docs. The orchestrator owns integrated commits, root metadata and final evidence. Keep PRs reviewable and unmerged. A fresh review agent audits final behavior/standards after implementation. Final acceptance records source, controlled, built/archive, packaged/native and real/manual evidence separately.
