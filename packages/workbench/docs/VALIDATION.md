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

## File-tree context menus (#107)

Source checks pass: Workbench and desktop typechecks, root lint, Workbench build/renderer audit, foundation boundaries and formatting. The final Workbench browser suite passes 78/78, including 27 context-menu cases; the editor/preservation source suites pass 64/64 and controlled editor/workspace integration passes 26/26. The final full run includes the focus-style, positioning and competing-dialog fixes. The review found an unchosen menu backdrop intercepting preservation dialog clicks; new preservation, external-import and cross-workbench handoff regressions reproduced the failures before their fixes and pass afterward. The final independent review approved the implementation with no material findings after both modal-handoff findings were fixed. These checks use memory or temporary workspace capabilities and no real provider/SSH.

Context-menu coverage includes secondary/Control-click, ContextMenu/Shift+F10, nested paths, active-editor/focused-row distinctions, stable range anchors, all offscreen selections in 10,000 rows, disabled actions during preservation, unrelated Saves, keyboard navigation/activation, Escape and Tab traversal, dialog handoff/return focus, competing preservation/import modal focus and first-click delivery, outside click consumption, clipboard portal isolation, scroll/hide/target-loss/navigation/unmount dismissal, independent workbenches and controlled local/remote host identities with matching checkout IDs/path names. Captured dialogs refuse closed checkouts and retain their original host/root/path display. Edge-position screenshots are inspected at 1440, 768 and 390 pixels. The Impeccable detector reports no findings on the changed production UI files.

Native dev smoke: the final desktop build retained notices for 61 packages, launched with fresh temporary user data, opened this exact worktree through the native picker, and displayed all three README row-menu entries after an OS-synthesized secondary click. No mutation was executed. Manual macOS secondary/Control-click, physical function-key behavior, VoiceOver, viewport zoom and Finder Trash recovery remain unqualified. Automated gestures and temporary native filesystem integration are recorded separately from those human checks; packaged execution and real hosts/providers were not run for this change.

The subsequent UI refinement labels the action **Rename** and removes the bottom action row, retaining the optional standalone import picker above the tree. Its 35 focused browser checks pass (27 context-menu, five import and three rename/range regressions), as do Workbench/desktop typechecks, lint, formatting and the desktop build. Updated native test callers use the context menu; the native suite was not rerun. The rebuilt dev app was restarted through normal Quit with its existing temporary profile, and the absent footer icons were checked visually.

## Remaining qualification

This browser harness proves portable presentation with supplied memory/faux capabilities. It does not implement a production web bootstrap, authentication, filesystem/Git backend or browser transport. No plugin registry, scheduler, storage migration or placeholder destination was added.

Human acceptance remains pending: real picker/clipboard/drag gestures, Finder Put Back, VoiceOver/full accessibility, physical durability, real SSH/providers, Intel execution, signing/notarization and distribution. Controlled rapid Open→Find tests pass but do not resolve the previously reported manual symptom. No deployment, real-provider quota, legacy-state import/deletion or GitHub merge was performed.
# Integrated #116: late editor completion and newer focus

The packaged resource journey exposed a product race after an earlier tab Close: its asynchronous survivor-open completion could restore strip focus after the user had already opened a new menu. Read-only instrumentation records Keep Open focused, then the selected tab focused before Enter; document focus remains true. Evidence is `/tmp/moonbase-116-qualification-20261105/package-menu-probe.log` and its retained probe source. This differs from the previously reviewed file-context popup's initial-focus/scroll behavior.

Three public-controller regressions hold the real survivor-open result after its state update, open a new tab menu/file menu or focus the second workbench, then release it. All three fail before the correction (`late-close-focus-red.log` and copied traces). The private focus request now captures its initiating DOM element. At application it yields when focus has moved outside that workbench into a different active element; ordinary within-view/body fallback and existing Close/Reopen origin handling remain. No controller, persistence, menu commands, dependency or animation changes.

The focused corrected run includes the three regressions and existing keyboard Close, cancelled/failed publication, Reopen, empty-editor and first/last menu/Close-click checks at normal/small/zoom dimensions. Its log is `/tmp/moonbase-116-qualification-20261105/late-close-focus-green.log`; final integrated full-UI/native/package results belong to the repository qualification ledger. This requires fresh parent review with the other #116 changes.

The first independent review reproduced four additional in-root destinations: typing in the survivor, choosing another file, tree navigation and sidebar resize. All four failed in the baseline and initial correction; withholding completion until after assertions was a passing control. The unchanged public probe suite is preserved in `test-results/qualification-116/workbench-input-probes/` and external red/green evidence under `/tmp/moonbase-116-qualification-20261105/workbench-input-{red,green}-probes*`.

The follow-up uses one local input counter, advanced by the existing shared keyboard handler and the view's pointer capture. A focus request captures that counter and cannot apply after newer input. Automatic Base UI focus return/body fallback remains eligible. The current preservation prompt's answer retains its action's origin. The four owned regressions retain first-character/arrow assertions and share the existing held public survivor-open fixture with the three external-destination checks. Unchanged reviewer probes pass 13/13; focused repository cases pass 17/17, including normal Close/Reopen, cancellation, failed publication/Resolve and all three menu dimensions. There is no global coordinator or controller/runtime API change.

Independent R2 found a standalone-consumer gap: Tab starts in consumer chrome, so its keydown never reaches the workbench. After Tab enters Resize sidebar, an older completion stole focus and the first ArrowRight left the width at 270 instead of 280. The unchanged public reproduction fails before correction (`workbench-tab-entry-red.log`). A keyup-only candidate passed that schedule but failed when completion was released between focus entry and keyup (`workbench-tab-entry-early-red.log`). The final correction advances the same local counter on focus entry from a connected non-body surface outside the view, excluding automatic menu/dialog return. It requires no consumer shortcut forwarding. Two owned held-completion schedules retain the first-arrow assertion, releasing before and after keyup. The byte-identical reviewer suite passes 20/20, the additional before-keyup probe passes, and focused owned cases pass 19/19. These retain prompt, Close/Reopen, body fallback and external/in-root focus guards; typecheck, lint, renderer graph and scoped format/diff checks pass. Evidence is retained under `/tmp/moonbase-116-qualification-20261105/workbench-tab-entry-*`; final integrated qualification belongs to the repository ledger.

Independent R3 found that the previous focus-entry guard cannot identify Tab traversal after a consumer menu unmounts or when the prior focus target is body or disconnected. A component-owned document listener now observes external Tab keydowns and advances the existing counter before focus moves, even if the origin later disappears. It ignores Tab within the active preservation prompt and is removed on unmount. The owned regressions exercise the actual Base UI consumer menu, a nonfocusable surface, a button removed on blur and a connected button, each released before and after keyup, with the original 270→280 first-arrow assertion. Against the previous source, the six null/disconnected-origin schedules fail with that assertion and the two connected-button controls pass (`workbench-r3-final-red.log`). With the correction, these eight and 34 focused counter, automatic-return, preservation-prompt and second-workbench controls pass (`workbench-r3-final-green.log`). A new prompt regression Tabs to Discard and requires survivor editor focus; it fails when the prompt exclusion is removed. The menu fixture first imports `@base-ui/react/menu` after load, so a cold dependency cache made Vite reload the page and destroy the test's execution context. The demo config now prebundles that entry. Evidence is under `/tmp/moonbase-116-qualification-20261105/workbench-r3-*`. That includes the reproduced reload trace and a separately preserved invalid red attempt whose cold-cache optimizer stalled before navigation.
