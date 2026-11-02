# Shared UI

`@moonbase/ui` provides StyleX tokens and recipes for reuse across client interfaces. Consume its public exports:

- `@moonbase/ui/tokens.stylex` for design tokens.
- `@moonbase/ui/controls`, `@moonbase/ui/files`, `@moonbase/ui/overlays` and `@moonbase/ui/workbench` for recipes.
- `@moonbase/ui/reset.css` for the shared reset.

Use Base UI in consuming React components for interactions and accessibility. This package contains styling; application state and interactions belong to consumers. Read [DESIGN.md](../../docs/DESIGN.md) when changing or consuming shared styles. Root lint and formatting checks cover these files.
