import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./test", testMatch: "*.spec.ts", workers: 1, fullyParallel: false,
  use: { baseURL: "http://127.0.0.1:4176", viewport: { width: 1600, height: 1000 }, trace: "retain-on-failure" },
  webServer: { command: "bun run demo", url: "http://127.0.0.1:4176", reuseExistingServer: false, timeout: 60000 },
});
