import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './test/e2e',
  testMatch: '*.spec.ts',
  workers: 1,
  fullyParallel: false,
  use: {
    // Moonbase targets macOS; Monaco picks its keymap from the user agent, so Linux CI runs the Mac one.
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    baseURL: 'http://127.0.0.1:4176',
    viewport: { width: 1600, height: 1000 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'bun run demo',
    url: 'http://127.0.0.1:4176',
    reuseExistingServer: false,
    timeout: 60000,
  },
});
