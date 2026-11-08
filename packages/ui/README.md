# UI

`@moonbase/ui` holds the shared StyleX design tokens, recipes and icons. The tokens are the design reference for every client.

- `@moonbase/ui/tokens.stylex`: design tokens (the Tranquility palette: silver and greys, with color reserved for meaning).
- `@moonbase/ui/controls`, `files`, `overlays`, `workbench`: style recipes.
- `@moonbase/ui/icons`: named Tabler outlined icon components.
- `@moonbase/ui/file-icons`: `findFileIcon(name)` names the monochrome `fileIcons` entry for a file by its whole name (`package.json`, `Dockerfile`, `README*`…) or extension, else `file`; `findFileTypeMark(name)` gives the short mark (TS, MD…) that stands in for an extension's icon, shared by extensions with one icon, and none for a file known by its name. `@moonbase/ui/files`'s `fileTypeMark(path)` styles it.
- `@moonbase/ui/reset.css`: shared reset.
- `@moonbase/ui/fonts.css`: bundled BlexMono Nerd Font Mono 3.5.1 (regular, italic, medium, semibold, bold), used for both `type.ui` and `type.mono`. Import it beside `reset.css` in every browser root. Its OFL licence is `fonts/LICENSE.txt`; `fonts/nerd-fonts/` holds Nerd Fonts' licence, its list of patched glyph sets and their licences, copied from Nerd Fonts v3.5.1, with `upstream/` holding the Apache-2.0 text and the licences of sets Nerd Fonts ships none for, from each project. The desktop build adds both to the dependency notices.

Consuming React components use Base UI for interaction and accessibility; state and behavior stay with the consumer. Keep text readable (at least 4.5:1 contrast) and respect reduced motion.
