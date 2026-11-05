# Recorded thinking, tools and patches (#112)

Desktop private presentation consumes public structured parts and the headless transcript owner. It owns no execution, transcript store, polling loop or filesystem capability. The implementation began on clean `16c2957de740ef8bf8b48b4755c583d05b3e4805`, branch `t3/transcript-activity-diffs`, checkout `/Users/elliotsharpe/.t3/worktrees/moonbase/t3-e81dfd57`. Parent review/PR integration remains separate. Restoration prerequisite `40fc294` is the supplied `f3dfec0` patch, kept separate.

## Reading activity

`activity.ts` groups only consecutive recorded activity parts within each entry. User and assistant text retain their exact position before, between and after those runs, including across manifest/history pages. Later result entries keep their recorded position; the renderer never moves them into an earlier call. Each group and each thinking/input/output/detail part defaults folded. Compact summaries retain work state, thinking availability/byte progress, output byte progress/previews, failures, interruption, missing results and unmatched/ambiguous pairing. Live responses distinguish pending, unavailable/redacted and no supplied thinking. No provider signatures or private diagnostics are requested.

Read/write/edit inputs show their recorded path; bash shows its recorded command. These are inert summaries. Requested and executed arguments retain distinct labelled parts, generic JSON and exact original Copy. A request alone does not prove execution. Writes show captured arguments/content without an invented before/after diff. Unknown tools retain all supplied arguments, output and public details.

An originating call receives status evidence only from parts marked matched with the exact `call.entryId` and `call.partId`, within the same full target. Neither names nor reused call IDs join records. Missing evidence in the current bounded window says result not shown; it cannot imply a successful result or authoritative missing-result state. Explicit runtime missing-result/ambiguous/unmatched/interrupted states remain visible. Dropped-byte/line evidence remains attached to the retained output.

Current live content is present whenever the canonical window reaches the newest boundary (`later === false`), independently of bottom-follow mode. Reading a durable row in that window must not make a running tool disappear. Earlier windows with a later continuation omit live output. The existing 128-row budget, exact live-source selection pinning, current recovery notices and explicit Jump to latest remain in charge.

## Disclosures and follow-on consumers

`transcript.tsx` shares the existing private `useDisclosure` pattern between generic Parts and their activity wrapper. Application owns transient expansion memory. An exact supplied child-part anchor reveals both wrappers. Its semantic identity excludes viewport pixel offset; an explicit collapse remains collapsed across unrelated/live updates while that same intent remains present. A different part anchor can reveal again. Children stay mounted under a hidden group so their own disclosure state survives a group fold. Viewport restoration uses the visible group when its saved child is folded.

Every entry/part retains `data-transcript-entry` / `data-transcript-part`, exact sources, generic hydration and fixed-source native Copy. No specialist Find API or application/contract change is added. At integration, Find's exact source/part/original UTF16 range supplies new reveal intent only to the matching Part/group; unchanged intent must respect collapse. Original match coordinates remain separate from the viewport anchor's pixel offset. Stored image parts retain the same generic nodes, hydration and ResizeObserver/eviction lifecycle for #113.

## Historical patches

`recorded-patch.ts` calls the public `parsePatch` API from exact direct `diff@8.0.4`; its installed README and public declarations define the consumed hunk shape. The viewer renders read-only files/hunks, actual old/new coordinates, context/addition/removal lines and recorded EOF notices. Shared StyleX tokens distinguish line kinds alongside their literal prefixes. There is no line pairing, synthetic context, syntax guessing, current-file read or patch application.

Unified patches are the structured view; stored numbered diff parts remain an explicit source fallback with their original numbers. Incomplete, malformed, unsupported or over-budget unified patches receive labelled readable source. Parsing is limited to 64 Ki UTF16 units / 2,000 source lines; fallback display pages hold at most 16,002 UTF16 units within the currently hydrated source, overlapping a boundary code point when needed to keep emoji intact. Previous/Next source and generic Read more/Read from start allow continued reading. This is a display budget, not permanent source clipping.

Copy patch/diff uses the existing document/backend-scoped native fixed selection. Main independently iterates and validates the complete retained source, including parts too large to parse/display. Native cancellation, source freshness, exact target/document checks, awaited clipboard failures and Stop independence are unchanged. Recorded path strings never grant authority to open files or reconstruct history.

