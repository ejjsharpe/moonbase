import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './test',
  testMatch: ['reload.spec.ts', 'document-lifecycle.spec.ts'],
  workers: 1,
  timeout: 45000,
  outputDir: process.env.MOONBASE_RELOAD_OUTPUT ?? 'test-results/reload',
  use: { trace: 'off' },
});
