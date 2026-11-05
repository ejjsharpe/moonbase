# Headless application architecture

This document describes enforced ownership, public exports, process roots and fixed compatibility fixtures for the headless application architecture. Effect remains the dependency, concurrency and resource-lifetime system; ordinary TypeScript owns buffers and synchronous state. Storage and wire formats are preserved; there is no additional transport or language binding. Project editor presentation lives in `packages/workbench`, while desktop owns main navigation and Chat presentation.

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

The headless editor's private owners live together in `packages/application/src/features/editor/`. `editor.ts` owns authoritative buffers/views, public commands, synchronous snapshots and mutation/reference fact ordering; `recovery-publications.ts` owns exact CAS attempts/receipts and debounce; `preservation.ts` owns captured Close/Reload/Quit prompts/barriers and history; `discovery.ts` owns checkout observations, selection-read cancellation and coalesced discovery. They consume named injected capabilities and per-attempt captures/current predicates, with confirmed results applied by the editor. The existing runtime/model scope and public `/editor` export remain the boundaries. `EditorController` explicitly declares the existing surface, while composition retains model-only admission and lifecycle methods. See the [editor seams and test map](../packages/application/docs/EDITOR.md).

Pi's `src/index.ts` retains public layer/configuration wiring; private `commands.ts`, `history.ts` and `resources.ts` separate command coordination, bounded projection and root acquisition. `documents.ts` owns the shared document families/authority checks and `runtime-types.ts` holds erased shared types. These stay in the same reusable infrastructure graph with no new exports or process-root exceptions. Fixed-settings and local layers share those owners; `host.ts`, `server.ts`, `remote.ts` and local provider/credential entries retain their existing roles. See [Pi ownership and finalizer order](../packages/pi-runtime/docs/OWNERSHIP.md).

