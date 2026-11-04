# Shared UI

`@moonbase/ui` provides StyleX tokens and recipes for reuse across client interfaces. Consume its public exports:

- `@moonbase/ui/tokens.stylex` for design tokens.
- `@moonbase/ui/controls`, `@moonbase/ui/files`, `@moonbase/ui/overlays` and `@moonbase/ui/workbench` for recipes.
- `@moonbase/ui/icons` for the shared, named Tabler outlined React icon components. Consumers choose their size and stroke; only selected icons enter the bundle.
- `@moonbase/ui/reset.css` for the shared reset and bundled Manrope / SpaceMono Nerd Font Mono faces. Import it once at each browser entry point; no installed fonts or network service is required.
- `@moonbase/ui/font-notices` for the upstream font notices, which distributions must retain. Desktop appends these to its dependency notices.

Use Base UI in consuming React components for interactions and accessibility. The icon export is a React presentation leaf; tokens and recipes remain independent of it. Application state and interactions belong to consumers. Read [DESIGN.md](../../docs/DESIGN.md) when changing or consuming shared styles. The neutral charcoal palette, quiet/icon control variants and inverted Send treatment are shared across editor and Agents. Root lint and formatting checks cover these files.

Font assets live in `fonts/`: Manrope's full variable weight range (200–800), plus the regular, italic, bold and bold italic SpaceMono Nerd Font Mono faces from Nerd Fonts v3.4.0. WOFF2 conversion preserves their complete character maps, including Nerd glyphs. Pinned upstream sources and conversion details are recorded in [font provenance](docs/FONTS.md); original licenses are preserved in `fonts/NOTICES.txt`.

File-tree rows use the shared row radius for hover and selection. Their focus outline appears only while the tree has keyboard-visible focus, keeping mouse selection quiet without hiding keyboard navigation.
