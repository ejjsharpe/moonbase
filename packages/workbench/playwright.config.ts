import { defineConfig } from '@playwright/test';
// Worktrees running the suite side by side each pick their own demo port.
const port = Number(process.env.MOONBASE_WORKBENCH_PORT ?? 4176);
export default defineConfig({
  testDir: './test/e2e',
  testMatch: '*.spec.ts',
  workers: '50%',
  fullyParallel: true,
  reporter: [['list'], ['json', { outputFile: 'test-results/timings.json' }]],
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
    command: `bun run build && vp preview --config vite.config.ts --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 120000,
  },
});
