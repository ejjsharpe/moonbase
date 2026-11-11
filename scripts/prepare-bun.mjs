import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmod,
  copyFile,
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bunPackages,
  collectPackageNotices,
  download,
  packageNoticeFile,
  sha256,
  writePackageNotices,
} from './bun-packages.mjs';

/** The one Bun the daemon is qualified on. */
export const bunVersion = '1.4.4';
// From the release's SHASUMS256.txt, checked against the downloaded bytes, and the executable the
// verified archive holds, checked again wherever a build or package uses it.
const assets = {
  arm64: {
    name: 'bun-darwin-aarch64',
    sha256: 'c240d7f0ccb90c263a849fcdb09b7ee62630d921348ed6aafda86b9d577bc510',
    executableSha256: '0a2237cdcfa0d16ef501d9acca9f0026309ef348bea7393a64e8d1e3609565cc',
  },
};
export const bunExecutableSha256 = assets.arm64.executableSha256;

// The release ships no notices. These are the components Bun's LICENSE.md names that its
// `bun-v1.4.4` tag pins, each from that exact commit: Bun's own files at the tagged commit, WebKit
// at its `WEBKIT_VERSION`, each C/C++ library at the commit its `scripts/build/deps/*.ts` pins, and
// code the licence names at a fixed revision. macOS Bun uses the system ICU and SQLite, and libuv
// only on Windows, so their notices don't apply. Bun's licence also lists libbase64 and uucode,
// which the tagged source no longer uses. The crates and polyfill packages in Bun's lockfiles come
// from `bun-packages.mjs`. Code Bun ports from other projects (esbuild, typescript-go, ESLint,
// Prettier, oxc, Biome, PostCSS and the others its licence lists) and the polyfills it vendors
// outside its lockfile are pinned by no revision in the tag, so only LICENSE.md names them.
const bunCommit = '38afee6c84fcf48c0edb2466aa4b27d287a59c30',
  webkitCommit = 'd6375c72affe0f70222cdcb45012b10f0bf3a9d5';
const raw = (repository, commit, path) =>
  `https://raw.githubusercontent.com/${repository}/${commit}/${path}`;
const library = (name, license, repository, commit, files) => ({
  label: `${name}, statically linked by Bun ${bunVersion} (${repository}@${commit.slice(0, 12)})`,
  license,
  notices: Object.entries(files).map(([path, sha256]) => ({
    file: `notices/${name}-${path.split('/').at(-1)}`,
    url: raw(repository, commit, path),
    sha256,
  })),
});
/**
 * The packaged runtime's components and the notice files each ships, as `{label, license,
 * notices: [{file, url, sha256}]}`. Where a library offers a choice, the license names the one
 * Moonbase takes.
 */
