import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: "./test", testMatch: "*.spec.ts", workers: 1, fullyParallel: false, timeout: 45000, use: { trace: "retain-on-failure" } });
