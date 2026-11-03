# Workbench delivery evidence

The shared-shell extraction below is historical evidence. The project-only follow-up moves navigation, Chat, startup presentation and the shell browser fixture into desktop. Current workbench exports receive an editor controller and exact checkout; the package source and emitted graph reject Chat/application composition dependencies. Follow-up verification is recorded separately from the original results.

## Project-only follow-up (2026-11-03)

Workbench now takes an editor controller and exact checkout. Desktop owns navigation, Chat presentation/visibility, startup failures and Quit routing. `renderLayout({ explorer, editor })` supports app-owned placement or editor-only presentation; the default explorer/editor layout remains resizable. Find File is scoped to the supplied checkout. Headless features, runtime acquisition, native authority and saved/wire formats are unchanged.

| Check | Follow-up result |
| --- | --- |
| `bun run check:foundation` | Pass; source ownership, negative fixtures, public graphs and fixed compatibility bytes |
| `NX_DAEMON=false bun run typecheck` | Pass, 8 tasks (5 cached) |
| Root lint, formatting and `git diff --check` | Pass |
| Workbench `check:renderer`, `build`, `test:ui` | Pass; 1,829 library inputs; 44 browser tests including project isolation and editor-only layout |
| Desktop `test:browser` | Pass, 13/13; moved shell/Chat regressions, including navigation, focus/undo, Quit and held/failing cleanup |
| Desktop `test` | Pass, 28/28 source tests |
| Desktop `build`, `check:renderer` | Pass; 1,862 actual renderer inputs, five workers/font and upstream notices retained |
| Desktop `test:composition --grep 'dirty editor/live chat|captured Quit keeps|closing Chat removes'` | Pass, 3/3 focused Electron cases with temporary repositories and faux chat services |

The two new layout/project browser cases were rechecked after strengthening completed-search and keyboard empty-editor/reopen assertions. Default layout screenshots were inspected. Logs are `/private/tmp/moonbase-{workbench,desktop}-*.log` and `/private/tmp/moonbase-typecheck.log`. The sandbox blocked local fixture sockets and the build's pinned license fetch; reruns with the required access passed. An initial overlapping shell run timed out during a repeated Cancel/Discard close; the isolated close cases and final serial 13-case shell suite passed.

The full repository source suite, complete native suite and packaged application were not rerun for this follow-up. Historical packaged/native results below do not qualify this tree. Configurable docking, panel drag-and-drop, real providers/SSH, OS gestures and accessibility acceptance remain outside these checks; this change supplies only the composition boundary.

## Historical shared-shell extraction

