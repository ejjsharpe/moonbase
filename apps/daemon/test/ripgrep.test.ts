import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findRipgrep } from '../src/workspace.ts';

test('a daemon finds only an executable ripgrep, in the app layout beside its bundle, else on PATH', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-daemon-ripgrep-')));
  try {
    const entry = pathToFileURL(join(root, 'daemon/daemon.mjs')),
      rg = join(root, 'workspace/ripgrep/rg'),
      onPath = join(root, 'bin/rg');
    await mkdir(join(root, 'bin'));
    await writeFile(onPath, '#!/bin/sh\n', { mode: 0o755 });
    // From source, or on a host with no app beside it: an absolute PATH folder's `rg`.
    assert.equal(findRipgrep(entry, ''), undefined);
    assert.equal(findRipgrep(entry, `bin:${join(root, 'bin')}`), onPath);
    await mkdir(rg, { recursive: true });
    assert.equal(findRipgrep(entry, ''), undefined, 'A folder is not ripgrep');
    await rm(rg, { recursive: true });
    await writeFile(rg, '#!/bin/sh\n');
    await chmod(rg, 0o644);
    assert.equal(findRipgrep(entry, ''), undefined, 'A file it cannot run is not ripgrep');
    await chmod(rg, 0o755);
    assert.equal(findRipgrep(entry, join(root, 'bin')), rg, 'The app’s own comes first');
    assert.equal(findRipgrep(entry.href, ''), rg);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
