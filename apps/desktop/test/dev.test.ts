import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';

test('dev supplies fresh user data by default and preserves an explicit override', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'moonbase-dev-test-'));
  try {
    for (const directory of ['scripts', 'dist', 'node_modules/electron'])
      await mkdir(join(fixture, directory), { recursive: true });
    await writeFile(
      join(fixture, 'scripts/dev.mjs'),
      await readFile(new URL('../scripts/dev.mjs', import.meta.url)),
    );
    await writeFile(join(fixture, 'scripts/build.mjs'), '');
    await writeFile(
      join(fixture, 'node_modules/electron/index.js'),
      'module.exports = process.execPath;',
    );
    await writeFile(
      join(fixture, 'dist/main.mjs'),
      'console.log(JSON.stringify({ userData: process.env.MOONBASE_USER_DATA, runAsNode: process.env.ELECTRON_RUN_AS_NODE }));',
    );
    const launch = (userData?: string) => {
      const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', TMPDIR: fixture };
      delete env.MOONBASE_USER_DATA;
      if (userData !== undefined) env.MOONBASE_USER_DATA = userData;
      const result = spawnSync(process.execPath, [join(fixture, 'scripts/dev.mjs')], {
        env,
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout.trim().split('\n').at(-1)!);
    };
    const first = launch();
    const second = launch();
    assert.ok(isAbsolute(first.userData));
    assert.notEqual(first.userData, second.userData);
    assert.deepEqual(await readdir(first.userData), []);
    assert.equal(first.runAsNode, undefined);
    const explicit = join(fixture, 'explicit-data');
    assert.equal(launch(explicit).userData, explicit);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
