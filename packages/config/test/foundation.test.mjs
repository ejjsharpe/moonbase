import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));

test('Foundation verifies the archive independently of active UI', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'moonbase-foundation-'));
  try {
    cpSync(path.join(root, 'docs/source-snapshot'), path.join(directory, 'docs/source-snapshot'), {
      recursive: true,
    });
    cpSync(
      path.join(root, 'packages/application/src'),
      path.join(directory, 'packages/application/src'),
      {
        recursive: true,
      },
    );
    mkdirSync(path.join(directory, 'packages/ui'));
    writeFileSync(
      path.join(directory, 'packages/ui/controls.ts'),
      '// Active recipes may evolve.\n',
    );
    const check = () =>
      spawnSync(process.execPath, [path.join(root, 'scripts/check-foundation.mjs')], {
        cwd: directory,
        encoding: 'utf8',
        timeout: 20_000,
      });
    const independent = check();
    assert.equal(independent.status, 0, independent.stderr);
    writeFileSync(
      path.join(directory, 'docs/source-snapshot/escode/apps/desktop/src/ui/controls.ts'),
      '// Corrupt archive.\n',
    );
    const corrupt = check();
    assert.equal(corrupt.status, 1, corrupt.stderr);
    assert.match(corrupt.stderr, /apps\/desktop\/src\/ui\/controls\.ts/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
