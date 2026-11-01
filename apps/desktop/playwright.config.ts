import { defineConfig } from '@playwright/test';
let testMatch: string | string[] = 'desktop.spec.ts';
if (process.env.MOONBASE_COMPOSITION_TEST) testMatch = ['composition.spec.ts', 'lifecycle.spec.ts'];
else if (process.env.MOONBASE_PACKAGED_TEST) testMatch = 'packaged.spec.ts';
export default defineConfig({
  testDir: './test',
  outputDir: process.env.MOONBASE_NATIVE_OUTPUT ?? 'test-results',
  testMatch,
  workers: 1,
  fullyParallel: false,
  timeout: 45000,
  use: { trace: 'retain-on-failure' },
});
