import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, cp, mkdtemp, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The one Bun the daemon is qualified on. */
export const bunVersion = '1.4.4';
// From the release's SHASUMS256.txt, checked against the downloaded bytes.
const assets = {
  arm64: {
    name: 'bun-darwin-aarch64',
    sha256: 'c240d7f0ccb90c263a849fcdb09b7ee62630d921348ed6aafda86b9d577bc510',
  },
};
// The release ships no notices; Bun's own and the LGPL texts of the WebKit it statically links
// come from the exact tagged commit and the WebKit commit that tag pins (`WEBKIT_VERSION`).
const bunCommit = '38afee6c84fcf48c0edb2466aa4b27d287a59c30',
  webkitCommit = 'd6375c72affe0f70222cdcb45012b10f0bf3a9d5';
export const bunNotices = [
  {
    file: 'LICENSE.md',
    url: `https://raw.githubusercontent.com/oven-sh/bun/${bunCommit}/LICENSE.md`,
    sha256: '362fe32c954ec829240bd7429c53d705eef08c6bfa45ffc2d02005f857cba4dd',
  },
  {
    file: 'JavaScriptCore-COPYING.LIB',
    url: `https://raw.githubusercontent.com/oven-sh/WebKit/${webkitCommit}/Source/JavaScriptCore/COPYING.LIB`,
    sha256: '5094ecb9c9dcd0eadc34f3c11511d9b5535063032bc150164ecd1a5d5a445547',
  },
  {
    file: 'WebCore-LICENSE-LGPL-2',
    url: `https://raw.githubusercontent.com/oven-sh/WebKit/${webkitCommit}/Source/WebCore/LICENSE-LGPL-2`,
    sha256: '7555fa34bc131a75ca56d65c40cc1ea8f9515d23e353d4c15d58573a042f7805',
  },
  {
    file: 'WebCore-LICENSE-LGPL-2.1',
    url: `https://raw.githubusercontent.com/oven-sh/WebKit/${webkitCommit}/Source/WebCore/LICENSE-LGPL-2.1`,
    sha256: 'f2b3bd09663381deb99721109d22b47af1213bb43007a8b56a06c6375c8050ce',
  },
  {
    file: 'WebCore-LICENSE-APPLE',
    url: `https://raw.githubusercontent.com/oven-sh/WebKit/${webkitCommit}/Source/WebCore/LICENSE-APPLE`,
    sha256: '0b5d3a7cc325942567373b0ecd757d07c132e0ebd7c97bfc63f7e1a76094edb4',
  },
];
const defaultOutput = fileURLToPath(new URL('../dist/tools/bun/', import.meta.url));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function download(fetch, url, maxBytes, label) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  assert(response.ok, `${label} download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert(bytes.length < maxBytes, `Unexpected ${label} size`);
  return bytes;
}

/**
 * Downloads the pinned Bun runtime and its notices into a fresh cache directory, verifies every
 * file's SHA-256 before anything is unpacked or run, then replaces `output` with `bun` and the
 * notices. Any mismatch fails before `output` is touched.
 */
export async function prepareBun({
  output = defaultOutput,
  arch = process.arch,
  platform = process.platform,
  fetch = globalThis.fetch,
} = {}) {
  assert.equal(platform, 'darwin', 'The packaged daemon targets macOS.');
  const asset = assets[arch];
  assert(asset, `No qualified Bun runtime for ${arch}`);
  const cache = await mkdtemp(join(tmpdir(), 'moonbase-bun-'));
  try {
    const archiveName = `${asset.name}.zip`;
    const archive = await download(
      fetch,
      `https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/${archiveName}`,
      128 * 1024 * 1024,
      'Bun',
    );
    assert.equal(sha256(archive), asset.sha256, 'Bun release checksum mismatch');
    const notices = [];
    for (const notice of bunNotices) {
      const bytes = await download(fetch, notice.url, 1024 * 1024, notice.file);
      assert.equal(sha256(bytes), notice.sha256, `Bun notice checksum mismatch: ${notice.file}`);
      notices.push({ file: notice.file, bytes });
    }
    const archivePath = join(cache, archiveName),
      unpacked = join(cache, 'unpacked'),
      staged = join(cache, 'bun');
    await writeFile(archivePath, archive);
    // The verified archive holds exactly its folder and the executable.
    const entries = execFileSync('/usr/bin/unzip', ['-Z1', archivePath], { encoding: 'utf8' })
      .trim()
      .split('\n');
    assert.deepEqual(entries, [`${asset.name}/`, `${asset.name}/bun`], 'Unexpected Bun archive');
    execFileSync('/usr/bin/unzip', ['-q', archivePath, '-d', unpacked]);
    await mkdir(staged);
    await copyFile(join(unpacked, asset.name, 'bun'), join(staged, 'bun'));
    await chmod(join(staged, 'bun'), 0o755);
    for (const { file, bytes } of notices) await writeFile(join(staged, file), bytes);
    const reported = execFileSync(join(staged, 'bun'), ['--version'], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin' },
    }).trim();
    assert.equal(reported, bunVersion, 'Unexpected Bun executable version');
    // Moved in beside the output, so the replacement is one rename on the same volume.
    const target = output.replace(/\/$/, ''),
      partial = `${target}.partial`;
    await mkdir(dirname(target), { recursive: true });
    await rm(partial, { recursive: true, force: true });
    await cp(staged, partial, { recursive: true });
    await rm(target, { recursive: true, force: true });
    await rename(partial, target);
    return { executable: join(target, 'bun'), bytes: (await stat(join(target, 'bun'))).size };
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { executable, bytes } = await prepareBun();
  console.log(`Verified Bun ${bunVersion} (${bytes} bytes): ${executable}`);
}
