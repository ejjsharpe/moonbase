---
name: "Moonbase"
description: "A quiet charcoal workbench for conversations and project editing."
colors:
  canvas: "#141415"
  chrome: "#161618"
  surface: "#161618"
  elevated: "#222224"
  hover: "#2b2b2e"
  selected: "#28282b"
  selectedHover: "#303034"
  text: "#e5e5e7"
  secondary: "#b2b2b8"
  muted: "#97979f"
  border: "#29292d"
  controlBorder: "#343438"
  accent: "#ededf0"
  onAccent: "#19191b"
  link: "#ffffff"
  selection: "#3a3a42"
  warningSurface: "#393222"
  warningBorder: "#77613b"
  warningText: "#ffd49b"
  danger: "#ffb4ab"
  backdrop: "#0008"
typography:
  caption:
    fontFamily: "\"Manrope\", -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "11px"
    lineHeight: 1.5
  label:
    fontFamily: "\"Manrope\", -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "12px"
    lineHeight: "18px"
  body:
    fontFamily: "\"Manrope\", -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "13px"
    lineHeight: 1.5
  title:
    fontFamily: "\"Manrope\", -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.5
  message:
    fontFamily: "\"Manrope\", -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "15px"
    lineHeight: 1.7
  composer:
    fontFamily: "\"Manrope\", -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "15px"
    lineHeight: 1.6
  heading:
    fontFamily: "\"Manrope\", -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "16px"
    lineHeight: 1.5
  code:
    fontFamily: "\"SpaceMono Nerd Font Mono\", SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "13px"
    lineHeight: 1.6
rounded:
  control: "6px"
  row: "7px"
  panel: "12px"
  composer: "18px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  xxl: "32px"
components:
  button:
    backgroundColor: "{colors.elevated}"
    textColor: "{colors.text}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "5px 10px"
  button-hover:
    backgroundColor: "{colors.hover}"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.secondary}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "5px 10px"
  button-icon:
    backgroundColor: "transparent"
    textColor: "{colors.secondary}"
    rounded: "{rounded.control}"
    padding: "6px"
    width: "28px"
    height: "28px"
  button-send:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.onAccent}"
    rounded: "50%"
    padding: "7px"
    width: "32px"
    height: "32px"
  button-send-hover:
    backgroundColor: "{colors.link}"
  field:
    backgroundColor: "{colors.chrome}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "6px 8px"
  main-tabs:
    backgroundColor: "{colors.chrome}"
    padding: "4px 14px 4px 86px"
    height: "40px"
  project-tab:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "8px"
    padding: "0 8px"
    width: "216px"
    height: "32px"
  project-tab-selected:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.text}"
  project-tab-selected-hover:
    backgroundColor: "{colors.selectedHover}"
  agents-tab:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "8px"
    padding: "0 8px"
    height: "32px"
  agents-tab-selected:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.text}"
  agents-tab-selected-hover:
    backgroundColor: "{colors.selectedHover}"
  conversation-row:
    backgroundColor: "transparent"
    textColor: "{colors.secondary}"
    typography: "{typography.label}"
    rounded: "{rounded.row}"
    padding: "9px 12px"
  conversation-row-selected:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.text}"
  composer:
    backgroundColor: "{colors.elevated}"
    textColor: "{colors.text}"
    typography: "{typography.composer}"
    rounded: "{rounded.composer}"
    padding: "{spacing.md}"
  popup:
    backgroundColor: "{colors.elevated}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.panel}"
    width: "min(360px, calc(100vw - 32px))"
  file-row:
    backgroundColor: "transparent"
    textColor: "{colors.secondary}"
    typography: "{typography.body}"
    padding: "3px 6px"
    height: "28px"
  file-row-selected:
    backgroundColor: "{colors.selected}"
---

# Design System: Moonbase

## Overview

**Creative North Star: "The Quiet Workbench"**

The Quiet Workbench follows the user-pinned Cursor reference: cool charcoal surfaces, Manrope interface typography, compact outline controls and a spacious conversation measure. This is an Operate surface. Familiar navigation, readable content and visible state define its character. The latest pinned canvas and sidebar colors supersede earlier palette explorations.

The shell stays visually flat. Tonal steps separate navigation, content, controls and selection; light neutral focus and Send treatments identify action. Desktop conversation and editor views share this language while retaining their own layout and interaction owners. The reference supplies the visual quality bar; no catalog world was adopted. The build is code-led and ships no raster design assets.

