import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const macosTag = 'macos-tests';
const platformCheck = /\bprocess\.platform\b/;

/** The test sources under `directory` outside `test/macos/` and Playwright's `test/e2e/`. */
function findPortableTests(root, directory) {
  const found = [];
  const walk = (path) => {
    for (const item of readdirSync(join(root, path), { withFileTypes: true })) {
      const child = `${path}/${item.name}`;
      if (item.isDirectory()) {
        if (!/^(?:node_modules|macos|e2e)$/.test(item.name)) walk(child);
      } else if (/\.(?:[cm]?[jt]sx?)$/.test(item.name)) found.push(child);
    }
  };
  if (existsSync(join(root, directory))) walk(directory);
  return found;
}

/**
 * Checks how tests split between Linux and macOS CI, so none is skipped silently on Linux.
 *
 * CI runs `test` for untagged packages and `test:linux` on Linux, and `test:macos` on macOS. A
 * package with a `test/macos/` folder carries the `macos-tests` tag, `test:linux` (all but that
 * folder) and `test:macos` (only it). A tagged package without one runs wholly on macOS: its
 * `test:macos` is its full suite, and it has no `test:linux`. Tests outside `test/macos/` never
 * check `process.platform`, since on Linux that is a skip; such a test belongs in `test/macos/`.
 */
export function checkMacosTests(root) {
  const errors = [];
  for (const parent of ['packages', 'apps']) {
    for (const item of readdirSync(join(root, parent), { withFileTypes: true })) {
      const directory = `${parent}/${item.name}`;
      const manifestPath = join(root, directory, 'package.json');
      if (!item.isDirectory() || !existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const tagged = manifest.nx?.tags?.includes(macosTag) ?? false;
      const scripts = manifest.scripts ?? {};
      const split = existsSync(join(root, directory, 'test/macos'));
      if (split && !tagged) errors.push(`${directory} has test/macos/ but no "${macosTag}" tag`);
      if (tagged && !scripts['test:macos']) errors.push(`${directory} has no test:macos script`);
      if (split !== Boolean(scripts['test:linux']))
        errors.push(
          split
            ? `${directory} has test/macos/ but no test:linux script`
            : `${directory} has test:linux but no test/macos/ to leave out`,
        );
      if (!tagged && scripts['test:macos'])
        errors.push(`${directory} has test:macos but no "${macosTag}" tag`);
    }
  }
  const sources = [
    ...['packages', 'apps'].flatMap((parent) =>
      readdirSync(join(root, parent)).flatMap((name) =>
        findPortableTests(root, `${parent}/${name}/test`),
      ),
    ),
    ...findPortableTests(root, 'test'),
  ];
  for (const path of sources)
    if (platformCheck.test(readFileSync(join(root, path), 'utf8')))
      errors.push(`${path} checks process.platform; move a macOS-only test to test/macos/`);
  return errors;
}
