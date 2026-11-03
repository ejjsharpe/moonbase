# Headless application architecture

This document records the delivered ownership and enforcement for [epic #63](https://github.com/ejjsharpe/moonbase/issues/63), followed by its historical baseline and ticket evidence. Effect remains the dependency, concurrency and resource-lifetime system; ordinary TypeScript owns buffers and synchronous state. The migration preserves storage and wire formats and introduces no transport, language binding, provider execution change or UI redesign. The [delivery ledger](https://github.com/ejjsharpe/moonbase/issues/63#issuecomment-6585556403) records the exact integrated revisions, fresh review and source/controlled/build/native/package outcomes; historical results below do not qualify later revisions. Historical command paths retain the package name used at that revision; current project editor presentation lives in `packages/workbench`, while desktop owns main navigation and Chat presentation.

## Historical baseline and evidence

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

## Enforced dependencies

| Owner | Responsibility | Permitted dependencies |
| --- | --- | --- |
| `@moonbase/contracts` | DTOs, command/client interfaces, strict schemas, public errors, Effect service ports | Portable Effect and its own definitions |
| `@moonbase/effect` | Existing safe failure normalization and observable release helper, used by four modules | Contracts and portable Effect |
| `@moonbase/application` | Headless chat/editor workflows, controllers, dispatch, runtime-bound invocation/clients, composition and coordinated lifecycle | Contracts, focused Effect helpers, portable Effect; injected capabilities |
| `@moonbase/workbench` | Project-scoped file sidebar, buffers and React/Monaco editor rendering a supplied editor controller and exact checkout | Public application/editor and workspace contracts APIs, UI and presentation dependencies |
| Workspace/Pi/SSH reusable services | Files/Git/SQLite, Pi execution, authenticated connectivity and transports | Contracts, Effect/helpers and platform dependencies; Pi may consume only the named SSH host-health leaf |
| Desktop | Main navigation, project layout, Chat presentation, privileged root, IPC/preload/native authority, storage, windows, lifecycle handoff and packaging | Public contracts/application, infrastructure and presentation exports |

Contracts never imports application, platform or presentation implementation. Application never imports Node, Electron, React/Monaco or an infrastructure implementation. A reusable service never imports application, even through a type-only import or a helper barrel. Cross-package imports use package public exports, including type-only and dynamic imports. Internal DTO/schema type cycles are allowed because clients use erased schema references; runtime file cycles and cross-package cycles including type-only edges are forbidden.

Workspace keeps its public service/configuration identities and filesystem asset export. Internally, `workspace.ts` composes exact authority, admission/overlap leases, filesystem mutations and ordered root disposal. `recovery.ts` owns volatile/journal evidence, immutable replay, publication transactions and acknowledgment rules through the acquired Store and focused authority/predicates. `native-references.ts` owns unclaimed capture/expiry and admitted descriptor claim/release; `discovery.ts` owns read-only listing/Git/lookup; `observations.ts` owns scoped watcher/debounce resources and failed-release retries. These owners neither receive the workspace parent nor close its shared Store/directories/helpers. See the [private source/test map](../packages/workspace/README.md#private-ownership-and-tests). Storage, contracts, application and desktop lifecycle remain unchanged.

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

SSH owns the shared authenticated health implementation because it already verifies host identity. Pi server/remote import only `@moonbase/ssh/host-health`, never SSH's main service. This leaf uses contracts, shared Effect helpers and `node:crypto`; it cannot reach SSH process code, Pi/workspace implementation or application. The former application host-health alias was removed after its callers moved; portable application exports contain no privileged authentication path. No duplicate authentication code or service tags is permitted.

Browser DTO/client entries are distinct from privileged Effect ports. `ConnectionService.endpoint` returns origin/token data only to a privileged consumer, without connecting or changing authority. Serializable inputs/results, snapshots and public error DTOs are suitable data for a future boundary. Callback functions, subscriptions, cancellation/observation handles, Context tags and runtime objects are runtime-only. Shape validation never grants native, endpoint or host authority.

## Named process roots

Only `packages/pi-runtime/src/host.ts`, `packages/pi-runtime/examples/remote.ts`, `packages/workspace/examples/local.ts` and `packages/ssh/examples/connect.ts` are infrastructure-package composition roots. They may bind public application runtime clients, dispatch and invocation helpers to a supplied process runtime. This is a file-level exception, never permission for an entire package. Service exports such as Pi `.`, `remote` and `server` are reusable infrastructure and must remain independent of application. The graph checker traverses their imports and rejects reaching a process-root file, so a host barrel cannot conceal an application back edge. Tests/fixtures may compose public APIs without becoming reusable service exports.

## Historical baseline inventory and handoffs

| Area | Existing implementation, resources and consumers | Handoff |
| --- | --- | --- |
| Contracts/runtime | Application has four client entries, five schema entries/shared schema, services, handlers, runtime clients, effect invocation/failure and privileged host-health. `application/test` verifies commands, schemas, cancellation and held/failing observation finalizers. | #65 moves definitions/schema tests; #66 moves executable runtime code and its tests. Preserve single tags/error brand, Promise errors and awaitable close. |
| Infrastructure | Workspace `index/workspace/store/recovery/validation/schema/filesystem/lookup`; Pi `index/remote/server/protocol/validation/private-schema`; SSH `index/configuration/process` import old application definitions/helpers. Examples bind supplied runtimes. | The migration recorded exact importer/specifier debt before extraction; #65 removed infrastructure edges, including type-only paths. The final checker has no migration allowlist. |
| Chat | `chat/src/{controller,saved,index}.ts`; model/facade scopes, synchronous drafts/storage, strict v1 saved envelope, immutable pending Create/Send/Stop. Tests include controller/model fixtures and actual HTTP/SQLite/process protocol. Consumers: desktop renderer/view, `tests/chat`, config foundation checks and docs. | #67 relocates sole implementation/tests and imports; #72 removes package/shims after caller audit. No acquisition/start/reconnect replay or invented Stop. |
| Editor state | `editor.ts`, `references.ts`, `workflows.ts`, `record.ts`; buffers, tabs, recovery/publication, exact prompts, lookup/mutation sessions and scoped IO. `memory.ts` is a concrete demo/test service capability. | #68 owns extraction/tests/demos and public exports; move headless calculations as needed, keep UI out. Decide memory ownership for existing consumers only. |
| Editor presentation | `workbench`, Monaco view, file tree/lookup, mutation/popup views, styles and workers; demos use public state/model composition. Tests include source model/recovery/save behavior, renderer audit and Playwright UI. | #68 keeps supplied-controller rendering, prompt dismissal, workers/fonts and view-only cleanup. |
| Renderer composition | Desktop `renderer/main.tsx` creates one empty document ManagedRuntime, aggregate scope and editor/chat instance scopes. Binding uses already-acquired models. `RendererCleanup/releaseInstance` retain removed-panel cleanup, namespace leases and visible errors; chat is detached on Hide. | #69 relocates concrete composition/cleanup and adds an atomic application admission fence; #71 qualifies it before #70 switches Electron. No per-feature runtime. |
| Desktop lifecycle | Renderer synchronous beforeunload checks `recoveryReady`/chat preservation. Quit checks chat, waits editor Save/Discard/Cancel, preserves latest chat, then main requests disposal. Main close hides; reload/document loss releases document IPC scopes, without Stop. | #69/#70 preserve veto/live state and completed saves/discards, fence every public admission before consent, explicitly handle duplicate Quit/open races and late cleanup. |
| Privileged boundary | Main creates workspace or workspace+SSH+remote services once. `EditorSession`/`ChatIpcSession`, wire/preload and config validate exact trusted frame/document, approved roots, opaque native references, bounded input/capacity and host/store/actor. | #70 retains IPC names/authority/native policy; no renderer credentials, new authority from DTOs or duplicate domain rules. |
| Cross-module fixtures | `tests/editor-workspace`, `tests/chat` and Pi faux host/process fixtures exercise public boundaries; editor demos include save/recovery race clients. Native/package projects use fresh stores and owned processes. | Feature owners update imports, not expected saved/protocol values. Orchestrator owns root manifest/lock/Nx/shared fixtures and serial native slot. |

In-process TypeScript consumers directly use supplied application controllers, synchronous snapshots and lifecycle. The [non-Electron public consumer](../packages/application/docs/HEADLESS-CONSUMER.md) executes editor-only, chat-only and combined compositions with injected capabilities. A future process/language consumer needs a concrete adapter for its actual transport, cancellation and lifetime model, plus separate qualification. These seams do not establish another-language interoperability.

## Final enforcement

`bun run check:foundation` runs source parsing, negative fixtures, unchanged-data compatibility assertions and real esbuild browser graphs. Source parsing reuses the Babel parser already installed by pinned StyleX tools; it handles ordinary imports/exports, erased type-only/import-type dependencies and literal dynamic imports. All source/test/demo/example modules are inventoried; production ownership and reusable-export reachability are enforced separately from test composition. Browser builds inspect the actual transitive metafile and reject UI/platform/provider/native implementation dependencies. DTO/client bundles must emit no Effect runtime imports; schema/service/headless graphs may include portable Effect. Computed platform imports are not a new portable capability: browser bundling remains required.

The [shared workbench refactor evidence](../packages/workbench/docs/VALIDATION.md) records final browser/desktop qualification separately from the historical results below. The source checker has no migration exceptions or legacy-allowlist mechanism. Application exposes only its factory, chat/editor features, runtime helpers and the concrete testing capability. Contracts owns every DTO/schema/service definition; workbench exports only its project editor, props/handle and worker configuration. Main navigation, Chat and startup failure presentation belong to desktop. The obsolete chat package and application/editor forwarding files are removed. Project editor presentation is consolidated in `packages/workbench`; the former editor package has no forwarding exports. Missing or non-public package exports fail the check even in tests, erased imports and named process roots.

Negative fixtures prove rejection of Node, UI type-only imports, dynamic Electron, import-type infrastructure, non-public/deep/removed package paths, runtime cycles, cross-package type cycles, workbench-to-infrastructure/desktop/privileged-port imports and reusable service exports reaching a permitted host root. The named SSH authentication leaf cannot reach process/service implementations. Foundation checks bundle the public features/runtime entries, audit the direct consumer's actual browser graph and execute its emitted JavaScript. Contracts DTO/client bundles emit no Effect runtime code; schema/service entry points may load portable Effect.

The configuration test's Nx inputs include all repository module/test/example source, package exports, boundary scripts and unchanged baseline fixtures, so cached checks cannot conceal a changed transitive edge.

The root source test command runs package suites serially. Simultaneous native/process fixtures delayed the unchanged workspace watch test beyond its two-second deadline, while the default workspace suite alone passed all 114 tests. Package-local concurrency, assertions and deadlines remain unchanged; qualification uses the actual root command with this resource scheduling.

## Fixed compatibility evidence

`docs/fixtures/headless-baseline/*.txt` contains literal compact JSON bytes captured before extraction from the baseline public APIs: chat restore+preserve with an uncertain original Send and newer draft, empty editor recovery, whitespace-preserving Send and exact Stop with `taskId: null`. `scripts/check-compatibility.mjs` reopens/preserves chat through its public factory with capabilities that throw if invoked, and verifies decoded data serializes to the same bytes. Keep these files unchanged; move only consumer imports. Rejected saved-data and full recovery behavior remain covered by the existing feature/integration suites, not this small smoke check.

| Fixture | SHA256 |
| --- | --- |
| `chat-v1.txt` | `f38bdeec3aa07541b8792ad729eb355734b64744e5127cf3e86c101f87961277` |
| `recovery-v1.txt` | `20b7db711b18ada502b19c49a2674d570be2fc662f8e106f184fe7d7ddc6894f` |
| `send-v1.txt` | `f6a5201d904478d1e2cf46e34882098d7af6ac2417aaf16473edfe5e88644672` |
| `stop-v1.txt` | `3afc970241a178621a3c48a56e427f5b7e08c77502544e6c89b2fb4bd44235ad` |
| Existing `packages/workspace/test/fixtures/workspace-53a0996.tar.gz` | `4b9e54649f195a18e8d93502f86bf21ba12e070c10261aa47a61d6f6b8aa510b` |

The archived workspace source generates prior-producer SQLite records; its checksum remains fixed, and the harness rewires only extracted dependency imports to contracts/helpers. The existing unfamiliar-nested-data test verifies rejection without overwriting original rows. No saved data is imported, migrated, deleted, reset or projected-and-overwritten by this migration.

## Application and head ownership

`createMoonbaseApplication` owns one client runtime and an aggregate scope, with separately acquired/bound feature instances. Supply editor clients with distinct recovery identities and optional chat clients/context/synchronous storage. Editor-only and chat-only compositions acquire only their injected capabilities; optional chat initialization failure leaves combined editors usable and visibly distinguishable from unavailable or cleanup-blocked state. Required acquisition failure releases acquired resources. Main's privileged runtime and authority remain separate.

Application owns chat/editor state, lookup/mutation sessions, exact close prompts and lifecycle. Workbench owns the project file sidebar, buffers, React/Monaco models/listeners, workers, editor focus and rendering of a supplied editor controller and explicit checkout. Desktop owns main navigation, project layout, the separate Chat view and cross-panel routing, supplies native callbacks and retains platform lifecycle acknowledgments. Hide retains mounted Monaco undo/view state and detaches chat observation; view unmount releases presentation resources without disposing application state.

Quit preserves chat, runs exact Save/Discard/Cancel prompts, fences every public controller/workflow admission, preserves latest chat state and returns consent with that fence retained. Veto or failed preservation restores live admission without undoing completed saves/discards. Synchronous `canUnload()` gates reload; asynchronous `dispose()` joins actual cleanup and retains failures. Removed panels disappear promptly after preservation, while the application root retains pending/failing cleanup, namespace leases and visible status until teardown. Document loss offers no asynchronous durability guarantee. See [application lifecycle](../packages/application/docs/LIFECYCLE.md) and [desktop authority/lifecycle](../apps/desktop/docs/LIFECYCLE.md).

The [direct consumer](../packages/application/docs/HEADLESS-CONSUMER.md) documents the serializable data versus runtime-only callback/service/cancellation boundary. A future language/process adapter must retain endpoint credentials and native authority behind that boundary and qualify its own transport/runtime.

## Delivery order

#64 → #65 → #66 → (#67 and #68 in separate worktrees with agreed exports) → #69 → #71 → #70 → #72. Each ticket owns its affected callers/tests/docs. The orchestrator owns integrated commits, root metadata and final evidence. Keep PRs reviewable and unmerged. A fresh review agent audits final behavior/standards after implementation. Final acceptance records source, controlled, built/archive, packaged/native and real/manual evidence separately.

## Historical ticket 02 extraction handoff

Independent `@moonbase/contracts` now owns the canonical workspace/chat/connection/host client definitions, errors/common types, unchanged schemas and service tags. Focused `@moonbase/effect` owns exactly the three agreed normalization/release helpers. Shared HMAC/health verification is the named `@moonbase/ssh/host-health` leaf. Workspace/Pi/SSH reusable source exports consume these public APIs without an application import; only the named Pi host/process examples bind application runtime clients. Infrastructure manifests keep application as a development/composition dependency, while their reusable runtime dependencies are contracts/helpers (and Pi's explicit SSH health leaf).

The 54 ticket-02 boundary exceptions were retired, leaving eight chat ownership edges for #67 and the documented privileged application host-health compatibility reexport for #72. Old application clients/schemas/services remain aliases of the same definitions, decoder functions, error brand and Context tags. They do not duplicate implementations. Schema and health tests moved to their owning packages; the existing application invocation browser check remains application-owned. DTO/client/type-only bundles emit no Effect runtime code; schemas/services contain only contracts and portable Effect. The public headless fixture now records 271 actual browser bundle inputs. Baseline fixture bytes and archive hashes remain unchanged.

Runtime ticket #66 owns moving the unchanged application invocation/handlers/client files and their canonical public subpaths. Chat/editor tickets consume `@moonbase/contracts/{workspace,chat,connection,host,errors,common,services}` and schemas; application feature behavior has not moved in ticket 02. Domain protocol/schema documentation now lives in `packages/contracts/docs/`; application invocation documentation stays in application.

Ticket 02 validation used Node `v26.13.0` and explicit pinned Bun `1.4.4` on macOS arm64. Commands ran on this extraction tree; the delivery commit identifies the exact revision. Logs are `/private/tmp/moonbase-65-{source-test,watch-recheck,source-recheck,workspace-serial,editor-integration,chat-integration,typecheck,portable-tests,build,renderer}.log`.

| Command/evidence | Result |
| --- | --- |
| `bun install --frozen-lockfile` | Pass; no changes after workspace metadata update, no unrelated version changes |
| `bun run check:foundation` | Pass; 9 exact remaining migration edges, 271 public bundle inputs, fixed baseline bytes unchanged |
| `NX_DAEMON=false bun run typecheck` | Pass, all 9 tasks |
| `bun run lint`, `bun run format:check`, `git diff --check` | Pass, formatting covered 216 source/config files |
| `NX_DAEMON=false bun run test` | 9/10 tasks passed; default parallel workspace suite failed its external-watch timeout (113/114); this is not a fully green root test run |
| Isolated external-watch test | Pass, 1/1 |
| Workspace `node --experimental-strip-types --test --test-concurrency=1 test/*.test.ts` | Pass, 114/114; default parallel workspace rerun still timed out, so timing sensitivity remains explicit |
| Contracts/helper plus canonical-identity/portable-runtime public tests | Pass, 64/64 |
| `bun run test:editor-integration` | Pass, 16/16 |
| `bun run test:chat-integration` | Pass, 7/7, controlled providers/loopback only |
| `NX_DAEMON=false bun run build` | Pass, 5 tasks; desktop executed, 4 successful tasks cached |
| `bun run --cwd apps/desktop check:renderer` | Pass, 1860 actual inputs; workers/font retained, no privileged graph |

The build initially lacked ripgrep notice files after copying only its verified executable. Copying the complete baseline `prepare-ripgrep.mjs` output, including COPYING/LICENSE-MIT/UNLICENSE, fixed generated setup and the actual desktop build passed. No source workaround or notice omission was introduced. Native foreground/package execution and real/manual checks remain for final integration; the final default root source run must also report or resolve the timing-sensitive watch failure.

## Historical ticket 03 runtime handoff

Application now implements dispatch, runtime-bound clients and invocation in `src/runtime/{handlers,clients,effect-client}.ts`, exported as `@moonbase/application/runtime/{handlers,clients,effect-client}`. Existing callers, examples, process roots, fixtures and public-import smoke use these canonical paths. The old `handlers`, `runtime-client` and `effect-client` entries reexport the same functions until #72; identity assertions cover the aliases. Executable dispatch/invocation algorithms are unchanged. All service ports/data/errors come from contracts, and normalization/release remain the single implementations in `@moonbase/effect`. The application privileged host-health alias remains the previously recorded #72 exception.

The runtime API signatures and ownership are documented in [application invocation](../packages/application/docs/SCHEMAS.md). #67 owns `src/features/chat`, its tests and chat export; #68 owns `src/features/editor`, its tests and editor export. They may import the internal `../../runtime/effect-client.ts` implementation, preserving acquisition in the supplied runtime and binding of the already-acquired model. Neither ticket changes the shared runtime helpers. #69 owns composition/lifecycle; this step introduces no factory runtime, scheduler, serialization adapter or backend acquisition.

Named infrastructure process roots are restricted to the three canonical runtime subpaths. Reusable service exports remain unable to conceal application dependencies behind those roots. Source/browser audits account for the new implementation paths, including erased edges. The existing chat migration exception follows only its renamed runtime import and retains #67 ownership; no new allowed dependency was added. All four baseline JSON fixtures and the prior-producer workspace archive remain unchanged.

Validation used Node `v26.13.0` and pinned Bun `1.4.4` on macOS arm64 against this ticket's delivery tree. Logs are `/private/tmp/moonbase-66-{typecheck,lint,foundation,desktop-focused,editor-focused,chat-focused,graphs,renderer,editor-integration,chat-integration}.log`.

| Command/evidence | Result |
| --- | --- |
| `bun install --frozen-lockfile` | Pass, lockfile unchanged |
| `NX_DAEMON=false bun run typecheck` | Pass, all 9 tasks |
| `bun run --cwd packages/application test` | Pass, 38/38; canonical facades, pre-abort, isolated cancellation, held/failing finalizers, repeat close, safe errors, thrown/reentrant callbacks and three portable runtime bundles |
| Desktop `node --experimental-strip-types --test test/cleanup.test.ts test/ipc-scopes.test.ts` | Pass, 8/8 |
| Editor `node --experimental-strip-types --test test/model-lifecycle.test.ts` | Pass, 16/16 |
| Chat `node --experimental-strip-types --test test/controller.test.ts` | Pass, 63/63 |
| Root `node --experimental-strip-types --test --test-name-pattern='bundles\|schema entry\|configuration subpath' packages/contracts/test/*.test.ts packages/ssh/test/configuration.test.ts` | Pass, 13/13 selected graph checks |
| `bun run --cwd packages/editor check:renderer` | Pass, 1830 actual browser inputs, no privileged graph |
| `bun run test:editor-integration` | Pass, 16/16; native helper build and controlled local filesystem/SQLite |
| `bun run test:chat-integration` | Pass, 7/7; controlled providers/loopback fixtures |
| Foundation, root lint, formatting and `git diff --check` | Pass |

The controlled integration suites ran serially. Full default source tests and desktop build/package/native foreground suites were not repeated for this mechanical relocation; #72 must run final integrated checks, with the #65 workspace parallel-watch timing failure still explicit. No real SSH/provider, manual interaction, accessibility, signing or deployment qualification is claimed.

## Local chat extension (#91)

Desktop additionally acquires local Pi and optional remote/SSH layers in separate scopes of its existing main runtime, binding the exact acquired services through shared application handlers. Every IPC invocation/observation captures its backend ID and exact host/store/actor. Renderer selection does not choose where a late reply goes. A live document owns provider authentication flow/prompt authority; only native folder approval grants new local Create authority.

Contracts owns portable creation settings/local host variants and provider setup DTOs/ports. Pi runtime owns pinned provider/SDK authentication, injected encrypted persistence, per-conversation tool environments and privileged local activity inspection. Application owns explicit local readiness, setup presentation state, named-target controller lifecycle and the final fenced Quit hook. Workbench remains project editor/sidebar presentation without Chat. Desktop owns the existing Chat view and target/folder/model/setup controls. See [local runtime](../packages/pi-runtime/docs/LOCAL.md) and [application lifecycle](../packages/application/docs/LIFECYCLE.md).

The previous remote-only desktop bundle restriction is superseded for main only. Build/archive guards require the intended local runtime/OAuth graph and notices while excluding SDK, credentials, SQLite and native services from renderer/preload. Standalone host Node qualification and remote formats remain unchanged.