**Key Characteristics:**

- Exact charcoal canvas and sidebar levels with coordinated cool-neutral controls.
- Bundled Manrope for interface text and SpaceMono Nerd Font Mono for code.
- Compact controls, generous conversation space and restrained tonal hierarchy.
- Shared StyleX appearance with Base UI interactions and native macOS window controls.

This is the shipped design record following the final full review disposition **SHIP**. Product context lives in [desktop PRODUCT.md](../apps/desktop/docs/PRODUCT.md); the approved surface direction lives in [REDESIGN.md](../apps/desktop/docs/REDESIGN.md). The latter records `seed:09148c466bb8e386`, corroborated by the saved roll; the user-pinned reference remains authoritative.

Implementation authority is [tokens.stylex.ts](../packages/ui/tokens.stylex.ts) and the shared recipes beside it. Frontmatter records their implemented values; component references resolve against those primitives. The schema-version-2 [sidecar](../.impeccable/design.json) extends the record with color metadata, panel swatch ramps, responsive thresholds, desktop main-tab motion, component previews and narrative. Generated swatch ramps are panel aids, not additional application tokens. Self-contained HTML/CSS previews show settled appearance without React or Motion runtime; their hover/focus states remain static.

Evidence checked by the final independent review: `test-results/redesign-review/{desktop,conversation,editor}.png` (1440×900), `768.png` (768×844), `{390,drawer}.png` (390×844), `{tabs-idle,tabs-hover}.png` (1440×40), plus `native.png` (2560×1700; 1280×850 CSS pixels) and its `native.png.json`. These nine captures are ignored review artifacts, not shipping assets; browser content uses a clearly named demo provider/model. All five review sections (`persistence`, `fidelity`, `ceiling`, `material_fixes`, `keep`) are complete with no material fixes. The review confirms the native hash and geometry, exact palette, Tabler outlines, whole-group selection with rounded corners, left-aligned labels, equal icon/close insets, uniform 6px group gaps including Agents, per-group dim/hover/close/focus states, inactive-neighbor dividers and aligned file/folder/open-folder icons. Pinned navigation without a separate caption and compact-window layouts remain approved. The recorded minimum text contrast is 4.53:1.

Current Motion evidence supersedes older no-motion records: the final desktop browser run passes 22/22 (`/tmp/moonbase-motion-complete-browser.log`), including rapid close/reopen, normal/scrolled middle-tab removal and reduced motion. Both middle variants pass three repeats each (`/tmp/moonbase-motion-middle-static-scroll.log`). The review's `tab-motion-{normal,reduced,middle,middle-scrolled}.json` records show the approved behavior; each middle dataset has 33 frames at constant y=4px with zero rightward reversals for the surviving tab and plus. These are controlled position observations, not physical motion-performance qualification. The fresh independent finish review remains **SHIP** across all five sections with no material fixes; all nine current captures and the native hash/geometry match.

The parent directly verified native dirty-editor/live-chat composition and native 200% at 2/2 (`/tmp/moonbase-motion-composition.log`); local first-message/tools/hidden-work/restart passes 1/1 (`/tmp/moonbase-motion-complete-native.log`). Standalone Workbench remains qualified at 48/48 (`/tmp/moonbase-spacing-tree-workbench-final.log`), with its source unchanged by Motion. Build (`/tmp/moonbase-motion-complete-build.log`), typecheck, lint, frozen install and renderer graph checks pass. The build collects 61 package notices including Motion; all 771 original locked packages are unchanged. This documentation pass reads source and supplied evidence without rerunning browser, tests, native, build, boundary or detector checks. Physical motion performance, OS window-button clicks, VoiceOver, packaged release execution and real providers/SSH remain unqualified. No defect or superseded horizontal label-centering rule is promoted into this system.

## Colors

Cool charcoal carries the interface; neutral lightness carries action and hierarchy. Frontmatter preserves every source color, including both `chrome` and `surface`, which intentionally share one value.

### Primary

- **Light neutral action** (`accent` / `onAccent`): keyboard focus and the inverted Send control. `link` supplies link text and Send hover. These are functional neutral accents, not a separate brand hue.

### Neutral

