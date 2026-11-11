import { build } from 'esbuild';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

/**
 * Bundles the daemon for the Bun runtime into `<outdir>/daemon.mjs`, with Claude Code's
 * tool-inventory helper `inert-mcp.mjs` beside it: the provider resolves the helper next to the
 * bundle that imported it and starts it with the running `bun`. A compiled executable would put
 * the helper in Bun's virtual filesystem, where that child can't load it. The bundle's inputs go
 * to `inputsPath`, outside `outdir`, for notices and package checks.
 */
export async function buildDaemon(outdir, inputsPath) {
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });
  const result = await build({
    absWorkingDir: root,
    entryPoints: ['src/main.ts'],
    outfile: join(outdir, 'daemon.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    banner: {
      js: "import { createRequire as moonbaseCreateRequire } from 'node:module'; const require = moonbaseCreateRequire(import.meta.url);",
    },
    metafile: true,
    logLevel: 'warning',
  });
  const require = createRequire(join(root, '../../packages/pi-runtime/package.json'));
  await cp(
    join(
      dirname(require.resolve('@earendil-works/pi-claude-code/package.json')),
      'src/inert-mcp.mjs',
    ),
    join(outdir, 'inert-mcp.mjs'),
  );
  // Inputs are relative to this app; record them absolute so any consumer can find them.
  const inputs = Object.keys(result.metafile.inputs).map((path) => resolve(root, path));
  await writeFile(inputsPath, JSON.stringify(inputs));
  return inputs;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outdir = resolve(process.argv[2] ?? join(root, 'dist/daemon'));
  await buildDaemon(outdir, resolve(process.argv[3] ?? join(outdir, '../daemon-inputs.json')));
  console.log(join(outdir, 'daemon.mjs'));
}
