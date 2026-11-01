import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { build } from "esbuild";

const manifest = JSON.parse(await readFile("docs/source-snapshot/manifest.json", "utf8"));
assert.equal(manifest.referenceOnly, true);
assert.equal(manifest.files.length, 40);
for (const file of manifest.files) {
  assert(!file.path.startsWith("packages/") && !file.path.includes("/vendor/") && !file.path.endsWith("lookup-score.ts"));
  const data = await readFile(`docs/source-snapshot/escode/${file.path}`);
  assert.equal(createHash("sha256").update(data).digest("hex"), file.sha256, file.path);
  if (file.path.includes("/src/ui/")) {
    assert.deepEqual(await readFile(`packages/ui/${file.path.split("/").at(-1)}`), data);
  }
}
for (const entry of ["client", "host-client"]) {
  const path = `packages/application/src/${entry}.ts`;
  const result = await build({ entryPoints: [path], bundle: true, platform: "browser", write: false, metafile: true });
  assert.deepEqual(Object.keys(result.metafile.inputs), [path]);
  assert(!/node:|electron|@moonbase\/(workspace|pi-runtime|ssh)/.test(result.outputFiles[0].text));
}
console.log(`Verified ${manifest.files.length} source hashes, active UI copies and browser-only command contracts.`);
