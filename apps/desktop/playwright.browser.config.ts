import { defineConfig } from '@playwright/test';
const port = Number(process.env.MOONBASE_BROWSER_PORT ?? 4177);
export default defineConfig({
  testDir: './test/e2e',
  testMatch: [
    'shell.spec.ts',
    'folders.spec.ts',
    'transcript.spec.ts',
    'activity.spec.ts',
    'activity-selection.spec.ts',
    'stored-image.spec.ts',
  ],
  workers: 1,
  fullyParallel: false,
  use: {
    // Moonbase targets macOS; Monaco picks its keymap from the user agent, so Linux CI runs the Mac one.
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1600, height: 1000 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `bun run demo:browser --port ${port}`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 60000,
  },
});
