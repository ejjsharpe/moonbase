import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));

test('Foundation verifies browser-only command contracts without a source archive', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'moonbase-foundation-'));
  try {
    cpSync(
      path.join(root, 'packages/application/src'),
      path.join(directory, 'packages/application/src'),
      {
        recursive: true,
      },
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
      path.join(directory, 'packages/application/src/client.ts'),
      "export { readFile } from 'node:fs/promises';\n",
    );
    const corrupt = check();
    assert.equal(corrupt.status, 1, corrupt.stderr);
    assert.match(corrupt.stderr, /node:fs\/promises/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
