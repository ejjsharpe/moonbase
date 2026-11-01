import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: "./test", testMatch: process.env.MOONBASE_PACKAGED_TEST ? "packaged.spec.ts" : "desktop.spec.ts", workers: 1, fullyParallel: false, timeout: 45000, use: { trace: "retain-on-failure" } });
