import formatting from '@moonbase/config/oxfmt' with { type: 'json' };
import { defineConfig } from 'oxfmt';

export default defineConfig({
  ...formatting,
  ignorePatterns: [
    '*.md',
    '**/dist/**',
    '**/release/**',
    '**/coverage/**',
    'bun.lock',
    '**/*.schema.json',
  ],
});
