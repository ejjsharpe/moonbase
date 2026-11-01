import { build } from "esbuild";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const result = await build({ absWorkingDir: root, entryPoints: ["src/index.ts"], bundle: true, write: false,
  outdir: "dist/renderer-check", platform: "browser", format: "esm", metafile: true,
  loader: { ".ttf": "file" }, logLevel: "silent" });
const inputs = Object.keys(result.metafile.inputs);
const prohibited = inputs.filter(path => /node_modules[/\\](?:electron|effect|@moonbase[/\\](?:workspace|pi-runtime|ssh))[/\\]|packages[/\\](?:workspace|pi-runtime|ssh)[/\\]|source-snapshot|(?:^|[/\\])host[/\\]|node:/.test(path));
assert.deepEqual(prohibited, [], "Privileged, Effect runtime or reference application code reached renderer entry");
assert(inputs.some(path => path.endsWith("application/src/client.ts")));
assert(inputs.some(path => path.includes("monaco-editor")));
console.log(`Renderer browser bundle checked: ${inputs.length} inputs, no privileged modules or feature runtime.`);
