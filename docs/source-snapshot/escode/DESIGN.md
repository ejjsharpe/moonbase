# escode design system

escode is a macOS workbench for editing files and working with agents. Its UI is an
**Operate** surface: keep controls familiar, content readable and state clear. Use
one dark workbench language across Agents, checkout Chats, Files and Source Control.

## Source of truth

`apps/desktop/src/ui/tokens.stylex.ts` owns the palette, spacing, typography, radii
and shared dimensions. The StyleX recipes beside it own common controls and the
workbench, chat, Files and overlay patterns. Reuse these recipes before adding a
variation. A feature may have local `stylex.create` styles for its own layout;
shared controls and colors still come from `ui/`.

The only authored CSS file is `ui/reset.css`: document sizing, box sizing, native
color scheme and `[hidden]`. Monaco owns its internal CSS; its theme and font use
the same tokens through its supported JavaScript API. Base UI owns interaction,
focus management and accessibility; StyleX owns appearance.

## Visual language

- **Surfaces:** `canvas` for editor/transcript content; `chrome` for tabs/toolbars;
  `surface` for sidebars/composers; `elevated` for menus, dialogs and ordinary buttons.
  Use `border` for structural separators and `controlBorder` for control boundaries.
- **Text:** `text` for content, `secondary` for controls and supporting text, `muted`
  for metadata. Disabled controls use the shared opacity. Keep readable text at
  least 4.5:1 against its surface; distinguish selection and errors beyond color.
- **Accent:** lavender marks focus, selection and Send. Use `selected` for selected
  rows, `selection` for selected text, `warningSurface`/`warningText` for requests
  needing attention, and `danger` for invalid input.
- **Type:** platform sans for UI; `type.mono` for code and Monaco. The scale is
  caption 11, small 12, body 13, message 15 and heading 16. Keep chat content and
  composition aligned to the same 740px maximum width.
- **Spacing:** use `space.xs/sm/md/lg/xl/xxl` (4/8/12/16/24/32). Group related
  controls tightly and separate sections. Match the established 28px file rows;
  changing their height also changes the virtualizer's geometry contract.
- **Shape:** use `radius.control` for fields/buttons, `row` for interactive rows,
  `panel` for overlays/code blocks, and `composer` for the chat field. Only compact
  icon actions such as Send are circular. Use crisp boundaries, with no decorative
  shadows or motion.

## Shared patterns

| Surface | Recipe | Behavior |
| --- | --- | --- |
| Buttons and fields | `controls.button`, `controls.field` | Same font, padding, border, disabled and keyboard-focus treatment everywhere |
| Chat navigation | `chatUI.row`, `chatUI.selectedRow` | One row structure in Agents and checkout Chats; title, context, status icon and time |
| Conversation | `chatUI.layout`, `measure`, `transcript` | Transcript owns scrolling; composer stays reachable in short windows and at 200% zoom |
| Composer | `chatUI.field`, `textarea`, `composeActions` | Same field and Send action in both chat views; context above, next-message choices below |
| Popovers | `overlays.popup`, `option`, `search` | Shared surface, radius and focus treatment, including portal-rendered content |
| File tree | `filesUI.row`, `selected`, `focused`, `drop` | Selection, keyboard focus, active file and drop target remain distinct |
| Workbench | `workbench.workspace`, `sidebar`, `viewNav` | One persisted sidebar width and common Files/Diff/Chats navigation |

## Authoring

Compose the base recipe first and the more specific recipe last:

```tsx
import * as stylex from "@stylexjs/stylex";
import { controls } from "./ui/controls";
import { chatUI } from "./ui/chat";

<Button {...stylex.props(controls.button, chatUI.send)} aria-label="Send message" />
```

Use conditional StyleX styles for state and parameterized styles for measured
positions/sizes. Put shared constants in `.stylex.ts`; StyleX compiles these and
the recipe declarations at build time. Spell borders with width, style and color
properties: the compiler does not emit the `border` shorthand. Apply styles to
the actual DOM element, including markdown renderers and Base UI portal contents.

`uiProps(hook, ...styles)` composes StyleX props while retaining existing DOM class
hooks used by navigation and tests. Those hooks have no CSS rules. Use ordinary
`stylex.props` for elements that do not need a stable hook.

## Keeping it consistent

Before adding a shared variant, find its existing uses and update all surfaces
with the same intent. A local override should describe a layout or meaning, not
the current page name. Avoid view-specific palettes and descendant overrides.

`bun run lint` checks for component stylesheets, inline style props and local hex
colors. Keep the document reset limited to its stated purpose. For UI changes,
build the app and run the relevant Electron checks; `style-system.spec.ts` checks
compiled StyleX borders, keyboard focus, portal styling and dynamic sidebar sizing.
Use the existing layout and sidebar suites for constrained windows and zoom.
Inspect the resulting screenshots as well as the assertions. Native VoiceOver
checks remain a separate manual activity.
