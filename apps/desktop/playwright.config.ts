import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './test',
  outputDir: process.env.MOONBASE_NATIVE_OUTPUT ?? 'test-results',
  workers: 1,
  fullyParallel: false,
  timeout: 45000,
  globalTeardown: './test/global-teardown.ts',
  use: { trace: 'retain-on-failure' },
  projects: [
    { name: 'editor', testMatch: 'desktop.spec.ts' },
    { name: 'local', testMatch: 'local-chat.spec.ts' },
    { name: 'transcripts', testMatch: 'integrated-transcript.spec.ts' },
    { name: 'configuration', testMatch: 'configuration.spec.ts' },
    { name: 'reload', testMatch: ['reload.spec.ts', 'document-lifecycle.spec.ts'] },
    { name: 'composition', testMatch: ['composition.spec.ts', 'lifecycle.spec.ts'] },
    { name: 'recovery', testMatch: 'recovery.spec.ts' },
    { name: 'packaged', testMatch: 'packaged.spec.ts' },
  ],
});