export const bunComponents = [
  {
    label: `Bun ${bunVersion} runtime`,
    license: 'MIT',
    notices: [
      {
        file: 'LICENSE.md',
        url: raw('oven-sh/bun', bunCommit, 'LICENSE.md'),
        sha256: '362fe32c954ec829240bd7429c53d705eef08c6bfa45ffc2d02005f857cba4dd',
      },
    ],
  },
  {
    label: `JavaScriptCore and WebCore from WebKit, statically linked by Bun ${bunVersion} (oven-sh/WebKit@${webkitCommit.slice(0, 12)})`,
    license: 'LGPL-2.0-or-later AND LGPL-2.1-or-later AND BSD-2-Clause',
    notices: [
      {
        file: 'JavaScriptCore-COPYING.LIB',
        url: raw('oven-sh/WebKit', webkitCommit, 'Source/JavaScriptCore/COPYING.LIB'),
        sha256: '5094ecb9c9dcd0eadc34f3c11511d9b5535063032bc150164ecd1a5d5a445547',
      },
      {
        file: 'WebCore-LICENSE-LGPL-2',
        url: raw('oven-sh/WebKit', webkitCommit, 'Source/WebCore/LICENSE-LGPL-2'),
        sha256: '7555fa34bc131a75ca56d65c40cc1ea8f9515d23e353d4c15d58573a042f7805',
      },
      {
        file: 'WebCore-LICENSE-LGPL-2.1',
        url: raw('oven-sh/WebKit', webkitCommit, 'Source/WebCore/LICENSE-LGPL-2.1'),
        sha256: 'f2b3bd09663381deb99721109d22b47af1213bb43007a8b56a06c6375c8050ce',
      },
      {
        file: 'WebCore-LICENSE-APPLE',
        url: raw('oven-sh/WebKit', webkitCommit, 'Source/WebCore/LICENSE-APPLE'),
        sha256: '0b5d3a7cc325942567373b0ecd757d07c132e0ebd7c97bfc63f7e1a76094edb4',
      },
    ],
  },
  library('simdutf', 'MIT', 'oven-sh/WebKit', webkitCommit, {
    'Source/WTF/wtf/simdutf/LICENSE-simdutf.txt':
      'fc8dbc04e03ad4efc08a647ffe7f995b811a95bc04c0e85a56d5277c6593fa5f',
  }),
  library('uSockets', 'Apache-2.0', 'oven-sh/bun', bunCommit, {
    'packages/bun-usockets/LICENSE':
      'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4',
  }),
  library('uWebSockets', 'Apache-2.0', 'oven-sh/bun', bunCommit, {
    'packages/bun-uws/LICENSE': 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4',
  }),
  library(
    'boringssl',
    'Apache-2.0',
    'oven-sh/boringssl',
    '41bf9b59c2ebf277a7aa427e1ecad5cc80dd4d4f',
    {
      LICENSE: '827c8d8fc207c2392794eef9e00fe246f9f61fdcc132556c275be3dd8c3cd97f',
    },
  ),
  library('brotli', 'MIT', 'google/brotli', 'db24a98aed38a16de78cc05ca15cdd8dc2a0d92d', {
    LICENSE: '3d180008e36922a4e8daec11c34c7af264fed5962d07924aea928c38e8663c94',
  }),
  library('c-ares', 'MIT', 'c-ares/c-ares', 'c7a3138dcfe3bb0eaaf10c0c24c36dc66dc790ab', {
    'LICENSE.md': '460f5e768fda3752ca2169a95df062578a10fb126bfd65f3b9b1a1bed2f84807',
  }),
  library(
    'HdrHistogram_c',
    'BSD-2-Clause',
    'HdrHistogram/HdrHistogram_c',
    '18c7a324383dded1451d15621cd018b0048057d0',
    { 'LICENSE.txt': '93a583ec58cd981232ec6fab797ff6f17f350c97b83ae0700b2d9350c91028af' },
  ),
  library('highway', 'Apache-2.0', 'google/highway', '2607d3b5b0113992fe84d3848859eae13b3b52c1', {
    LICENSE: 'e340270d4f64384569a91d546acb5b094d69ce47f0c015db77abb74dc6f815af',
  }),
  library(
    'libarchive',
    'BSD-2-Clause AND Apache-2.0',
    'libarchive/libarchive',
    '27cbc7827172698143e440801fc0ba39ccb4f1f5',
    { COPYING: '30e556b3959e3985d66efefec5eaac51d4995053caa1d3cffe6eb916f146f229' },
  ),
  library('libdeflate', 'MIT', 'ebiggers/libdeflate', '92e6a0db9fa848d742f9eb286c92afc60f2c3dda', {
    COPYING: '4ad69099cb4374836fd27583d9991e2838cd86b6e4666ab26b2d32582c91e73a',
  }),
  library(
    'libjpeg-turbo',
    'IJG AND BSD-3-Clause AND Zlib',
    'libjpeg-turbo/libjpeg-turbo',
    'c85e6b905bf237038faa936dab160ebfc5da0344',
    {
      'LICENSE.md': 'ba6bceebcba0fdd35488477c2cca8c4632ce82c74dbfbc87d886ce6fc4433579',
      'README.ijg': '75815e3bf6484201a3c3d17a1bbf10f2e8e3237f84df10a2357ea896db2a81d6',
    },
  ),
  library(
    'libspng',
    'BSD-2-Clause',
    'randy408/libspng',
    'fb768002d4288590083a476af628e51c3f1d47cd',
    {
      LICENSE: '0622b0794d0fecde47d743f1bb70a03e6fdf082be8e71f39de672ed995d96ff9',
    },
  ),
  // Bun pins the v1.6.0 tag object; this is the commit it tags.
  library(
    'libwebp',
    'BSD-3-Clause',
    'webmproject/libwebp',
    '4fa21912338357f89e4fd51cf2368325b59e9bd9',
    { COPYING: '5aec868f669e384a22372a4e8a1a6cd7d44c64cd451f960ca69cc170d1e13acf' },
  ),
  library(
    'lol-html',
    'BSD-3-Clause',
    'oven-sh/lol-html',
    '725ce499aa9b71e38b7a2d0a9fbb6d7294a4079e',
    {
      LICENSE: 'e4ddaa9d7391bb9536fcb8c59b570a8b85a0bf6da54df5b3b26f098f6f99c9cc',
    },
  ),
  library('ls-hpack', 'MIT', 'litespeedtech/ls-hpack', 'cf0f70dd10b352194c97448eb5d00b4aa484f531', {
    LICENSE: '0490f9666828ad1b6b5503102e7ebbe491451b7174511f3b6255caa967caf955',
  }),
  library('ls-qpack', 'MIT', 'litespeedtech/ls-qpack', '91567706c41c0d97ab8dc576873ecd472d7869fa', {
    LICENSE: 'bf66df64b9819a4f2b7093332e35111f16a1c013180b2c30dd456f682a9c63fd',
  }),
  library(
    'lsquic',
    'MIT AND BSD-3-Clause',
    'litespeedtech/lsquic',
    'f812ceb9529e26717df78c6064a2ff648b949f3e',
    {
      LICENSE: '9bc22643b3ea2b55c547c83e332253d04ba3df4f26696091e6fa9f7a1ccc65ef',
      'LICENSE.chrome': '85d5dcb0d30ea89fa5922451957ff2a1a2c3c24f1ad2bb9ab23b5d6080763fc9',
    },
  ),
  library('mimalloc', 'MIT', 'oven-sh/mimalloc', '92ef6587c57b262f6e6abf513f7776a2f8d12aeb', {
    LICENSE: '82ade5d7d9b029044b5fbbc326207fc47c2d44ee4dd71e8a559c36d728217de9',
  }),
  // The repository has no licence file; its header carries the licence.
  library(
    'picohttpparser',
    'MIT',
    'h2o/picohttpparser',
    'f4d94b48b31e0abae029ebeafcfd9ca0680ede58',
    {
      'picohttpparser.h': '1fc9074dd12418b2b91e55ef3a8279bccf8d3577b790dea6f2f908ab2a157f1c',
    },
  ),
  library(
    'rust-argon2',
    'MIT',
    'sru-systems/rust-argon2',
    'ed81866f163f0c7026aa6fd8388adf37242eb32a',
    { 'LICENSE-MIT': '26b997d1a1496df49cb1ad2cbe024714cd9126543c18e1bc6c7bbca1b3dc42b6' },
  ),
  library(
    'tinycc',
    'LGPL-2.1-or-later',
    'oven-sh/tinycc',
    '05f0fafaa3be31e31d7b4b5c17dc60f62c991171',
    { COPYING: '512d2d21b6b3384ba64781abb0208a1b87740bc31e2df48e2b206ddb7e4d5779' },
  ),
  library('zlib-ng', 'Zlib', 'zlib-ng/zlib-ng', '12731092979c6d07f42da27da673a9f6c7b13586', {
    'LICENSE.md': '6c9f0d975b41afaa34d22f55bb8986ce69e5cb7ad327cb2b28820cd425edf5ee',
  }),
  library('zstd', 'BSD-3-Clause', 'facebook/zstd', 'f8745da6ff1ad1e7bab384bd1f9d742439278e99', {
    LICENSE: '7055266497633c9025b777c78eb7235af13922117480ed5c674677adc381c9d8',
  }),
  // Code Bun's licence names at a fixed revision.
  library(
    'tigerbeetle',
    'Apache-2.0',
    'tigerbeetle/tigerbeetle',
    '532c8b70b9142c17e07737ab6d3da68d7500cbca',
    { LICENSE: '0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594' },
  ),
  // The llvmorg-19.1.0 tag Bun's licence names.
  library(
    'libcxxabi',
    'Apache-2.0 WITH LLVM-exception',
    'llvm/llvm-project',
    'a4bf6cd7cfb1a1421ba92bca9d017b49936c55e4',
    { 'libcxxabi/LICENSE.TXT': 'e2b35be49f7284a45b7baca8fc7b3ab7440e7902392b2528a457816b5bb2a15c' },
  ),
  // Bun's argument parser, a port of zig-clap whose licence the tag keeps beside it.
  library('clap', 'Unlicense', 'oven-sh/bun', bunCommit, {
    'src/clap/LICENSE': '88d9b4eb60579c191ec391ca04c16130572d7eedc4a86daa58bf28c6e14c9bcd',
  }),
];
/** The notices downloaded one by one from their pinned commits. */
export const bunNotices = bunComponents.flatMap((component) => component.notices);
/** Every package in Bun's lockfiles, with the licence files its verified archive holds. */
for (const pkg of bunPackages)
  bunComponents.push({
    label:
      pkg.ecosystem === 'crates'
        ? `${pkg.name} ${pkg.version}, a crates.io crate in Bun ${bunVersion}'s Cargo.lock`
        : `${pkg.name} ${pkg.version}, an npm package in the lockfile of the Node.js polyfills Bun ${bunVersion} embeds`,
    license: pkg.license,
    notices: pkg.files.map(({ path, sha256 }) => ({ file: packageNoticeFile(pkg, path), sha256 })),
  });