Workspace keeps its public service/configuration identities and filesystem asset export. Internally, `workspace.ts` composes exact authority, admission/overlap leases, filesystem mutations and ordered root disposal. `recovery.ts` owns volatile/journal evidence, immutable replay, publication transactions and acknowledgment rules through the acquired Store and focused authority/predicates. `native-references.ts` owns unclaimed capture/expiry and admitted descriptor claim/release; `discovery.ts` owns read-only listing/Git/lookup; `observations.ts` owns scoped watcher/debounce resources and failed-release retries. These owners neither receive the workspace parent nor close its shared Store/directories/helpers. See the [private source/test map](../packages/workspace/README.md#private-ownership-and-tests). Storage, contracts, application and desktop lifecycle remain unchanged.

Desktop keeps its one privileged composition root in `apps/desktop/src/main.ts`, with private native consent, command IPC, chat backend wiring and document/window lifecycle owners under `src/main/`. Existing session/wire/preload authority remains desktop-private; no package/public export is added. The actual build/archive graph requires those owners, and browser/preload audits reject the privileged subtree. See [desktop ownership](../apps/desktop/docs/LIFECYCLE.md).

## Helper decisions

There is no existing module that can own the portable shared helpers without an application-to-infrastructure or service-to-application back edge. The focused Effect helper package has four concrete consumers today: application, workspace, Pi and SSH. It contains only the existing safe normalization/release behavior, not invocation, scheduling, a second runtime or general utilities. `releaseResource` keeps cleanup failures observable as Effect defects after redaction. `normalizeApplicationError` keeps the existing safe default message and branded errors; no raw unknown diagnostics enter clients. Application invocation and observation stay application-owned.

SSH owns the shared authenticated health implementation because it already verifies host identity. Pi server/remote import only `@moonbase/ssh/host-health`, never SSH's main service. This leaf uses contracts, shared Effect helpers and `node:crypto`; it cannot reach SSH process code, Pi/workspace implementation or application. The former application host-health alias was removed after its callers moved; portable application exports contain no privileged authentication path. No duplicate authentication code or service tags is permitted.

Browser DTO/client entries are distinct from privileged Effect ports. `ConnectionService.endpoint` returns origin/token data only to a privileged consumer, without connecting or changing authority. Serializable inputs/results, snapshots and public error DTOs are suitable data for a future boundary. Callback functions, subscriptions, cancellation/observation handles, Context tags and runtime objects are runtime-only. Shape validation never grants native, endpoint or host authority.

## Named process roots

Only `packages/pi-runtime/src/host.ts`, `packages/pi-runtime/examples/remote.ts`, `packages/workspace/examples/local.ts` and `packages/ssh/examples/connect.ts` are infrastructure-package composition roots. They may bind public application runtime clients, dispatch and invocation helpers to a supplied process runtime. This is a file-level exception, never permission for an entire package. Service exports such as Pi `.`, `remote` and `server` are reusable infrastructure and must remain independent of application. The graph checker traverses their imports and rejects reaching a process-root file, so a host barrel cannot conceal an application back edge. Tests/fixtures may compose public APIs without becoming reusable service exports.

## Enforcement

`bun run check:foundation` runs source parsing, negative fixtures, unchanged-data compatibility assertions and real esbuild browser graphs. Source parsing reuses the Babel parser already installed by pinned StyleX tools; it handles ordinary imports/exports, erased type-only/import-type dependencies and literal dynamic imports. All source/test/demo/example modules are inventoried; production ownership and reusable-export reachability are enforced separately from test composition. Browser builds inspect the actual transitive metafile and reject UI/platform/provider/native implementation dependencies. DTO/client bundles must emit no Effect runtime imports; schema/service/headless graphs may include portable Effect. Computed platform imports are not a new portable capability: browser bundling remains required.

The source checker has no migration exceptions or legacy-allowlist mechanism. Application exposes only its factory, chat/editor features, runtime helpers and the concrete testing capability. Contracts owns every DTO/schema/service definition; workbench exports only its project editor, props/handle and worker configuration. Main navigation, Chat and startup failure presentation belong to desktop. Project editor presentation is consolidated in `packages/workbench`; there are no forwarding exports. Missing or non-public package exports fail the check even in tests, erased imports and named process roots.

Negative fixtures prove rejection of Node, UI type-only imports, dynamic Electron, import-type infrastructure, non-public/deep/removed package paths, runtime cycles, cross-package type cycles, workbench-to-infrastructure/desktop/privileged-port imports and reusable service exports reaching a permitted host root. The named SSH authentication leaf cannot reach process/service implementations. Foundation checks bundle the public features/runtime entries, audit the direct consumer's actual browser graph and execute its emitted JavaScript. Contracts DTO/client bundles emit no Effect runtime code; schema/service entry points may load portable Effect.

The configuration test's Nx inputs include all repository module/test/example source, package exports, boundary scripts and unchanged baseline fixtures, so cached checks cannot conceal a changed transitive edge.

The root source test command runs package suites serially because simultaneous native/process fixtures can delay the workspace watch test beyond its two-second deadline. Package-local concurrency, assertions and deadlines are unchanged.

## Fixed compatibility fixtures

`docs/fixtures/headless-baseline/*.txt` contains literal compact JSON bytes captured before extraction from the baseline public APIs: chat restore+preserve with an uncertain original Send and newer draft, empty editor recovery, whitespace-preserving Send and exact Stop with `taskId: null`. `scripts/check-compatibility.mjs` reopens/preserves chat through its public factory with capabilities that throw if invoked, and verifies decoded data serializes to the same bytes. Keep these files unchanged; move only consumer imports. Rejected saved-data and full recovery behavior remain covered by the existing feature/integration suites, not this small smoke check.

| Fixture | SHA256 |
| --- | --- |
| `chat-v1.txt` | `f38bdeec3aa07541b8792ad729eb355734b64744e5127cf3e86c101f87961277` |
| `recovery-v1.txt` | `20b7db711b18ada502b19c49a2674d570be2fc662f8e106f184fe7d7ddc6894f` |
| `send-v1.txt` | `f6a5201d904478d1e2cf46e34882098d7af6ac2417aaf16473edfe5e88644672` |
| `stop-v1.txt` | `3afc970241a178621a3c48a56e427f5b7e08c77502544e6c89b2fb4bd44235ad` |
| Existing `packages/workspace/test/fixtures/workspace-53a0996.tar.gz` | `4b9e54649f195a18e8d93502f86bf21ba12e070c10261aa47a61d6f6b8aa510b` |

The archived workspace source generates prior-producer SQLite records; its checksum remains fixed, and the harness rewires only extracted dependency imports to contracts/helpers. The existing unfamiliar-nested-data test verifies rejection without overwriting original rows. No saved data is imported, migrated, deleted, reset or projected-and-overwritten.

## Application and head ownership

`createMoonbaseApplication` owns one client runtime and an aggregate scope, with separately acquired/bound feature instances. Supply editor clients with distinct recovery identities and optional chat clients/context/synchronous storage. Editor-only and chat-only compositions acquire only their injected capabilities; optional chat initialization failure leaves combined editors usable and visibly distinguishable from unavailable or cleanup-blocked state. Required acquisition failure releases acquired resources. Main's privileged runtime and authority remain separate.

Application owns chat/editor state, lookup/mutation sessions, exact close prompts and lifecycle. Workbench owns the project file sidebar, buffers, React/Monaco models/listeners, workers, editor focus and rendering of a supplied editor controller and explicit checkout. Desktop owns main navigation, project layout, the separate Chat view and cross-panel routing, supplies native callbacks and retains platform lifecycle acknowledgments. Hide retains mounted Monaco undo/view state and detaches chat observation; view unmount releases presentation resources without disposing application state.

Quit preserves chat, runs exact Save/Discard/Cancel prompts, fences every public controller/workflow admission, preserves latest chat state and returns consent with that fence retained. Veto or failed preservation restores live admission without undoing completed saves/discards. Synchronous `canUnload()` gates reload; asynchronous `dispose()` joins actual cleanup and retains failures. Removed panels disappear promptly after preservation, while the application root retains pending/failing cleanup, namespace leases and visible status until teardown. Document loss offers no asynchronous durability guarantee. See [application lifecycle](../packages/application/docs/LIFECYCLE.md) and [desktop authority/lifecycle](../apps/desktop/docs/LIFECYCLE.md).

The [direct consumer](../packages/application/docs/HEADLESS-CONSUMER.md) documents the serializable data versus runtime-only callback/service/cancellation boundary. A future language/process adapter must retain endpoint credentials and native authority behind that boundary and test its own transport/runtime.

## Local chat

Desktop additionally acquires local Pi and optional remote/SSH layers in separate scopes of its existing main runtime, binding the exact acquired services through shared application handlers. Every IPC invocation/observation captures its backend ID and exact host/store/actor. Renderer selection does not choose where a late reply goes. A live document owns provider authentication flow/prompt authority; only native folder approval grants new local Create authority.

Contracts owns portable creation settings/local host variants and provider setup DTOs/ports. Pi runtime owns pinned provider/SDK authentication, injected encrypted persistence, per-conversation tool environments and privileged local activity inspection. Application owns explicit local readiness, setup presentation state, named-target controller lifecycle and the final fenced Quit hook. Workbench remains project editor/sidebar presentation without Chat. Desktop owns the existing Chat view and target/folder/model/setup controls. See [local runtime](../packages/pi-runtime/docs/LOCAL.md) and [application lifecycle](../packages/application/docs/LIFECYCLE.md).

Desktop main includes the local runtime/OAuth graph. Build/archive guards require that graph and its notices while excluding SDK, credentials, SQLite and native services from renderer/preload. Remote formats are unchanged.
