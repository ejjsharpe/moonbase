import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));

test('Foundation verifies browser-only command contracts and headless chat without a source archive', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'moonbase-foundation-'));
  try {
    mkdirSync(path.join(directory, 'node_modules/@moonbase'), { recursive: true });
    for (const name of ['application', 'chat']) {
      const target = path.join(directory, 'packages', name);
      cpSync(path.join(root, 'packages', name, 'src'), path.join(target, 'src'), {
        recursive: true,
      });
      cpSync(path.join(root, 'packages', name, 'package.json'), path.join(target, 'package.json'));
      symlinkSync(target, path.join(directory, 'node_modules/@moonbase', name));
    }
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
