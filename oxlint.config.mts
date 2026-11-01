import { base, node, web } from '@moonbase/code-style/oxlint';
import { defineConfig } from 'oxlint';

export default defineConfig({
  ...base,
  ignorePatterns: ['docs/source-snapshot/**', '**/dist/**', '**/release/**', '**/coverage/**'],
  overrides: [
    ...base.overrides,
    {
      ...node,
      files: [
        '**/*.config.{js,mjs,cjs,ts,mts,cts}',
        'scripts/**',
        'packages/code-style/**',
        '**/{test,tests,scripts}/**',
        'apps/desktop/src/*.{js,ts,mjs,cjs,mts,cts}',
        'packages/{workspace,pi-runtime,ssh}/**',
      ],
    },
    {
      ...web,
      files: ['**/*.tsx', 'apps/desktop/src/renderer/**', 'packages/{editor,ui}/**'],
    },
  ],
});
