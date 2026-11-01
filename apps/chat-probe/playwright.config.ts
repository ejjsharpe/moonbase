import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './test',
  testMatch: 'desktop.spec.ts',
  workers: 1,
  fullyParallel: false,
  timeout: 60000,
  use: { trace: 'retain-on-failure' },
  outputDir: './test-results',
});
