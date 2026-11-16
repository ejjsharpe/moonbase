import { defineConfig } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Each run keeps its temporary data, and so the daemons its apps start on it, in a folder named
// for the run: its teardown stops only those. Workers inherit the runner's folder.
if (!process.env.MOONBASE_TEST_RUN_TMPDIR) {
  const folder = join(realpathSync(tmpdir()), `moonbase-e2e-${randomBytes(4).toString('hex')}`);
  mkdirSync(folder, { mode: 0o700 });
  process.env.MOONBASE_TEST_RUN_TMPDIR = process.env.TMPDIR = folder;
}

// A run empties its output folder as it starts, so browser, source and packaged runs keep their own.
const outputDir = process.env.MOONBASE_PACKAGED_TEST
  ? 'test-results/package'
  : 'test-results/native';
export default defineConfig({
  testDir: './test/e2e',
  outputDir,
  // Electron windows share one display and the OS's focus.
  workers: 1,
  // One retry on CI; a test that passes only on retry is reported as flaky.
  retries: process.env.CI ? 1 : 0,
  fullyParallel: true,
  // Stop a failing CI run early: a test that fails after its retry is a real failure, and the rest
  // would only hold a runner.
  maxFailures: process.env.CI ? 3 : 0,
  timeout: 45000,
  reporter: [['list'], ['json', { outputFile: join(outputDir, 'timings.json') }]],
  globalTeardown: './test/fixtures/global-teardown.ts',
  use: { trace: 'retain-on-failure' },
  // `native` runs the Electron specs from source; select a subset by file or `--grep`.
  projects: [
    {
      name: 'native',
      testMatch: [
        'desktop.spec.ts',
        'local-chat.spec.ts',
        'integrated-transcript.spec.ts',
        'configuration.spec.ts',
        'reload.spec.ts',
        'document-lifecycle.spec.ts',
        'composition.spec.ts',
        'lifecycle.spec.ts',
        'recovery.spec.ts',
      ],
    },
    { name: 'packaged', testMatch: 'packaged.spec.ts' },
  ],
});