- **Canvas** (`canvas`): main chat/transcript and editor background.
- **Sidebar charcoal** (`chrome`, `surface`): Agents sidebar, editor sidebar, tab strip, toolbars and field backgrounds.
- **Raised charcoal** (`elevated`): composer, ordinary buttons, menus and dialogs.
- **Hover charcoal** (`hover`): enabled-control hover and menu-option focus.
- **Selected charcoal** (`selected`, `selectedHover`): selected main-tab groups, conversation and tree rows, plus their hover state.
- **Content and metadata** (`text`, `secondary`, `muted`): content, supporting controls and small metadata, respectively; inactive main-tab groups also use muted text. Disabled shared buttons use opacity (0.55); that state is not a new text color.
- **Boundaries** (`border`, `controlBorder`): structural separators and control outlines; control-border tone also supplies the short inactive-tab dividers. `selection` marks selected text and selected file tabs.
- **Backdrop** (`backdrop`): translucent black behind modal surfaces.

### Semantic states

- **Attention** (`warningSurface`, `warningBorder`, `warningText`): preservation failures, retained-command uncertainty and conflicts.
- **Invalid input** (`danger`): field and file-operation errors. Pair state color with text or a clear state affordance.

**The Pinned Surface Rule.** Preserve the canvas and sidebar tokens exactly; build companion surfaces from the shared cool-neutral palette.

Readable enabled text must maintain at least 4.5:1 against its actual surface. Structural separator colors are not text colors; preserve focus outlines and labels rather than depending on low-contrast boundaries alone.

## Typography

**Interface font:** Manrope (`type.sans`), with platform sans fallbacks. **Code font:** SpaceMono Nerd Font Mono (`type.mono`), with SFMono-Regular / Menlo / Consolas fallbacks. The user selected this pairing for the editor’s character. Both fonts are bundled locally through the shared reset, with their upstream notices retained; no system installation or remote font service is needed. See [font provenance](../packages/ui/docs/FONTS.md). Existing type sizes, line heights and weights remain authoritative.

### Hierarchy

| Role | Source and use |
| --- | --- |
| Caption | `type.caption`: dates, local-tool help, small status and identity metadata |
| Label | `type.small`: ordinary controls use an 18px line height; supporting chat text uses 1.6 |
| Body | `type.body`: shared document text, tree rows, menus and control headings; shared document line height is 1.5 |
| Title | Body-sized, medium weight (500): saved-conversation heading |
| Message | `type.message`: transcript content, line height (1.7) |
| Composer | Message-sized textarea, line height (1.6) |
| Heading | `type.heading`: dialog and empty-state headings |
| Code | `type.mono`: preformatted output at body size and line height (1.6); Monaco uses the same stack and size through its own API |

Use semibold (600) for established control/section emphasis and bold (700) for existing search-match emphasis. There is no uppercase display hierarchy. Ellipsis handles constrained conversation titles, folder names and project labels; full context remains available through the existing title or details affordance.

**The One Measure Rule.** Align transcript content and composition to the same conversation maximum width.

## Layout

Use the shared spacing rhythm (`xs` through `xxl`) for repeated gaps and padding. Feature-specific geometry stays with its composition rather than becoming a new global token.

### Desktop shell

The shared main-tab strip is 40px high, with padding (4px 14px 4px 86px) and centered cross-axis alignment. The left reserve accommodates native window controls. No bottom border consumes vertical space: each 32px-high tab group has equal space (4px) above and below. Desktop places a distinct, compact, natural-width Agents group before the independently scrolling project group. Every adjacent tab group has the same gap (6px), including Agents to the first project; Agents has no additional trailing margin. Project tabs have a fixed flex basis (216px), inner padding (0 8px), zero gap between their internal controls and rounded corners on all sides (8px).

Within each project group, the tab button fills the available width and height, with padding (0 4px), an icon-to-title gap (8px), left-aligned text and a growing, truncated title span. The separate close control is square (24px), with padding (4px), zero border and no margin. The icon and close glyph have equal outer insets (12px), and their centers sit equally far from the group edges (20px). Labels and controls remain vertically centered. Agents uses the same group/button padding and close geometry, with a left-aligned semibold label and natural width. The plus is square (30px), centered vertically without a bottom margin, and opens a project within the scrolling project group. Tab buttons, close and plus controls remain non-drag regions inside the native draggable strip.

