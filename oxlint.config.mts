import { base, node, web } from '@moonbase/config/oxlint';
import { defineConfig } from 'oxlint';

export default defineConfig({
  ...base,
  ignorePatterns: ['**/dist/**', '**/release/**', '**/coverage/**'],
  overrides: [
    {
      ...node,
      files: [
        '**/*.config.{js,mjs,cjs,ts,mts,cts}',
        'scripts/**',
        'packages/config/**',
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
