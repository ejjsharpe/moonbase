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
  fullyParallel: true,
  timeout: 45000,
  reporter: [['list'], ['json', { outputFile: join(outputDir, 'timings.json') }]],
  globalTeardown: './test/fixtures/global-teardown.ts',
  use: { trace: 'retain-on-failure' },
  projects: [
    { name: 'editor', testMatch: 'desktop.spec.ts' },
    { name: 'local', testMatch: 'local-chat.spec.ts' },
    { name: 'transcripts', testMatch: 'integrated-transcript.spec.ts' },
    { name: 'configuration', testMatch: 'configuration.spec.ts' },
    { name: 'reload', testMatch: ['reload.spec.ts', 'document-lifecycle.spec.ts'] },
    { name: 'composition', testMatch: ['composition.spec.ts', 'lifecycle.spec.ts'] },
    { name: 'recovery', testMatch: 'recovery.spec.ts' },
    { name: 'packaged', testMatch: 'packaged.spec.ts' },
  ],
});
