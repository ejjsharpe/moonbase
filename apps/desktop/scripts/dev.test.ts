import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';

test('dev builds dependencies before launching with a persistent or explicit profile', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'moonbase-dev-test-'));
  try {
    for (const directory of ['scripts', 'dist', 'node_modules/electron', 'node_modules/nx/bin'])
      await mkdir(join(fixture, directory), { recursive: true });
    await writeFile(
      join(fixture, 'scripts/dev.mjs'),
      await readFile(new URL('./dev.mjs', import.meta.url)),
    );
    await writeFile(
      join(fixture, 'scripts/build.mjs'),
      `import assert from 'node:assert/strict';
      import { readFileSync } from 'node:fs';
      assert.equal(readFileSync(new URL('../dist/filesystem', import.meta.url), 'utf8'), 'helper');`,
    );
    await writeFile(
      join(fixture, 'node_modules/nx/bin/nx.js'),
      `const assert = require('node:assert/strict');
      const { resolve } = require('node:path');
      assert.deepEqual(process.argv.slice(2), ['run', '@moonbase/desktop:build']);
      assert.equal(process.cwd(), resolve(__dirname, '../../..'));
      require('node:fs').writeFileSync('dist/filesystem', 'helper');
      import(require('node:url').pathToFileURL(resolve('scripts/build.mjs')));`,
    );
    await writeFile(
      join(fixture, 'node_modules/electron/index.js'),
      'module.exports = process.execPath;',
    );
    await writeFile(
      join(fixture, 'dist/main.mjs'),
      'console.log(JSON.stringify({ userData: process.env.MOONBASE_USER_DATA, runAsNode: process.env.ELECTRON_RUN_AS_NODE }));',
    );
    const launch = async (userData?: string) => {
      await rm(join(fixture, 'dist/filesystem'), { force: true });
      // The default profile resolves under this fixture's home, never the real one.
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        HOME: fixture,
        XDG_CONFIG_HOME: join(fixture, '.config'),
        APPDATA: join(fixture, 'AppData'),
      };
      delete env.MOONBASE_USER_DATA;
      delete env.MOONBASE_DEV_MOCK;
      if (userData !== undefined) env.MOONBASE_USER_DATA = userData;
      const result = spawnSync(process.execPath, [join(fixture, 'scripts/dev.mjs')], {
        env,
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout.trim().split('\n').at(-1)!);
    };
    const first = await launch();
    const second = await launch();
    assert.ok(isAbsolute(first.userData));
    assert.ok(first.userData.startsWith(fixture + '/'));
    assert.match(first.userData, /Moonbase Dev$/);
    // Relaunching keeps the same profile, so state persists.
    assert.equal(second.userData, first.userData);
    assert.equal(first.runAsNode, undefined);
    const explicit = join(fixture, 'explicit-data');
    assert.equal((await launch(explicit)).userData, explicit);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