Issue [#85](https://github.com/ejjsharpe/moonbase/issues/85) was implemented on the working tree based on integrated `main` revision `715fef33f9aaa02b1b290d1732b082faffa0b4af`. GitHub's default branch matched that checkout at the start; the tree was clean. The delivered #46/#63 work was already integrated, including the application-owned lifecycle and thin headless client seams. This refactor preserves those domain/runtime responsibilities.

Checks use macOS arm64, Node `v26.13.0` and Bun `1.4.4`, with unchanged dependency versions. Commands below run from the repository root. Logs are `/private/tmp/moonbase-85-*.log`; generated screenshots/traces remain in the modules' ignored `test-results/` directories. These are local working-tree checks, not a CI or signed-release claim.

## Scope and baseline

The initial inventory covered ordinary, type-only and dynamic imports, package exports/manifests/lockfile, Nx inputs, lint and TypeScript globs, StyleX/Vite, CI, browser/native/package audits, demos, tests and documentation. Desktop was the only external presentation consumer. Editor/workspace and Chat integration consumers already use the public headless APIs and needed no presentation imports changed.

Before moving ownership, foundation, editor/desktop typechecks and the editor browser audit passed (1,829 actual browser inputs). Current presentation is entirely under `packages/workbench`; there is no old package or forwarding export. The entry exports only Workbench, props/handle, startup failure presentation and browser worker configuration. Editor file/tree/Monaco/dialog implementation and Chat view are internal features. Desktop retains validated IPC clients, native approval, `desktop-primary`, `moonbase.chat.v1`, document subscriptions, synchronous unload vetoes and awaited native disposal acknowledgments.

The original editor/import/race tests moved with their implementation and assertions. Demos now compose public applications and render the real shared shell. New shell regressions cover project/Chat switching, exact checkout selection and visible Open failures/retry from Chat, dirty comparisons, cursor/scroll, mounted Monaco and Undo retention, mouse/keyboard focus, scoped shortcuts, Save/Discard/Cancel, Quit from Chat, optional startup retry and held/failing Chat cleanup. Existing import tests retain exact captured native-reference/checkout coverage; existing recovery races retain original uncertain publication identity and explicit resolution.

The scroll regression exposed hidden Monaco layout events changing the recorded offset. The editor now suppresses hidden position writes and restores recorded positions when shown, without releasing models or Undo history. Native checks also exposed portal dialogs inheriting a desktop body font; dialogs now apply the shared document typography directly. Desktop also retains its document theme for startup/disposal presentation, while shared dialogs render correctly without consumer body styling. Accepted project Open requests reveal the editor before IO so failures from Chat remain visible. These changes preserve saved/wire formats and headless feature behavior.

## Verification

| Command | Result |
| --- | --- |
| `bun install --frozen-lockfile` | Pass; rename metadata only, no dependency upgrades |
| `bun run check:foundation` | Pass; public exports, source ownership, cycles, negative fixtures and fixed baseline-produced bytes |
| `NX_DAEMON=false bun run typecheck` | Pass, 8 tasks |
| `bun run lint` | Pass |
| `NX_DAEMON=false bun run test` | Pass, 8 source suites; initial run uncached, final run 6/8 cached; package execution remains serial |
| `bun run --cwd packages/config test` | Pass, 2 tests, including isolated foundation checks after the boundary-fixture updates |
| `bun run test:editor-integration` | Pass, 16/16, controlled workspace/native IO |
| `bun run test:chat-integration` | Pass, 7/7, faux providers and controlled loopback forwarding |
| `bun run --cwd packages/workbench check:renderer` | Pass, 1,834 actual library inputs; no desktop/Node/privileged implementation or demo/test capabilities |
| `bun run --cwd packages/workbench build` | Pass; real browser shell demo and worker/font assets |
| `bun run --cwd packages/workbench test:ui` | Pass, 47/47; includes all moved regressions and new shared-shell checks |
| `bun run --cwd apps/desktop build` | Pass; also executed by final package command |
| `bun run --cwd apps/desktop check:renderer` | Pass, 1,862 actual Vite inputs; shared shell/editor/chat, five workers and font |
| `bun run --cwd apps/desktop package` | Pass, unsigned arm64 local package |
| `bun run --cwd apps/desktop check:package` | Pass; archive matches build, native helper/ripgrep resources and upstream notices retained |
| `bun run --cwd apps/desktop test:native` | Pass, 60/60 against final build |
| `bun run --cwd apps/desktop test:package` | Pass, 23/23 against final unsigned package |
| `bun run format:check`, `git diff --check` | Pass |

Source enforcement rejects workbench imports of infrastructure, desktop, Node/Electron, privileged ports/runtime clients and demo/test capabilities, including erased and literal dynamic edges. The obsolete editor package remains only in a negative fixture and historical command evidence. Existing headless rules, process-root exceptions, public-export checks and cycle enforcement remain active. Actual library/Vite/archive graphs independently assert the new presentation inputs and retain the existing forbidden-dependency assertions.

Final source, browser, native and packaged suites run serially; native and packaged execution uses final build/package output with their original discovery, concurrency and deadlines. They cover exact project/native approval, optional Chat degradation, close/reopen and held/failing cleanup, Quit from Chat, reload/document replacement, crash recovery, stale acknowledgments, native resources and notices. They use owned processes and temporary repositories/user-data; no real host/provider or existing user store is used.

The sandbox denied a browser fixture listening socket and the build's pinned upstream license fetch. Those checks were rerun with the necessary local-server/process/network access; license verification and notices were retained. A sandboxed source rerun also rejected controlled listening/process fixtures; the successful source runs used the required access. Nx's sandboxed typecheck fell back to its existing in-process plugin mode. An overlapping qualification attempt produced native focus/typing and fixture-teardown timing failures; isolated reruns preserved assertions and deadlines. The browser position check waits for Monaco's actual initial diff readiness before capturing its offset; the portal check reads the modal-hidden workbench's computed style without querying its hidden accessibility tree. Build chunk-size warnings remain; no dependency/chunking change is part of this ticket.

Final unsigned archive SHA256: `b4dccd95ab1a0e8d28b5fc45020f3ba6d1971ae32134d8f32a1b4fdd458394e8`. The archive audit compares its renderer/main/preload/notices/assets against the generated build and records executable resource hashes.

## Remaining qualification

This browser harness proves portable presentation with supplied memory/faux capabilities. It does not implement a production web bootstrap, authentication, filesystem/Git backend or browser transport. No plugin registry, scheduler, storage migration or placeholder destination was added.

Human acceptance remains pending: real picker/clipboard/drag gestures, Finder Put Back, VoiceOver/full accessibility, physical durability, real SSH/providers, Intel execution, signing/notarization and distribution. Controlled rapid Open→Find tests pass but do not resolve the previously reported manual symptom. No deployment, real-provider quota, legacy-state import/deletion or GitHub merge was performed.
