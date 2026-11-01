import { build } from "esbuild";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const result = await build({ absWorkingDir: root, entryPoints: ["src/renderer/main.tsx"], bundle: true, platform: "browser", write: false, outdir: "dist/import-check", metafile: true,
  loader: { ".ttf": "file" }, plugins: [{ name: "build-only-workers", setup(build) { build.onResolve({ filter: /\?worker$|^virtual:stylex:runtime$/ }, args => ({ path: args.path, namespace: "worker" })); build.onLoad({ filter: /.*/, namespace: "worker" }, () => ({ contents: "export default class Worker {}" })); } }], logLevel: "silent" });
const inputs = Object.keys(result.metafile.inputs);
assert.deepEqual(inputs.filter(p => /(?:^|\/)node_modules\/(?:electron|effect|@moonbase\/(?:workspace|pi-runtime|ssh))\/|packages\/(?:workspace|pi-runtime|ssh)\/|source-snapshot|node:/.test(p)), []);
assert(inputs.some(p => p.endsWith("application/src/client.ts")));
console.log(`Desktop renderer: ${inputs.length} browser inputs; no privileged/runtime/provider implementations.`);
