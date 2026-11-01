import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, parse } from 'node:path';
/** Collect actual upstream package files from bundled inputs; never maintain a copied source notice bundle. */
export async function notices(inputs, output) {
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
    if (!texts.length && name === '@stylexjs/stylex@0.19.1') {
      // This npm release omits LICENSE; use its exact upstream release commit, verified at build time.
      const url =
        'https://raw.githubusercontent.com/facebook/stylex/1fcb9a51cbecad2c82255e0f4b45cc072fa1a95a/LICENSE';
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw Error('StyleX release notice unavailable');
      const text = await response.text();
      if (
        createHash('sha256').update(text).digest('hex') !==
        'da6d3703ed11cbe42bd212c725957c98da23cbff1998c05fa4b3d976d1a58e93'
      )
        throw Error('StyleX release notice checksum mismatch');
      texts = [url + '\n' + text];
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
  await writeFile(output, sections.join('\n\n========================================\n\n'));
  return [...packages.keys()].sort();
}
