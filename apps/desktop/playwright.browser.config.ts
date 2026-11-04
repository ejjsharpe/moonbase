import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './test',
  testMatch: ['shell.spec.ts', 'transcript.spec.ts'],
  workers: 1,
  fullyParallel: false,
  use: {
    baseURL: 'http://127.0.0.1:4177',
    viewport: { width: 1600, height: 1000 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'bun run demo:browser',
    url: 'http://127.0.0.1:4177',
    reuseExistingServer: false,
    timeout: 60000,
  },
});
