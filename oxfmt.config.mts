import formatting from '@moonbase/code-style/oxfmt' with { type: 'json' };
import { defineConfig } from 'oxfmt';

export default defineConfig({
  ...formatting,
  ignorePatterns: [
    'docs/**',
    '*.md',
    // shortcut: these copies must match the frozen snapshot byte-for-byte, remove after the provenance check changes.
    'packages/ui/**',
    '**/dist/**',
    '**/release/**',
    '**/coverage/**',
    'bun.lock',
  ],
});