## Qualification

Evidence is recorded under ignored `test-results/transcript-112/` and `/tmp/moonbase-112-*.log`. Controlled fixtures use temporary stores, faux providers/tools and injected clipboard callbacks; the native local harness installs an inert clipboard writer before loading main, protecting every test from accidental OS writes. No real clipboard read/write, real-provider quota, unspecified SSH host, persistent dev app, legacy import/deletion, package release, PR or merge is authorized by this work.

Final focused source/browser/build/native results are recorded in the delivery handoff. Full known-failing #116 native composition/reload suites, packaged execution, VoiceOver/manual interaction, real providers/SSH and physical performance remain separate qualification. The historical #111 clipboard incident is not repaired or reclassified by injected tests.

## Original delivery qualification

Code head: `01fd30f8fdacc5a0302ed71a3366dcaf04c12ea6`. The separate shared visibility prerequisite is `fcad1d3551d59c4fbd6d58646266e9f21ec295d3`; it includes a generic text-Part probe independent of Activity, oldest anchored/selected-row retention at the 128-row boundary, and explicit Jump to latest. Checks used Node 26.13.0 / Bun 1.4.4. Native test/build work ran in the parent's assigned serial lane, then released it after all owned apps, hosts and forwarders exited. No persistent app was started.

| Evidence | Result and artifact |
| --- | --- |
| Frozen install | Pass; `diff` is only a new direct workspace edge to the already locked exact version. `/tmp/moonbase-112-install.log` |
| Focused source | 56/56: activity, actual unified coordinates/fallback, Markdown, native source/IPC and chat session. All clipboard capabilities injected. `/tmp/moonbase-112-source.log` |
| Browser | 25/25 relevant activity/transcript cases. The later strengthened unavailable missing-result/redacted/stopped case passes 1/1; historical-patch visual capture passes 1/1. `/tmp/moonbase-112-{browser-final,missing-result,patch-visual}.log` |
| Standalone shared regression | 1/1 generic live-Part/128-row selection probe; `/tmp/moonbase-112-generic-live.log` |
| Type/lint/format/foundation | Pass; `/tmp/moonbase-112-{typecheck,lint,format,foundation}.log`. Foundation reports 281 public browser inputs and unchanged saved bytes. |
| Actual desktop build/graph/notices | Five tasks pass, four cached; desktop rebuild executes. 8,902 renderer inputs, five workers/font, no privileged modules; complete `diff@8.0.4` BSD-3-Clause notice collected. `/tmp/moonbase-112-{build-final,renderer}.log` |
| Focused controlled Electron | Final 4/4 after rebuilding the changed shipping renderer: local and authenticated remote held thinking/text plus held tool appends/focus, injected complete Copy, unchanged `getChat` counters across progress, independent Stop, and actual local 200% reading. `/tmp/moonbase-112-native-final.log` |
| Mechanical/visual | Detector `[]`, `/tmp/moonbase-112-detector.json`. Inspected `normal.png`, `compact.png`, `unified-hunks.png`, `historical-patches.png`, and native held-tool/200% captures under `test-results/transcript-112/`. |

The initial native fixture assumptions were corrected: `api.output` appends chunks; a settled local Stop can remove its button; a focused retiring live thought intentionally pins its old source until focus leaves. The native reading probe now scrolls to the actual sticky boundary and records geometry, with one CSS pixel tolerance for fractional device-coordinate rounding at 200%. It does not weaken source, completion, failure or Copy assertions. The early browser helper also returns explicitly to latest after opening a historical activity group. Red/intermediate logs remain separate from the final passing evidence.

Parent-owned integration remains explicit: consume the incoming #111 partial-hydration code-selector/control-navigation corrections and headless startup-race fixes, and combine Find's exact source/part/UTF16 intent with this private disclosure hook. The hook already reads the current controller view when changing expansion IDs, retaining a newer pointer capture. No speculative Find shape, duplicate key handler, native source-proof change or application/runtime edit is included here. Parent commissions independent feature review before PR work; this checkout creates/pushes no PR or shared branch.

