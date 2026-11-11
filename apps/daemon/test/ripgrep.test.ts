import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findBundledRipgrep } from '../src/ripgrep.ts';

test('a daemon bundle finds only an executable ripgrep in the app layout beside it', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-daemon-ripgrep-')));
  try {
    const entry = pathToFileURL(join(root, 'daemon/daemon.mjs')),
      rg = join(root, 'workspace/ripgrep/rg');
    // From source, or on a host with no app beside it: file search uses PATH.
    assert.equal(findBundledRipgrep(entry), undefined);
    await mkdir(rg, { recursive: true });
    assert.equal(findBundledRipgrep(entry), undefined, 'A folder is not ripgrep');
    await rm(rg, { recursive: true });
    await writeFile(rg, '#!/bin/sh\n');
    await chmod(rg, 0o644);
    assert.equal(findBundledRipgrep(entry), undefined, 'A file it cannot run is not ripgrep');
    await chmod(rg, 0o755);
    assert.equal(findBundledRipgrep(entry), rg);
    assert.equal(findBundledRipgrep(entry.href), rg);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
