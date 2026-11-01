import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './test',
  testMatch: 'configuration.spec.ts',
  workers: 1,
  timeout: 45000,
  outputDir: process.env.MOONBASE_RELOAD_OUTPUT ?? 'test-results/configuration',
});
