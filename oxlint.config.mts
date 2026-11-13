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
        '**/*.test.{ts,tsx,mjs}',
        'apps/desktop/src/{main,preload,shared}/**',
        'packages/{workspace,chat-runtime,daemon-protocol,ssh}/**',
      ],
    },
    {
      ...web,
      files: ['**/*.tsx', 'apps/desktop/src/renderer/**', 'packages/{workbench,ui}/**'],
    },
  ],
});
