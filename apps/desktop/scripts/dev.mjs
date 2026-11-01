import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
if (!process.env.MOONBASE_USER_DATA) throw Error("Set MOONBASE_USER_DATA to a fresh explicit absolute directory.");
const require = createRequire(import.meta.url);
await import("./build.mjs");
const child = spawn(require("electron"), [fileURLToPath(new URL("../dist/main.mjs", import.meta.url))], { stdio: "inherit", env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
child.on("exit", code => { process.exitCode = code ?? 1; });
