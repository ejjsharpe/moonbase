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
