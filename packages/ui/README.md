# Shared UI

`@moonbase/ui` provides StyleX tokens and recipes for reuse across client interfaces. Consume its public exports:

- `@moonbase/ui/tokens.stylex` for design tokens.
- `@moonbase/ui/controls`, `@moonbase/ui/files`, `@moonbase/ui/overlays` and `@moonbase/ui/workbench` for recipes.
- `@moonbase/ui/icons` for the shared, named Tabler outlined React icon components. Consumers choose their size and stroke; only selected icons enter the bundle.
- `@moonbase/ui/reset.css` for the shared reset.

Use Base UI in consuming React components for interactions and accessibility. The icon export is a React presentation leaf; tokens and recipes remain independent of it. Application state and interactions belong to consumers. Read [DESIGN.md](../../docs/DESIGN.md) when changing or consuming shared styles. The neutral charcoal palette, quiet/icon control variants and inverted Send treatment are shared across editor and Agents. Root lint and formatting checks cover these files.

File-tree rows use the shared row radius for hover and selection. Their focus outline appears only while the tree has keyboard-visible focus, keeping mouse selection quiet without hiding keyboard navigation.

Buffer tabs use a flush, square strip with full-height dividers and an active surface joined to the breadcrumb row. Close controls reserve their space and appear on selection, hover or keyboard focus. A compact breadcrumb recipe pairs muted ancestors and slash separators with the current filename; the row stays on one line and truncates within narrow editor panes. The project-tab strip has an inset bottom separator that preserves its 40px geometry.

Base UI context menus use `overlays.positioner`, `popup`, `menuPopup`, `option` and `menuItem` for viewport-constrained positioning, rounded rows, highlighted fill and disabled text/cursors. `menuBackdrop` consumes outside dismissal clicks without activating the underlying work area. Interaction and captured mutation targets remain in Workbench.
