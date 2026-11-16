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
  workers: '50%',
  // One retry on CI; a test that passes only on retry is reported as flaky.
  retries: process.env.CI ? 1 : 0,
  fullyParallel: true,
  // A run empties its output folder as it starts, so native and browser runs keep their own.
  outputDir: 'test-results/browser',
  reporter: [['list'], ['json', { outputFile: 'test-results/browser/timings.json' }]],
  use: {
    // Moonbase targets macOS; Monaco picks its keymap from the user agent, so Linux CI runs the Mac one.
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1600, height: 1000 },
    trace: 'retain-on-failure',
  },
  // The built demo: a dev server compiles each module on first request, which parallel tests race.
  webServer: {
    command: `bun run demo:browser:build && vp preview --config vite.browser.config.ts --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 120000,
  },
});
