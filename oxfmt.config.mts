import formatting from '@moonbase/config/oxfmt' with { type: 'json' };
import { defineConfig } from 'oxfmt';

export default defineConfig({
  ...formatting,
  ignorePatterns: ['docs/**', '*.md', '**/dist/**', '**/release/**', '**/coverage/**', 'bun.lock'],
});