## Corrected shared-base integration

The original implementation branch `t3/transcript-activity-diffs` remains at `d525bbfb921a75daa413580e1f9fe83a2445950e`. After asserting that checkout clean, the same owned worktree switched to new branch `t3/transcript-activity-diffs-r2` at corrected shared renderer `70e831cc12932d8a367ec19639d87c9cf3d4ce78`. Only feature `01fd30f` and doc `d525bbf` were cherry-picked, as `35e21cb` and `94cd921`. Restoration/visibility prerequisites already in that base were not replayed. Desktop README/TRANSCRIPTS conflicts retain the current shared provenance and Markdown policy, adding the activity documentation without restoring the stopped writer's provenance.

The integration retains the base's private `{start: number}` code selector, original remark UTF16 fenced-node start and exact full-AST native validation; index-only selectors remain rejected. The parent transcript control handler and preview-part capture fallback remain unchanged. The extracted `useDisclosure` carries the base's pointer/key-down toggle intent, pointer cancellation and current-controller-view click behavior into both Part and Activity. A capture that implicitly reveals a part between input and click must not reverse the reader's original toggle intent. Collapse records the current captured child anchor, including any child in an Activity run, without spreading cached view state back into the controller.

Part control fixtures explicitly open and retain the new outer Activity wrapper before reopening the panel with a held manifest. This keeps their preview Part controls available while preserving every existing R4 anchor/offset/error/expansion assertion. Six added Activity pointer/Enter/Space cases cover held manifest success and error, opening from the original input intent, retaining the new reading capture, and explicit collapse across completion and cloned updates. The generic short-window live/128-row selection probe remains independent of Activity.

Fresh integration evidence is source/type/browser only, under `/tmp/moonbase-112-r2-*.log`: source 58/58, selected control/Copy browser 16/16, complete activity/transcript browser 36/36, desktop typecheck, root lint/format and detector `[]`. Browser fixtures used owned port 4183 and cleaned up their server. No build, native or packaged suite was run on this combined head. The original native 4/4 and built graph/notices above qualify the original feature revision only. Concrete Find source/part/UTF16-range intent and reveal cancellation enter in the next parent integration; no speculative Find types or duplicate navigation handler are added here. Parent assigns a new independent review before PR work.

## R6 fixture readiness correction

Based on exact `ccefcb81c430a2231861469cd6767ca4d1248f42`, branch `t3/transcript-activity-space-ready` adds only a two-frame wait after focus before keyboard activation. It lets focus-induced scrolling settle while retaining every capture, collapse, error and current-view assertion. Production code is unchanged; the original `d525bbf` and r2 `d2275e7` refs remain preserved.

Public browser checks on owned port 4183 pass repeated Space held success/error 6/6 and pointer/Enter/Space held success/error 6/6. Desktop typecheck, root lint/format and diff checks pass. Logs: `/tmp/moonbase-112-r6-{space-repeat,controls,typecheck,lint,format}.log`. No broad, build, native or packaged suite was run; parent assigns new independent review after integration.

## R7 EOF patch validation correction

Branch `t3/transcript-patch-eof-112` starts at exact delivery base `144c7649db8fbe6cf81a3c931837a5c29677e509`. A missing terminal newline is normalized only in the argument supplied to `diff.parsePatch`, preventing its silent missing-count adjustment at bare EOF. Authored source remains unchanged in fallback display and complete fixed-source Copy. No Copy proof, completeness guard, Find API or prerequisite change is included.

Before the source fix, four malformed EOF source cases failed and four valid no-newline cases passed; the browser reproduced the deletion-only table without a malformed warning while exact Copy passed. Afterward, source tests pass 12/12 and focused browser tests 3/3, covering both EOF cases plus existing coordinates/large/malformed/numbered/incomplete source behavior. Typecheck, lint/format and diff checks pass. Logs: `/tmp/moonbase-112-r7-{source-red,source-green,browser-red,browser-green,typecheck,lint,format}.log`; red/green screenshots and traces are under desktop `test-results/activity-r7-{red,green}/`. Browser tests used and released port 4183. No broad, build, native, package or OS clipboard checks were run; parent assigns new Tools R8 review before PR work.
