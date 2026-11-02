import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

assert.equal(process.platform, 'darwin', 'The qualified workspace targets macOS.');
const assets = {
  arm64: {
    name: 'aarch64-apple-darwin',
    sha256: '3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4',
  },
  x64: {
    name: 'x86_64-apple-darwin',
    sha256: 'af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1',
  },
};
const asset = assets[process.arch];
assert(asset, `No qualified ripgrep asset for ${process.arch}`);
const version = '15.2.0';
const archiveName = `ripgrep-${version}-${asset.name}.tar.gz`;
const response = await fetch(
  `https://github.com/BurntSushi/ripgrep/releases/download/${version}/${archiveName}`,
  { signal: AbortSignal.timeout(60000) },
);
assert(response.ok, `ripgrep download failed: HTTP ${response.status}`);
const archive = Buffer.from(await response.arrayBuffer());
assert(archive.length < 16 * 1024 * 1024, 'Unexpected ripgrep archive size');
assert.equal(
  createHash('sha256').update(archive).digest('hex'),
  asset.sha256,
  'ripgrep release checksum mismatch',
);
const temporary = await mkdtemp(join(tmpdir(), 'moonbase-ripgrep-'));
const output = fileURLToPath(new URL('../dist/tools/ripgrep/', import.meta.url));
try {
  const archivePath = join(temporary, archiveName);
  await writeFile(archivePath, archive);
  await mkdir(output, { recursive: true });
  // The pinned archive supplies its own documentation and notices in generated output.
  execFileSync('tar', ['-xzf', archivePath, '-C', output, '--strip-components', '1']);
  for (const file of ['rg', 'COPYING', 'LICENSE-MIT', 'UNLICENSE'])
    assert((await readFile(join(output, file))).length > 0, `Missing release asset: ${file}`);
  const reported = execFileSync(join(output, 'rg'), ['--version'], { encoding: 'utf8' });
  assert(reported.startsWith(`ripgrep ${version} `), 'Unexpected ripgrep executable version');
  console.log(`Verified standalone ripgrep ${version}: ${join(output, 'rg')}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
