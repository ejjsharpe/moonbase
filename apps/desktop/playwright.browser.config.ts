import { defineConfig } from '@playwright/test';
const port = Number(process.env.MOONBASE_BROWSER_PORT ?? 4177);
export default defineConfig({
  testDir: './test',
  testMatch: ['shell.spec.ts', 'transcript.spec.ts', 'activity.spec.ts'],
  workers: 1,
  fullyParallel: false,
  use: {
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
