import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url)),
  require = createRequire(import.meta.url);
// The pinned builder's own archive API; no additional package/dependency or app runtime.
const asar = createRequire(require.resolve("electron-builder"))("@electron/asar");
const resources = join(root, "release/mac-arm64/Moonbase Chat Proof.app/Contents/Resources"),
  archive = join(resources, "app.asar");
const entries = asar.listPackage(archive);
assert(
  !entries.some((p) =>
    /node_modules|pi-durable|pi-ai|sqlite|source-snapshot|host\.json|client\.json/.test(p),
  ),
);
const paths = [
  "main.mjs",
  "preload.cjs",
  "renderer/index.html",
  "dependency-notices.txt",
  "notice-packages.json",
  ...(await readdir(join(root, "dist/renderer/assets"))).map((p) => "renderer/assets/" + p),
];
const files = [];
for (const path of paths) {
  const built = await readFile(join(root, "dist", path)),
    shipped = asar.extractFile(archive, path);
  assert(built.equals(shipped), "Package differs from the measured production build: " + path);
  files.push({
    path,
    bytes: built.length,
    sha256: createHash("sha256").update(built).digest("hex"),
  });
}
const notices = asar.extractFile(archive, "dependency-notices.txt").toString(),
  packages = JSON.parse(asar.extractFile(archive, "notice-packages.json").toString());
assert.equal(packages.length, 9);
for (const name of packages)
  assert(notices.includes(name), "Missing generated upstream notice: " + name);
for (const name of ["LICENSE.electron.txt", "LICENSES.chromium.html"]) {
  const bytes = await readFile(join(resources, name));
  assert(bytes.length > 100);
  files.push({
    path: name,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
const bytes = await readFile(archive);
files.push({
  path: "app.asar",
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
});
await mkdir(join(root, "test-results"), { recursive: true });
await writeFile(
  join(root, "test-results/artifacts.json"),
  JSON.stringify(
    {
      integrationBase: "132d273073889bd0702cf96b1fc2a62d5027598c",
      piRepair: "235eb27a448635a995bb65e67147e99119830b92",
      package: "unsigned macOS arm64 Electron45.1.0",
      noticePackages: packages,
      files,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Verified ${paths.length} packaged build files, ${packages.length} generated package notices and release Electron/Chromium notices.`,
);
