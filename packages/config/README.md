# Moonbase configuration

Shared Oxlint, Oxfmt and TypeScript configuration for the Bun/Nx monorepo. Root config files select the Electron Node/main/preload and React/browser scopes; packages inherit them automatically when running `oxlint .` from their own directory.

```sh
bun run lint
bun run lint:fix
bun run format
bun run format:check
bun run test
```

`oxlint.mjs` exports `base` (Universe default), `node` and `web` (override fragments to combine with `base`). `oxfmt.json` exports formatting options. Add platform paths to the root `oxlint.config.mts` as packages arrive. Keep privileged Electron globals out of renderer overrides; TypeScript still owns undefined-name checks in TS/TSX, as in Universe.

## TypeScript

The existing shared compiler settings live in `typescript/base.json`. Consumer packages declare `@moonbase/config` as a workspace dev dependency and extend the exported subpath:

```json
{
  "extends": "@moonbase/config/typescript/base.json",
  "compilerOptions": { "types": ["node"] },
  "include": ["src", "test"]
}
```

Each package keeps its own input files and environment-specific options. Root `tsconfig.base.json` forwards to this same base so other branches can keep their existing relative extends paths. Compiler behavior is unchanged; separate Node/browser presets can be introduced when consumers need them.

## Universe migration

Based on Expo's legacy `default.js`, `node.js`, `web.js` and their shared configs at [e180d5676641699581298683ba7854c8b0d36771](https://github.com/expo/expo/tree/e180d5676641699581298683ba7854c8b0d36771/packages/eslint-config-universe). The copied/adapted configuration retains Expo's MIT notice in `LICENSE`.

- Preserve explicit rule severities and options, including warnings, smart equality, unused-argument allowances, import grouping/alphabetization, declaration-file import-order exemption and disabled exhaustive hook dependencies. Oxlint's default correctness category is disabled so it does not add unrelated rules.
- Use native Oxlint rules where available. TypeScript-aware core implementations replace the five `@typescript-eslint` extensions of core rules. `no-new-symbol` maps to `eslint/no-new-native-nonconstructor`, which also rejects `new BigInt()`.
- Load `eslint-plugin-import` for `import/order` and `eslint-plugin-react` for `jsx-no-bind` and `no-access-state-in-setstate`, through aliases that avoid the native plugin namespaces. These run inside Oxlint, with no ESLint command or ESLint config.
- `compat.mjs` exposes ESLint's existing `no-buffer-constructor` rule: Oxlint's `unicorn/no-new-buffer` only catches `new Buffer()`, missing `Buffer()`. ESLint 9 is pinned as a compatibility dependency (also required by the React plugin's peer range), not used as the lint runner. No Prettier package/plugin is installed.
- The same compatibility plugin preserves duplicate-parameter and legacy-octal checks for sloppy CommonJS, where these are not parser errors. JSX variable usage is tracked by Oxlint, replacing `jsx-uses-react`/`jsx-uses-vars` bookkeeping rules. Parser errors can have stronger severity than the old warnings.
- Formatting rules disabled by Universe's `eslint-config-prettier@9` remain outside the linter. Standalone Oxfmt uses Universe's documented `.prettierrc`: width 100, two spaces, single quotes, same-line JSX brackets, plus Prettier 3's trailing commas. Package JSON/import sorting is not added; import order remains a lint rule.
- Universe's separate optional type-aware analysis preset, React Native preset and newer flat-config additions are outside this Electron default/node/web migration. Typechecking remains a separate Nx target.

Root `bun run lint` checks the entire repository once; the existing application Nx lint target also runs Oxlint. CI separately checks formatting and runs the config behavior test through Nx. Shared config changes invalidate the relevant Nx caches.

Source snapshots and their exact active UI copies remain unchanged. Oxfmt excludes `packages/ui` because `check:foundation` compares those files byte-for-byte with the immutable source snapshot; remove that exclusion when the provenance check permits formatting changes. Existing documentation is excluded from this code-formatting adoption.

JS plugins and JS/TS configuration are experimental in Oxlint. The behavior test covers native rules, plugin loading/import ordering, Node versus browser globals, hooks, both Buffer constructor forms, declaration files, snapshot exclusion and formatting. It runs locally without network access.
