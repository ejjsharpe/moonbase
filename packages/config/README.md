# @moonbase/config

Shared Oxlint, Oxfmt and TypeScript settings.

Run from the repository root:

```sh
bun run lint
bun run lint:fix
bun run format
bun run format:check
```

Add `@moonbase/config` as a `workspace:*` dev dependency in consuming packages.

- `@moonbase/config/oxlint`: `base`, `node` and `web` configurations.
- `@moonbase/config/oxfmt`: formatting options.
- `@moonbase/config/typescript/base.json`: use as your `tsconfig.json`'s `extends` value; keep `include` and environment options in the consumer.