const allNotices = bunComponents.flatMap((component) => component.notices);

const defaultOutput = fileURLToPath(new URL('../dist/tools/bun/', import.meta.url));

/**
 * Refuses a prepared runtime folder whose `bun` or any notice differs from the pinned bytes, as a
 * build that stages it or a package check finds it.
 */
export async function verifyBunRuntime(directory, executableSha256 = bunExecutableSha256) {
  assert.equal(
    sha256(await readFile(join(directory, 'bun'))),
    executableSha256,
    'Bun executable checksum mismatch',
  );
  for (const notice of allNotices)
    assert.equal(
      sha256(await readFile(join(directory, notice.file))),
      notice.sha256,
      `Bun notice checksum mismatch: ${notice.file}`,
    );
}

/**
 * Downloads the pinned Bun runtime and its notices into a fresh cache directory under
 * `temporaryDirectory`. The archive's SHA-256 is verified before it is unpacked, and the
 * executable's, every notice's and every package archive's before Bun first runs; only then is `output` replaced with `bun`
 * and the notices. Any mismatch fails before `output` is touched.
 * `asset` replaces the pinned release, for tests only.
 */
export async function prepareBun({
  output = defaultOutput,
  arch = process.arch,
  platform = process.platform,
  fetch = globalThis.fetch,
  temporaryDirectory = tmpdir(),
  asset = assets[arch],
} = {}) {
  assert.equal(platform, 'darwin', 'The packaged daemon targets macOS.');
  assert(asset, `No qualified Bun runtime for ${arch}`);
  const cache = await mkdtemp(join(temporaryDirectory, 'moonbase-bun-'));
  try {
    const archiveName = `${asset.name}.zip`;
    const archive = await download(
      fetch,
      `https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/${archiveName}`,
      128 * 1024 * 1024,
      'Bun',
    );
    assert.equal(sha256(archive), asset.sha256, 'Bun release checksum mismatch');
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
    await mkdir(join(staged, 'notices'), { recursive: true });
    await copyFile(join(unpacked, asset.name, 'bun'), join(staged, 'bun'));
    await chmod(join(staged, 'bun'), 0o755);
    assert.equal(
      sha256(await readFile(join(staged, 'bun'))),
      asset.executableSha256,
      'Bun executable checksum mismatch',
    );
    for (const notice of bunNotices) {
      const bytes = await download(fetch, notice.url, 1024 * 1024, notice.file);
      assert.equal(sha256(bytes), notice.sha256, `Bun notice checksum mismatch: ${notice.file}`);
      await writeFile(join(staged, notice.file), bytes);
    }
    // Each package archive is checked against its lockfile and each licence against the manifest.
    await writePackageNotices(
      staged,
      await collectPackageNotices({ fetch, packages: bunPackages }),
    );
    // The same check every build and package check that uses the runtime makes.
    await verifyBunRuntime(staged, asset.executableSha256);
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
