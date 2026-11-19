# UI

`@moonbase/ui` holds the shared StyleX design tokens, style recipes, icons and fonts. The tokens are the design reference for every client. It holds no components with state or behaviour: consumers use Base UI for interaction and accessibility and keep state themselves.

| Export | Gives |
| --- | --- |
| `./tokens.stylex` | Design tokens: the Tranquility palette (silver and greys, colour reserved for meaning), project hues, Git status and syntax colours, spacing, type, radius and shadow |
| `./controls`, `./files`, `./overlays`, `./projects`, `./spinner`, `./workbench` | Style recipes (`./files` also has `fileTypeMark(path)`; `./projects` has project initials and hues) |
| `./icons` | Named Tabler outlined icons and `Icon` |
| `./file-icons` | `fileIcons`, `FileIcon`, `findFileIcon(name)` (by whole name or extension, else `file`) and `findFileTypeMark(name)` (the short mark, such as TS, that stands in for an extension's icon) |
| `./reset.css`, `./fonts.css` | The shared reset, and the bundled BlexMono Nerd Font Mono used for both `type.ui` and `type.mono`; import both in every browser root |

Font licences sit in `fonts/` (`LICENSE.txt`, and Nerd Fonts' in `fonts/nerd-fonts/`); the desktop build adds them to its dependency notices. Keep text readable (at least 4.5:1 contrast) and respect reduced motion.

`bun run --cwd packages/ui test` checks how file names match the icon tables.
