import { build } from 'esbuild';
import { cp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));

/**
 * Bundles the standalone host into one self-contained file. Node cannot run the TypeScript the
 * Claude Code provider ships in node_modules, and the provider resolves its tool-inventory
 * helper beside the bundle.
 */
export async function buildHost(outdir = join(root, 'dist')): Promise<string> {
  const outfile = join(outdir, 'host.mjs');
  await build({
    absWorkingDir: root,
    entryPoints: ['src/host.ts'],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    banner: {
      js: "import { createRequire as moonbaseCreateRequire } from 'node:module'; const require = moonbaseCreateRequire(import.meta.url);",
    },
    logLevel: 'warning',
  });
  await cp(
    join(
      dirname(require.resolve('@earendil-works/pi-claude-code/package.json')),
      'src/inert-mcp.mjs',
    ),
    join(outdir, 'inert-mcp.mjs'),
  );
  return outfile;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  console.log(await buildHost(process.argv[2] && resolve(process.argv[2])));