Routine “Preserving edits…” status uses the shared visually hidden recipe so closing a project cannot briefly shift the content. Recovery confirmation and cleanup status rows remain visible below MainTabs without displacing the strip or native window controls. The project overflow scroller stays a plain, stationary, relatively positioned div; Motion projection belongs only to individual tab groups and the plus, with no parent projection or `layoutScroll` on the scroller.

Electron main uses `titleBarStyle: 'hiddenInset'`, `trafficLightPosition: { x: 14, y: 14 }` and the pinned canvas background. There is no separate macOS app-name titlebar. The `title: 'Moonbase'` string remains OS metadata. Native buttons are OS-owned, not SVG substitutes; a web-content capture does not qualify their interaction.

### Agents

The default sidebar is 288px. At a viewport width of 760px or less it narrows to 210px; at 640px or less it becomes a Base UI dialog drawer. The drawer width is `min(280px, calc(100% - 32px))`; its sidebar reserves 48px at the top for the close control. Focus management and Escape dismissal remain Base UI responsibilities. These are window-width adaptations, including high-zoom conditions, rather than a separate phone product.

The conversation maximum is the shared `layout.conversation` (640px). The composer width is `calc(100% - 48px)` within that maximum. The transcript uses 24px horizontal padding and the same capped inner measure. New-chat composition sits near the vertical center with a 40px bottom bias; a saved conversation places composition beneath its scrollable transcript. The empty desktop heading remains accessible but visually hidden; compact windows retain their visible heading and drawer trigger. Redundant sidebar branding is absent.

### Editor

The editor sidebar is independently resizable from the controller's default (270px), bounded by the controller (190–380px); it is not the Agents width. The sidebar separator has a 6px pointer target and a visible focus/hover treatment. File rows use `layout.treeRow` (28px), with 16px indentation per nesting level. Each row reserves a 16px disclosure column, empty for files, followed by its 16px file/folder icon and name with the existing 5px row gaps. File and folder names align at the same nesting level. Their height is also the virtualizer geometry contract; inline editing may grow a row through the existing editing state. File tabs and work areas retain their own scroll behavior.

## Elevation & Depth

Depth comes from surface tones, one-pixel boundaries and modal backdrops. There are no decorative cast shadows. The Files/Diff selected-view marker is a functional inset one-pixel line (`inset 0 -1px #ededf0`); tab controls explicitly use no box shadow. Drawer and popup stacking separates temporary surfaces from the work area. Shared StyleX recipes remain static; the desktop main-tab runtime owns the user-approved Motion behavior recorded under Navigation and in the sidecar's motion extensions.

**The Flat Workbench Rule.** Use surface tone, borders and state outlines for depth; reserve inset lines for navigation state.

## Shapes

Small controls use `radius.control`; interactive rows use `radius.row`; menus, dialogs and established code containers use `radius.panel`; the composer uses `radius.composer`. Main project and Agents groups have inset browser-tab shapes with all four corners rounded (8px). Their geometry belongs to main navigation; editor file tabs remain a separate composition. Send is circular (32px), while ordinary icon actions keep the shared control radius. Tiny circular status and unsaved markers are state indicators, not a pill-control style.

