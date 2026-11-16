import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkMacosTests } from './macos-tests.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

test('Foundation verifies browser-only command contracts and headless models without a source archive', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'moonbase-foundation-'));
  try {
    mkdirSync(path.join(directory, 'node_modules/@moonbase'), { recursive: true });
    for (const name of ['application', 'contracts', 'effect', 'workbench']) {
      const target = path.join(directory, 'packages', name);
      cpSync(path.join(root, 'packages', name, 'src'), path.join(target, 'src'), {
        recursive: true,
      });
      cpSync(path.join(root, 'packages', name, 'package.json'), path.join(target, 'package.json'));
      symlinkSync(target, path.join(directory, 'node_modules/@moonbase', name));
    }
    symlinkSync(
      path.join(root, 'node_modules/effect'),
      path.join(directory, 'node_modules/effect'),
    );
    symlinkSync(
      path.join(root, 'packages/application/node_modules/lru-cache'),
      path.join(directory, 'node_modules/lru-cache'),
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
      path.join(directory, 'packages/contracts/src/workspace.ts'),
      "export { readFile } from 'node:fs/promises';\n",
    );
    const corrupt = check();
    assert.equal(corrupt.status, 1, corrupt.stderr);
    assert.match(corrupt.stderr, /node:fs\/promises/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a macOS-only test is split out by tag and scripts, never skipped by platform', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'moonbase-macos-tests-'));
  try {
    const write = (file, text) => {
      mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
      writeFileSync(path.join(directory, file), text);
    };
    const manifest = (scripts, tags) => JSON.stringify({ scripts, ...(tags && { nx: { tags } }) });
    write('apps/.keep', '');
    write(
      'packages/split/package.json',
      manifest({ test: 't', 'test:linux': 'l', 'test:macos': 'm' }, ['macos-tests']),
    );
    write('packages/split/test/macos/keychain.test.ts', "if (process.platform === 'darwin') {}");
    write(
      'packages/whole/package.json',
      manifest({ test: 't', 'test:macos': 'm' }, ['macos-tests']),
    );
    write('packages/portable/package.json', manifest({ test: 't' }));
    write('packages/portable/test/e2e/keys.spec.ts', 'process.platform');
    assert.deepEqual(checkMacosTests(directory), []);
    write('packages/portable/test/macos/keychain.test.ts', '');
    write(
      'packages/portable/test/files.test.ts',
      "test('rg', { skip: process.platform !== 'darwin' });",
    );
    // The missing tag, the missing test:linux and the platform skip, each named by where it is.
    assert.deepEqual(
      checkMacosTests(directory).map((error) => error.split(' ')[0]),
      ['packages/portable', 'packages/portable', 'packages/portable/test/files.test.ts'],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
