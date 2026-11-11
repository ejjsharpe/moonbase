import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url)),
  repository = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * Bundles the daemon for the Bun runtime into `<outdir>/daemon.mjs`, with Claude Code's
 * tool-inventory helper `inert-mcp.mjs` beside it: the provider resolves the helper next to the
 * bundle that imported it and starts it with the running `bun`. A compiled executable would put
 * the helper in Bun's virtual filesystem, where that child can't load it. The bundle's inputs go
 * to `inputsPath`, outside `outdir`, for notices and package checks, relative to the repository
 * root so cached outputs name no checkout.
 *
 * The bundle's build identifier is the SHA-256 of the bundle built without one, and of the helper:
 * the daemon writes it to `endpoint.json`, and the app, which embeds it, replaces a running daemon
 * whose identifier differs. It is returned and written to `buildPath`.
 */
export async function buildDaemon(outdir, inputsPath, buildPath) {
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });
  const options = {
    absWorkingDir: root,
    entryPoints: ['src/main.ts'],
    outfile: join(outdir, 'daemon.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    banner: {
      js: "import { createRequire as moonbaseCreateRequire } from 'node:module'; const require = moonbaseCreateRequire(import.meta.url);",
    },
    logLevel: 'warning',
  };
  const require = createRequire(join(root, '../../packages/pi-runtime/package.json'));
  const helper = join(
    dirname(require.resolve('@earendil-works/pi-claude-code/package.json')),
    'src/inert-mcp.mjs',
  );
  const unidentified = await build({ ...options, write: false });
  const digest = createHash('sha256');
  for (const file of unidentified.outputFiles) digest.update(file.contents);
  const id = digest.update(await readFile(helper)).digest('hex');
  const result = await build({
    ...options,
    define: { MOONBASE_DAEMON_BUILD: JSON.stringify(id) },
    metafile: true,
  });
  await cp(helper, join(outdir, 'inert-mcp.mjs'));
  const inputs = Object.keys(result.metafile.inputs).map((path) =>
    relative(repository, resolve(root, path)),
  );
  await writeFile(inputsPath, JSON.stringify(inputs));
  if (buildPath) await writeFile(buildPath, JSON.stringify(id));
  return { inputs, build: id };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outdir = resolve(process.argv[2] ?? join(root, 'dist/daemon'));
  await buildDaemon(
    outdir,
    resolve(process.argv[3] ?? join(outdir, '../daemon-inputs.json')),
    resolve(process.argv[4] ?? join(outdir, '../daemon-build.json')),
  );
  console.log(join(outdir, 'daemon.mjs'));
}
