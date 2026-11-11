import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, parse } from 'node:path';

// These npm releases omit LICENSE; pin their exact upstream commits and verify the contents.
const releaseNotices = [
  {
    packages: /^@stylexjs\/stylex@0\.19\.1$/,
    label: 'StyleX',
    url: 'https://raw.githubusercontent.com/facebook/stylex/1fcb9a51cbecad2c82255e0f4b45cc072fa1a95a/LICENSE',
    sha256: 'da6d3703ed11cbe42bd212c725957c98da23cbff1998c05fa4b3d976d1a58e93',
  },
  {
    packages: /^@earendil-works\/(?:chord|pi-ai|pi-durable|pi-codemode|pi-telemetry)@1\.4\.0$/,
    label: 'Pi',
    url: 'https://raw.githubusercontent.com/earendil-works/pi/4a080252f06caf63a525d7873c5d94d3c23887e0/LICENSE',
    sha256: '0457f5bcec3b3b211605dfb5d1a49042fd638f3686a410fe099c24a25af13c48',
  },
  {
    packages: /^standardwebhooks@1\.1\.1$/,
    label: 'Standard Webhooks',
    url: 'https://raw.githubusercontent.com/standard-webhooks/standard-webhooks/b4d2c14fc5b4ccff3ff271e3b087dff812254c59/LICENSE',
    sha256: 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4',
  },
];
// First-party modules that bundle upstream assets, whose own release notices are kept beside them.
const fonts = new URL('../packages/ui/fonts/', import.meta.url);
const assetNotices = [
  {
    inputs: /(?:^|\/)packages\/ui\/fonts\.css$/,
    label: 'BlexMono Nerd Font Mono 3.5.1 (IBM Plex Mono patched by Nerd Fonts)',
    license: 'OFL-1.1',
    directory: fonts,
    files: ['LICENSE.txt'],
  },
  {
    // The patched fonts add Nerd Fonts' glyph sets: its README lists each set's upstream and licence.
    // `glyphs/` comes from Nerd Fonts; `upstream/` from sets it ships no licence for, and Apache-2.0.
    inputs: /(?:^|\/)packages\/ui\/fonts\.css$/,
    label: 'Nerd Fonts 3.5.1 patched glyphs in BlexMono Nerd Font Mono',
    license: 'MIT AND OFL-1.1 AND CC-BY-4.0 AND Apache-2.0 AND Unlicense',
    directory: new URL('nerd-fonts/', fonts),
    files: [
      'LICENSE',
      'README.md',
      'glyphs/codicons/LICENSE.txt',
      'glyphs/font-awesome/LICENSE.txt',
      'glyphs/materialdesign/LICENSE',
      'glyphs/octicons/LICENSE',
      'glyphs/pomicons/LICENSE',
      'glyphs/powerline-extra/LICENSE',
      'glyphs/powerline-symbols/LICENSE.txt',
      'glyphs/weather-icons/OFL.txt',
      'upstream/apache/LICENSE-2.0.txt',
      'upstream/devicon/LICENSE',
      'upstream/font-awesome-extension/LICENCE',
      'upstream/font-logos/LICENSE',
      'upstream/hack/LICENSE.md',
      'upstream/seti-ui/LICENSE.md',
      'upstream/unicode-iec/LICENSE.txt',
    ],
  },
];
async function downloadNotice({ label, url, sha256 }) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw Error(label + ' release notice unavailable');
  const text = await response.text();
  if (createHash('sha256').update(text).digest('hex') !== sha256)
    throw Error(label + ' release notice checksum mismatch');
  return url + '\n' + text;
}

/**
 * Collect actual upstream package files from bundled inputs; never maintain a copied source notice
 * bundle. `components` adds shipped upstream components that are not packages, such as a runtime,
 * each as `{label, license, directory, files}` with the notice files it ships.
 */
export async function notices(inputs, output, components = []) {
  const packages = new Map();
  for (const input of inputs) {
    if (!input.includes('node_modules')) continue;
    let directory = dirname(input.replace(/\?.*$/, ''));
    while (directory !== parse(directory).root) {
      try {
        const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
        if (manifest.name && manifest.version) {
          packages.set(manifest.name + '@' + manifest.version, { directory, manifest });
          break;
        }
      } catch {}
      directory = dirname(directory);
    }
  }
  const sections = [];
  for (const [name, { directory, manifest }] of [...packages].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (name.startsWith('@moonbase/')) continue;
    const files = (await readdir(directory, { withFileTypes: true })).filter(
      (f) => f.isFile() && /^(licen[sc]e|copying|notice|third.?party)/i.test(f.name),
    );
    let texts = await Promise.all(
      files.map(
        async (file) =>
          '\n' + file.name + '\n' + (await readFile(join(directory, file.name), 'utf8')),
      ),
    );
    if (!texts.length && name === 'data-uri-to-buffer@4.0.1') {
      const readme = await readFile(join(directory, 'README.md'), 'utf8');
      const start = readme.indexOf('\nLicense\n-------');
      if (start < 0) throw Error('Bundled data-uri-to-buffer license section unavailable');
      texts = ['README.md' + readme.slice(start)];
    }
    if (!texts.length) {
      const release = releaseNotices.find((release) => release.packages.test(name));
      if (release) texts = [await downloadNotice(release)];
    }
    if (!texts.length) throw Error('No package/release-provided notice found for bundled ' + name);
    sections.push(
      name +
        ' (' +
        JSON.stringify(manifest.license ?? 'See package notices') +
        ')\n' +
        texts.join('\n'),
    );
  }
  for (const asset of assetNotices)
    if (inputs.some((input) => asset.inputs.test(input.replace(/\?.*$/, ''))))
      sections.push(
        asset.label +
          ' (' +
          JSON.stringify(asset.license) +
          ')\n' +
          (
            await Promise.all(
              asset.files.map(
                async (file) =>
                  '\n' + file + '\n' + (await readFile(new URL(file, asset.directory), 'utf8')),
              ),
            )
          ).join('\n'),
      );
  for (const component of components)
    sections.push(
      component.label +
        ' (' +
        JSON.stringify(component.license) +
        ')\n' +
        (
          await Promise.all(
            component.files.map(
              async (file) =>
                '\n' + file + '\n' + (await readFile(join(component.directory, file), 'utf8')),
            ),
          )
        ).join('\n'),
    );
  await writeFile(output, sections.join('\n\n========================================\n\n'));
  return [...packages.keys()].sort();
}