Icons use the official [Tabler outlined icons](https://tabler.io/icons) selected by name in [icons.ts](../packages/ui/icons.ts) from `@tabler/icons-react` (3.50.0). Desktop and Workbench adapters render them at 16px with a 24-unit viewBox, no fill, current-color stroke (1.5), rounded caps/joins and `aria-hidden="true"`. Accessible labels and existing titles belong to the enclosing controls. File-tree rows use `IconFile`, `IconFolder` and `IconFolderOpen`; their chevrons and file-tab close actions use this same selection. No handwritten path vocabulary remains in the implementation; the sidecar inlines the selected Tabler SVG shapes so previews need no React runtime. Tabler's MIT license is collected automatically into desktop `dist/dependency-notices.txt` by the existing build tooling. Do not replace this icon selection with text glyphs.

## Components

### Buttons and fields

Compact and familiar. `controls.button` supplies the base font, one-pixel control border, control radius and padding. Ordinary buttons use elevated fill, then hover fill while enabled. `quietButton` removes the visible border/fill and uses supporting text; `iconButton` is 28px square with 6px padding. Send alone uses the light neutral circular treatment. Shared buttons retain their disabled cursor/opacity and a two-pixel focus-visible outline with a two-pixel offset.

`controls.field` supplies a chrome field with a control border, shared radius and padding. Placeholder text uses muted color; the caret and native accent use the neutral action color. Its visible focus outline matches buttons. Keep inherited typography rather than introducing another field typeface.

### Composer and transcript

The composer is the signature container: elevated fill, a one-pixel control border, generous composer radius and shared medium padding. Focus within changes its border to muted. The message textarea has no separate border, no resize grip, a minimum height (48px) and a maximum height (25vh). Folder and local-host context sit above it; compact model and reasoning-effort selectors and Send sit in its action row. Both selectors use the existing Base UI Choice and quiet-button recipe. The model label can shrink; the effort control keeps a 116px measure. First-time defaults yield to explicit preferences across new chats and restarts. Unavailable preferences remain visible with a replacement action before Send. The required local-tool notice and shortcut hint remain directly below.

Users can type without a project or saved conversation. The first explicit Send creates the conversation from the preserved unsaved draft. The application controller owns that behavior; appearance changes must preserve its existing commands and uncertainty presentation. Transcript entries use quiet role labels and the message type role. Tool output receives the existing contained surface; retained commands and preservation failures remain visible.

### Navigation and conversation rows

Agents is pinned before independently scrolling projects, with a distinct rounded inset selection treatment and the same 6px spacing as every adjacent tab group. Main-tab selection fills the whole group, including the separate close control, using selected fill and selected-hover fill on group hover. Inner tab buttons stay transparent at rest and on hover. Inactive groups use muted text; that group's hover or focus-within brightens its text, and hover supplies elevated fill. Selected groups keep main text. Project tabs carry checkout basename and branch; labels are left-aligned with equal icon/close outer insets. Agents keeps its semibold label and compact natural width. MainTabs retains its existing handlers.

Close actions remain separate, keyboard-focusable controls. Their default opacity (0) and pointer-events (`none`) preserve layout space. Selection explicitly reveals the close control; only that group's hover or focus-within otherwise sets opacity (1) and pointer-events (`auto`). The shared StyleX `defaultMarker` belongs on each individual group so hovering elsewhere cannot reveal all close controls. A shared pseudo-element after a group supplies the divider (1×16px, `right: -4px`, `top: 8px`, `controlBorder`) only when both neighboring tabs are inactive. Agents uses the same divider placement. There is no divider adjacent to a selected tab, after the final tab or before the plus. Editor file tabs retain their own editor composition; Files/Diff navigation uses a functional active underline, and Find is an icon action.

Project tabs follow the controller's open-checkout order: new and reopened projects append at the end, while selecting an already-open project keeps its slot. A successful background close retains the current view; cancelled or failed closes reveal the captured project and its recovery controls. Closing the selected project immediately selects the rightmost remaining project, with Agents as the fallback when no projects remain. Both presentations stay mounted, with explicit panel visibility preventing an outgoing empty editor from appearing during the switch. Save/Discard/Cancel gates and visible recovery errors remain authoritative. Editor errors stay visible and dismissible in Agents when no project is open.

Desktop directly depends on `motion@14.9.0` and imports from `motion/react`. Its private `AnimatedTab` presentation helper forwards the DOM ref for `AnimatePresence` with `mode="popLayout"`; stable exact-checkout keys preserve identity. `LayoutGroup` coordinates individual tab groups and the plus, which uses Base UI's render prop with `motion.button`. Existing tabs do not animate on load (`initial={false}`).

Tab entry and tab/plus reflow take 200ms with easing `[0.2, 0.8, 0.2, 1]`, without bounce. Groups use `layout="position"` with opacity and x: entry moves from -10px/opacity 0 to 0px/opacity 1; exit explicitly declares 140ms back to -10px/opacity 0. Reduced motion disables spatial layout projection (`layout={false}`), keeps x at 0 and uses 80ms tab fades; tab/plus reflow is immediate. No width/margin tween or manual timing queue is used.

Exiting wrappers become inert and aria-hidden immediately, and `useIsPresent` disables their tab and close controls. Feature close proceeds immediately after its existing gate; Motion retains only visual presence. It does not defer controller commands, change backend lifetime or delay Save/Discard/Cancel decisions. Shared appearance recipes and HTML/CSS previews add no animation or hover transition.

Conversation rows have two text lines: title, then working-folder basename, with a small date aligned at the right. Selected rows use the selected surface and main text; hover uses the selected-hover surface. New chat is a prominent sidebar row. Provider setup and connection identities remain secondary disclosures at the sidebar foot.

### File actions and imports

Compact SVG actions cover new file, new folder, refresh and reveal; selected-file operations stay in the footer. File-tree rows use the official file/closed-folder/open-folder icons, with the existing expansion state selecting the folder shape. The reserved disclosure column aligns names while preserving tree labels, interaction and 28px row geometry. Ignored entries remain visible with muted text and a Git-ignored accessibility description; there is no hide-ignored toggle. Selection fill, keyboard focus, active-file label and drop outline are distinct states. Sidebar-focused file paste and file drop enter the existing import destination/replacement dialog; text paste in editable fields and Monaco remains ordinary editing.

Desktop supplies clipboard/drop capabilities and does not supply `selectNativeImports`, so its sidebar has no import-picker control. Standalone Workbench keeps the optional injected picker and its shared import flow. This is a composition boundary, not a deletion of the reusable Workbench capability.

### Menus, dialogs and contained state

`overlays` supplies elevated popup/dialog surfaces, control boundaries and panel corners. Popups use the body type and a viewport-constrained width. Options use row corners and shared padding; enabled hover and focus use hover fill. Dialog and drawer backdrops use the shared translucent backdrop. Use Base UI for the existing button, tab, select, popup and drawer interactions; retain native dialog behavior where the workbench already uses it. Conflict and warning containers use the attention palette with explicit explanatory text rather than a generic decorative card pattern.

### Ownership and authoring

| Owner | Visual responsibility |
| --- | --- |
| `packages/ui` | Independent tokens and `controls`, `workbench`, `filesUI` and `overlays` recipes; named Tabler icons through a React presentation leaf |
| Desktop renderer | Main navigation, project/Agents composition, chat presentation and responsive drawer |
| Workbench | Supplied-checkout file sidebar, buffers, file tabs, editor and editor dialogs |
| Application | Supplied headless controllers and preservation behavior; no platform styling |
| Electron main | Native window chrome and injected native capabilities |
| Monaco | Internal editor CSS, theme and font through its supported JavaScript API |

Consume packages through public exports. The icon export is a React presentation leaf; tokens and style recipes remain independent of it. UI owns no application interactions or state. Compose the base StyleX recipe first, then the specific recipe and conditional state. Feature-local `stylex.create` rules own feature layout; shared controls and palette stay in UI. Use parameterized styles for measured positions and sizes, and keep shared constants in `.stylex.ts`. Name overrides for layout or meaning rather than a page, and avoid descendant overrides. Spell borders as width, style and color properties because the StyleX compiler does not emit the border shorthand. Apply styles to the actual DOM node, including portal-rendered content.

The only authored CSS file is the existing `packages/ui/reset.css`, limited to bundled `@font-face` resources, document sizing, box sizing, dark native color scheme and `[hidden]`. Add no new CSS files. Lifecycle and protocol details remain in their owning documentation; this record changes no runtime or module boundary.

## Do's and Don'ts

### Do:

- Do consume shared tokens, recipes and the named Tabler outlined icon selection through the public @moonbase/ui exports.
- Do keep the pinned Agents destination distinct from the independently scrolling project group.
- Do keep preservation and cleanup notices below MainTabs, the project scroller stationary and exiting tab controls inert.
- Do preserve accessible labels, keyboard focus, required local-tool notices and visible preservation or uncertainty controls.
- Do route desktop file paste and drop through the existing import destination and replacement flow.
- Do apply StyleX to the actual rendered element, including Base UI portals and rendered content.

### Don't:

- Don't replace the pinned neutral palette with a warmer palette or a catalog visual world.
- Don't add a separate macOS app-name titlebar, redundant Agents-sidebar branding or a visible desktop empty-chat heading.
- Don't add a desktop sidebar import-picker control; standalone Workbench may retain its optional injected picker.
- Don't conflate the Agents sidebar width with the editor controller's resizable sidebar width.
- Don't introduce new appearance CSS files, decorative shadows, glyph icons, view-specific palettes or motion beyond the approved desktop main-tab behavior.
