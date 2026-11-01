import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { rm, writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { notices } from "./notices.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
await rm(join(root, "dist"), { recursive: true, force: true });
const main = await build({
  absWorkingDir: root,
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  external: ["electron"],
  metafile: true,
  legalComments: "external",
});
const preload = await build({
  absWorkingDir: root,
  entryPoints: ["src/preload.ts"],
  outfile: "dist/preload.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
  metafile: true,
  legalComments: "external",
});
execFileSync("vp", ["build", "--config", join(root, "vite.config.ts")], {
  cwd: root,
  stdio: "inherit",
});
const renderer = JSON.parse(await readFile(join(root, "dist/renderer/module-inputs.json"), "utf8"));
const mainInputs = Object.keys(main.metafile.inputs);
for (const input of mainInputs)
  if (
    /pi-runtime\/src\/(?:index|engine|server|cli)|pi-durable|pi-ai|chord|sqlite|workspace|editor|source-snapshot/i.test(
      input,
    )
  )
    throw Error("Privileged client graph includes forbidden host/editor input: " + input);
for (const input of renderer)
  if (
    /(?:node:|\/effect\/|pi-runtime|\/ssh\/|electron|pi-durable|pi-ai|chord|sqlite|workspace|editor|source-snapshot|\/application\/src\/(?:services|handlers|runtime-client))/.test(
      input,
    )
  )
    throw Error("Renderer graph includes a privileged input: " + input);
await writeFile(
  join(root, "dist/inputs.json"),
  JSON.stringify(
    { main: mainInputs, preload: Object.keys(preload.metafile.inputs), renderer },
    null,
    2,
  ),
);
await writeFile(
  join(root, "dist/package.json"),
  JSON.stringify({
    name: "moonbase-chat-probe",
    version: "0.1.0",
    private: true,
    main: "main.mjs",
    description: "Moonbase standalone remote chat proof",
    author: "Elliot Sharpe",
  }),
);
console.log(
  `Graphs: main ${mainInputs.length}, renderer ${renderer.length}; no host engine/editor in client.`,
);

const require = createRequire(import.meta.url);
const noticePackages = await notices(
  [...mainInputs, ...Object.keys(preload.metafile.inputs)]
    .map((p) => resolve(root, p))
    .concat(renderer, require.resolve("electron/package.json")),
  join(root, "dist/dependency-notices.txt"),
);
await writeFile(join(root, "dist/notice-packages.json"), JSON.stringify(noticePackages, null, 2));
